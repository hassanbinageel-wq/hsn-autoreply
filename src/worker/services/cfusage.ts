import type { Env } from "../env";
import { getSetting, OWNER_TENANT, setSetting } from "../lib/db";

/**
 * Exact usage from Cloudflare's GraphQL Analytics API (read-only token with "Account Analytics: Read", stored as the
 * Worker secret CF_ANALYTICS_TOKEN — never in the code or the database). Each dataset is queried on its own, so a
 * dataset that fails only leaves that figure on the estimate. Cached for 10 minutes.
 * Free-plan daily limits reset at 00:00 UTC.
 */
export interface CfUsage {
  at: number;
  requests_today?: number;
  d1_rows_read_today?: number;
  d1_rows_written_today?: number;
  d1_size_bytes?: number;
  r2_class_a_month?: number;
  r2_class_b_month?: number;
  r2_bytes?: number;
  r2_objects?: number;
  errors: string[];
}

const ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";
// R2 operation classes (deletes are free).
const CLASS_A = new Set(["ListBuckets", "PutBucket", "ListObjects", "PutObject", "CopyObject", "CompleteMultipartUpload", "CreateMultipartUpload", "UploadPart", "UploadPartCopy", "ListMultipartUploads", "ListParts", "PutBucketEncryption", "PutBucketCors", "PutBucketLifecycleConfiguration", "LifecycleStorageTierTransition"]);
const CLASS_B = new Set(["HeadBucket", "HeadObject", "GetObject", "UsageSummary", "GetBucketEncryption", "GetBucketLocation", "GetBucketCors", "GetBucketLifecycleConfiguration"]);

async function gql(f: typeof fetch, env: Env, query: string, variables: Record<string, unknown>): Promise<any> {
  const r = await f(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const j = (await r.json().catch(() => null)) as any;
  if (!r.ok || j?.errors?.length) throw new Error(String(j?.errors?.[0]?.message ?? `HTTP ${r.status}`).slice(0, 160));
  return j?.data?.viewer?.accounts?.[0] ?? {};
}

export async function cloudflareUsage(env: Env, now = Date.now(), force = false, f: typeof fetch = (i, init) => fetch(i, init)): Promise<CfUsage | null> {
  if (!env.CF_ANALYTICS_TOKEN || !env.CF_ACCOUNT_ID) return null;
  const cached = await getSetting<CfUsage | null>(env.DB, OWNER_TENANT, "cf_usage_cache", null);
  if (!force && cached && now - cached.at < 10 * 60_000) return cached;

  const day = new Date(now).toISOString().slice(0, 10);
  const dayStart = `${day}T00:00:00Z`;
  const monthStart = `${day.slice(0, 7)}-01T00:00:00Z`;
  const nowIso = new Date(now).toISOString();
  const acct = env.CF_ACCOUNT_ID;
  const out: CfUsage = { at: now, errors: [] };
  const run = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      out.errors.push(`${name}: ${(e as Error).message}`);
    }
  };
  await Promise.all([
    run("workers", async () => {
      const a = await gql(f, env, `query($a: string!, $s: Time!, $e: Time!) { viewer { accounts(filter: { accountTag: $a }) {
        workersInvocationsAdaptive(limit: 10000, filter: { datetime_geq: $s, datetime_lt: $e }) { sum { requests } } } } }`, { a: acct, s: dayStart, e: nowIso });
      out.requests_today = (a.workersInvocationsAdaptive ?? []).reduce((n: number, x: any) => n + (x.sum?.requests ?? 0), 0);
    }),
    run("d1", async () => {
      const a = await gql(f, env, `query($a: string!, $d: Date!) { viewer { accounts(filter: { accountTag: $a }) {
        d1AnalyticsAdaptiveGroups(limit: 10000, filter: { date_geq: $d, date_leq: $d }) { sum { rowsRead rowsWritten } } } } }`, { a: acct, d: day });
      const g = a.d1AnalyticsAdaptiveGroups ?? [];
      out.d1_rows_read_today = g.reduce((n: number, x: any) => n + (x.sum?.rowsRead ?? 0), 0);
      out.d1_rows_written_today = g.reduce((n: number, x: any) => n + (x.sum?.rowsWritten ?? 0), 0);
    }),
    run("d1_storage", async () => {
      const a = await gql(f, env, `query($a: string!, $d: Date!) { viewer { accounts(filter: { accountTag: $a }) {
        d1StorageAdaptiveGroups(limit: 100, filter: { date_geq: $d, date_leq: $d }) { max { databaseSizeBytes } } } } }`, { a: acct, d: day });
      const g = a.d1StorageAdaptiveGroups ?? [];
      if (g.length) out.d1_size_bytes = Math.max(...g.map((x: any) => x.max?.databaseSizeBytes ?? 0));
    }),
    run("r2_ops", async () => {
      const a = await gql(f, env, `query($a: string!, $s: Time!, $e: Time!) { viewer { accounts(filter: { accountTag: $a }) {
        r2OperationsAdaptiveGroups(limit: 10000, filter: { datetime_geq: $s, datetime_lt: $e }) { sum { requests } dimensions { actionType } } } } }`, { a: acct, s: monthStart, e: nowIso });
      let ca = 0;
      let cb = 0;
      for (const x of a.r2OperationsAdaptiveGroups ?? []) {
        const t = x.dimensions?.actionType ?? "";
        if (CLASS_A.has(t)) ca += x.sum?.requests ?? 0;
        else if (CLASS_B.has(t)) cb += x.sum?.requests ?? 0;
      }
      out.r2_class_a_month = ca;
      out.r2_class_b_month = cb;
    }),
    run("r2_storage", async () => {
      const a = await gql(f, env, `query($a: string!, $s: Time!, $e: Time!) { viewer { accounts(filter: { accountTag: $a }) {
        r2StorageAdaptiveGroups(limit: 100, filter: { datetime_geq: $s, datetime_lt: $e }, orderBy: [datetime_DESC]) { max { payloadSize metadataSize objectCount } } } } }`, { a: acct, s: new Date(now - 2 * 86_400_000).toISOString(), e: nowIso });
      const g = a.r2StorageAdaptiveGroups?.[0];
      if (g) {
        out.r2_bytes = (g.max?.payloadSize ?? 0) + (g.max?.metadataSize ?? 0);
        out.r2_objects = g.max?.objectCount ?? 0;
      }
    }),
  ]);
  await setSetting(env.DB, OWNER_TENANT, "cf_usage_cache", out, now);
  return out;
}
