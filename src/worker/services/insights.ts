import type { Env } from "../env";
import type { AccountRow } from "../engine/context";
import { all, first, getSetting, OWNER_TENANT, run, setSetting } from "../lib/db";
import { INSIGHTS_SCOPE, type HttpMetaClient, type InsightsResponse } from "../meta/client";
import type { MetaError, MetaResult } from "../meta/types";
import { cacheMediaStmt } from "./media";
import { getAccessToken, metaClient } from "./account";
import { tzOffsetMinutes, type AnalyticsFilter } from "./analytics";

/**
 * Instagram's own metrics through the official Insights API (permission instagram_business_manage_insights).
 *
 * What Meta documents and this module follows:
 *  - media metrics are lifetime totals, can lag up to 48h, and an unavailable metric comes back as an empty list —
 *    stored as NULL ("unavailable"), never as 0;
 *  - story metrics exist only while the story is live (24h), so live stories are read every hour and the last read
 *    is what remains;
 *  - follower demographics need at least 100 followers and only list the top groups;
 *  - reach is people, not events: it is never summed across posts.
 *
 * The permission is opt-in: the owner decides who is asked for it at connect time ("insights_scope" setting:
 * off | owner | all). Accounts without it are skipped entirely.
 */

export type InsightsClient = Pick<HttpMetaClient, "mediaInsights" | "accountInsights" | "listStories" | "listMedia">;
export type ContentType = "POST" | "CAROUSEL" | "REELS" | "STORY";
export type ScopeMode = "off" | "owner" | "all";

const DAY = 86_400_000;
const ACC = "(SELECT id FROM instagram_accounts WHERE tenant_id = ?)";
/** External requests one customer's hourly run may use (Workers Free: 50 per invocation, shared with the queue). */
export const INSIGHTS_PER_RUN = 12;

const FEED_METRICS = ["views", "reach", "likes", "comments", "shares", "saved", "total_interactions"] as const;
const FEED_FALLBACK = ["reach", "likes", "comments", "saved"] as const;
const STORY_METRICS = ["views", "reach", "replies", "shares", "total_interactions"] as const;
const STORY_FALLBACK = ["reach", "replies"] as const;
const COLUMNS = ["views", "reach", "likes", "comments", "shares", "saved", "replies", "total_interactions"] as const;

export function hasInsightsScope(scopes: string | null | undefined): boolean {
  try {
    const list = JSON.parse(scopes || "[]");
    return Array.isArray(list) && list.includes(INSIGHTS_SCOPE);
  } catch {
    return false;
  }
}

export async function insightsScopeMode(db: D1Database): Promise<ScopeMode> {
  const m = await getSetting<string>(db, OWNER_TENANT, "insights_scope", "off");
  return m === "owner" || m === "all" ? m : "off";
}

/** Whether connecting an account for this customer should ask Instagram for the insights permission. */
export async function wantsInsightsScope(db: D1Database, tenantId: number): Promise<boolean> {
  const mode = await insightsScopeMode(db);
  return mode === "all" || (mode === "owner" && tenantId === OWNER_TENANT);
}

export function contentType(kind: string, mediaType?: string | null, productType?: string | null): ContentType {
  if (kind === "story") return "STORY";
  if (productType === "REELS") return "REELS";
  if (mediaType === "CAROUSEL_ALBUM") return "CAROUSEL";
  return "POST";
}

/** Reads `name → value` from an insights response; metrics Meta left out are simply absent. */
export function parseMetrics(r: InsightsResponse): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of r.data ?? []) {
    const v = d.total_value?.value ?? d.values?.[0]?.value;
    if (typeof v === "number" && Number.isFinite(v)) out[d.name] = v;
  }
  return out;
}

/** `dimension → value` of the first breakdown in an account-insights response. */
export function parseBreakdown(r: InsightsResponse): { total: number | null; dims: Record<string, number> } {
  const d = r.data?.[0];
  const dims: Record<string, number> = {};
  for (const x of d?.total_value?.breakdowns?.[0]?.results ?? []) {
    const k = x.dimension_values?.[0];
    if (k && typeof x.value === "number") dims[k] = x.value;
  }
  const total = typeof d?.total_value?.value === "number" ? d.total_value.value : null;
  return { total, dims };
}

/** Local calendar day (YYYY-MM-DD) of a time in the customer's time zone. */
export function localDay(ms: number, offMin: number): string {
  return new Date(ms + offMin * 60_000).toISOString().slice(0, 10);
}
function localMidnight(ms: number, offMin: number): number {
  const off = offMin * 60_000;
  return Math.floor((ms + off) / DAY) * DAY - off;
}

/** An invalid-metric error (Graph code 100): retried once with the smaller metric set. */
const isInvalidMetric = (e: MetaError) => e.code === 100 || /metric/i.test(e.message);

interface Budget {
  left: number;
}
export interface CaptureSummary {
  stories: number;
  media: number;
  account: boolean;
  stopped?: "auth" | "permission" | "rate_limited" | "budget";
  error?: string;
}

/**
 * One customer's insights pass: live stories, due posts, and (once a day) account values. Spends at most
 * `budget.left` requests and stops on auth / permission / rate-limit errors.
 */
export async function captureInsights(
  db: D1Database,
  client: InsightsClient,
  account: AccountRow,
  token: string,
  tenantId: number,
  budget: Budget,
  now = Date.now(),
): Promise<CaptureSummary> {
  const sum: CaptureSummary = { stories: 0, media: 0, account: false };
  const tz = await getSetting<string>(db, tenantId, "timezone", "Asia/Riyadh");
  const off = tzOffsetMinutes(tz, now);

  const call = async <T>(fn: () => Promise<MetaResult<T>>): Promise<MetaResult<T> | null> => {
    if (budget.left <= 0) {
      sum.stopped ??= "budget";
      return null;
    }
    budget.left--;
    const r = await fn();
    if (!r.ok && (r.error.kind === "auth" || r.error.kind === "permission" || r.error.kind === "rate_limited")) {
      sum.stopped = r.error.kind;
      sum.error = r.error.message;
    }
    return r;
  };
  const halted = () => sum.stopped !== undefined && sum.stopped !== "budget";

  const snapshot = async (mediaId: string, type: ContentType): Promise<void> => {
    const story = type === "STORY";
    let r = await call(() => client.mediaInsights(token, mediaId, story ? STORY_METRICS : FEED_METRICS));
    if (r && !r.ok && !halted() && isInvalidMetric(r.error)) r = await call(() => client.mediaInsights(token, mediaId, story ? STORY_FALLBACK : FEED_FALLBACK));
    if (!r) return;
    const values = r.ok ? parseMetrics(r.data) : {};
    const status = !r.ok ? (r.error.kind === "permission" ? "permission" : "error") : Object.keys(values).length ? "ok" : "empty";
    await run(
      db,
      `INSERT INTO media_insights (account_id, media_id, content_type, captured_at, status, ${COLUMNS.join(", ")}, error)
       VALUES (?, ?, ?, ?, ?, ${COLUMNS.map(() => "?").join(", ")}, ?)`,
      account.id,
      mediaId,
      type,
      now,
      status,
      ...COLUMNS.map((k) => values[k] ?? null),
      r.ok ? null : r.error.message.slice(0, 300),
    );
  };

  // 1) Live stories — read every run while they exist (their insights disappear after 24h).
  const stories = await call(() => client.listStories(token));
  if (stories?.ok) {
    const items = stories.data.data ?? [];
    if (items.length) await db.batch(items.map((m) => cacheMediaStmt(db, account.id, m, "story", now)));
    const recent = await all<{ media_id: string }>(
      db,
      `SELECT m.media_id FROM media_cache m WHERE m.account_id = ? AND m.kind = 'story' AND m.expires_at > ?
         AND NOT EXISTS (SELECT 1 FROM media_insights i WHERE i.account_id = m.account_id AND i.media_id = m.media_id AND i.captured_at > ?)
       ORDER BY m.posted_at LIMIT 3`,
      account.id,
      now,
      now - 50 * 60_000,
    );
    for (const s of recent) {
      if (halted()) break;
      await snapshot(s.media_id, "STORY");
      sum.stories++;
    }
  }
  if (halted()) return finish();

  // 2) Posts and reels: refresh the list twice a day, then read the ones that are due (newer posts more often).
  const fresh = await first<{ at: number | null }>(db, "SELECT MAX(fetched_at) AS at FROM media_cache WHERE account_id = ? AND kind = 'media'", account.id);
  if (!fresh?.at || fresh.at < now - 12 * 3_600_000) {
    const list = await call(() => client.listMedia(token));
    if (list?.ok && list.data.data?.length) await db.batch(list.data.data.map((m) => cacheMediaStmt(db, account.id, m, "media", now)));
  }
  if (halted()) return finish();
  const due = await all<{ media_id: string; media_type: string | null; media_product_type: string | null }>(
    db,
    `SELECT m.media_id, m.media_type, m.media_product_type, (SELECT MAX(i.captured_at) FROM media_insights i WHERE i.account_id = m.account_id AND i.media_id = m.media_id) AS last
       FROM media_cache m
      WHERE m.account_id = ? AND m.kind = 'media' AND m.posted_at > ?
        AND COALESCE((SELECT MAX(i.captured_at) FROM media_insights i WHERE i.account_id = m.account_id AND i.media_id = m.media_id), 0)
            < ? - CASE WHEN m.posted_at > ? THEN 3 * 3600000 WHEN m.posted_at > ? THEN 12 * 3600000 ELSE 72 * 3600000 END
      ORDER BY last IS NOT NULL, last, m.posted_at DESC LIMIT 5`,
    account.id,
    now - 90 * DAY,
    now,
    now - 2 * DAY,
    now - 14 * DAY,
  );
  for (const m of due) {
    if (halted() || budget.left <= 2) break;
    await snapshot(m.media_id, contentType("media", m.media_type, m.media_product_type));
    sum.media++;
  }
  if (halted()) return finish();

  // 3) Account values once per local day: yesterday's reach (followers vs non-followers), daily new followers,
  //    and every 7 days the follower demographics.
  const today = localDay(now, off);
  if ((await getSetting<string>(db, tenantId, "insights_account_day", "")) !== today && budget.left >= 2) {
    const until = localMidnight(now, off);
    const since = until - DAY;
    const yesterday = localDay(since, off);
    const reach = await call(() =>
      client.accountInsights(token, { metric: "reach", period: "day", metric_type: "total_value", breakdown: "follow_type", since: String(since / 1000), until: String(until / 1000) }),
    );
    if (reach?.ok) {
      const b = parseBreakdown(reach.data);
      const rows: Array<[string, number]> = Object.entries(b.dims);
      if (b.total !== null) rows.push(["", b.total]);
      await putAccountRows(db, account.id, yesterday, "reach", "follow_type", rows, now);
    }
    if (!halted()) {
      const fc = await call(() =>
        client.accountInsights(token, { metric: "follower_count", period: "day", since: String((until - 30 * DAY) / 1000), until: String(until / 1000) }),
      );
      if (fc?.ok) {
        const series = fc.data.data?.[0]?.values ?? [];
        const stmts = series
          .filter((v) => typeof v.value === "number" && v.end_time)
          .map((v) => accountRowStmt(db, account.id, localDay(Date.parse(v.end_time!) - DAY, off), "follower_count", "", "", v.value!, now));
        if (stmts.length) await db.batch(stmts);
      }
    }
    const lastDemo = await getSetting<string>(db, tenantId, "insights_demographics_day", "");
    if (!halted() && (!lastDemo || Date.parse(today) - Date.parse(lastDemo) >= 7 * DAY)) {
      for (const breakdown of ["age", "gender", "country"]) {
        if (halted() || budget.left <= 0) break;
        const r = await call(() =>
          client.accountInsights(token, { metric: "follower_demographics", period: "lifetime", metric_type: "total_value", timeframe: "this_month", breakdown }),
        );
        if (r?.ok) await putAccountRows(db, account.id, today, "follower_demographics", breakdown, Object.entries(parseBreakdown(r.data).dims), now);
      }
      if (!halted()) await setSetting(db, tenantId, "insights_demographics_day", today, now);
    }
    if (!halted()) {
      await setSetting(db, tenantId, "insights_account_day", today, now);
      sum.account = true;
    }
  }
  return finish();

  async function finish(): Promise<CaptureSummary> {
    await setSetting(
      db,
      tenantId,
      "insights_status",
      { at: now, ok: !halted(), reason: halted() ? sum.stopped : null, message: sum.error ?? null },
      now,
    );
    return sum;
  }
}

function accountRowStmt(db: D1Database, accountId: number, day: string, metric: string, breakdown: string, dim: string, value: number, now: number) {
  return db
    .prepare(
      `INSERT INTO account_insights (account_id, day, metric, breakdown, dim, value, captured_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id, day, metric, breakdown, dim) DO UPDATE SET value = excluded.value, captured_at = excluded.captured_at`,
    )
    .bind(accountId, day, metric, breakdown, dim, Math.round(value), now);
}
async function putAccountRows(db: D1Database, accountId: number, day: string, metric: string, breakdown: string, rows: Array<[string, number]>, now: number) {
  // A new reading replaces the whole set for that day (a group that dropped out of the top list must not linger).
  await db.batch([
    db.prepare("DELETE FROM account_insights WHERE account_id = ? AND day = ? AND metric = ? AND breakdown = ?").bind(accountId, day, metric, breakdown),
    ...rows.map(([dim, v]) => accountRowStmt(db, accountId, day, metric, breakdown, dim, v, now)),
  ]);
}

/** The customer's account that may be read (active, real, insights permission granted). */
export async function insightsAccount(db: D1Database, tenantId: number): Promise<AccountRow | null> {
  const a = await first<AccountRow & { scopes: string | null }>(
    db,
    "SELECT * FROM instagram_accounts WHERE tenant_id = ? AND is_demo = 0 AND status = 'active' ORDER BY id LIMIT 1",
    tenantId,
  );
  return a && hasInsightsScope(a.scopes) ? a : null;
}

/** Hourly, one minute per customer (`(id + 47) % 60`). */
export async function runInsights(env: Env, minute: number, onRequest?: () => void): Promise<number> {
  const tenants = await all<{ id: number }>(
    env.DB,
    `SELECT t.id FROM tenants t WHERE t.status = 'active' AND (t.id + 47) % 60 = ?
       AND EXISTS (SELECT 1 FROM instagram_accounts a WHERE a.tenant_id = t.id AND a.is_demo = 0 AND a.status = 'active' AND a.scopes LIKE ?)
     ORDER BY t.id LIMIT 2`,
    minute,
    `%${INSIGHTS_SCOPE}%`,
  );
  const client = metaClient(env, onRequest);
  let n = 0;
  for (const t of tenants) {
    const account = await insightsAccount(env.DB, t.id);
    if (!account) continue;
    const token = await getAccessToken(env, env.DB, account);
    if (!token) continue;
    await captureInsights(env.DB, client, account, token, t.id, { left: INSIGHTS_PER_RUN });
    n++;
  }
  return n;
}

// ---- reading for the dashboard ---------------------------------------------------------------------------------

type Snap = { media_id: string; content_type: string | null; captured_at: number; status: string } & Record<(typeof COLUMNS)[number], number | null>;

/**
 * Instagram metrics for the dashboard. Post values are each post's latest (lifetime) snapshot, for posts published
 * inside the period; sums are given only for additive counts (views, likes, comments, shares, saves). Reach is per
 * post, plus the account's daily follower / non-follower split.
 */
export async function insightsSummary(db: D1Database, t: number, f: AnalyticsFilter) {
  const acc = await first<{ id: number; scopes: string | null; status: string }>(
    db,
    "SELECT id, scopes, status FROM instagram_accounts WHERE tenant_id = ? AND is_demo = 0 ORDER BY (status = 'active') DESC, id LIMIT 1",
    t,
  );
  const status = await getSetting<{ at: number; ok: boolean; reason: string | null; message: string | null } | null>(db, t, "insights_status", null);
  const granted = !!acc && hasInsightsScope(acc.scopes);
  const base = { granted, connected: !!acc && acc.status === "active", status, requested: await wantsInsightsScope(db, t) };
  if (!granted) return { ...base, posts: [], totals: null, unread: null, follow_reach: null, new_followers: null, demographics: null };

  const args: unknown[] = [t, f.from, f.to];
  let extra = "";
  if (f.mediaId) {
    extra += " AND m.media_id = ?";
    args.push(f.mediaId);
  }
  if (f.campaignId) {
    extra += " AND m.media_id IN (SELECT cm.media_id FROM campaign_media cm JOIN campaigns c ON c.id = cm.campaign_id WHERE c.id = ? AND c.tenant_id = ?)";
    args.push(f.campaignId, t);
  }
  if (f.type) extra += f.type === "comment" ? " AND m.kind = 'media'" : " AND m.kind = 'story'";
  const posts = await all<Snap & { caption: string | null; permalink: string | null; thumbnail_url: string | null; posted_at: number | null; kind: string; media_type: string | null; media_product_type: string | null }>(
    db,
    `SELECT m.media_id, m.caption, m.permalink, m.thumbnail_url, m.posted_at, m.kind, m.media_type, m.media_product_type,
            s.content_type, s.captured_at, s.status, ${COLUMNS.map((k) => `s.${k}`).join(", ")}
       FROM media_cache m
       JOIN (SELECT i.*, ROW_NUMBER() OVER (PARTITION BY i.account_id, i.media_id ORDER BY (i.status = 'ok') DESC, i.captured_at DESC) AS rn
               FROM media_insights i WHERE i.account_id IN ${ACC}) s ON s.account_id = m.account_id AND s.media_id = m.media_id AND s.rn = 1
      WHERE m.account_id IN ${ACC} AND m.posted_at >= ? AND m.posted_at < ?${extra}
      ORDER BY m.posted_at DESC LIMIT 200`,
    t,
    ...args,
  );
  // Posts of the period that have no reading yet: newer than 90 days are queued (5 per hour), older are not read.
  const unread = await first<{ queued: number; old: number }>(
    db,
    `SELECT COALESCE(SUM(m.posted_at > ?), 0) AS queued, COALESCE(SUM(m.posted_at <= ?), 0) AS old FROM media_cache m
      WHERE m.account_id IN ${ACC} AND m.kind = 'media' AND m.posted_at >= ? AND m.posted_at < ?${extra}
        AND NOT EXISTS (SELECT 1 FROM media_insights i WHERE i.account_id = m.account_id AND i.media_id = m.media_id)`,
    Date.now() - 90 * DAY,
    Date.now() - 90 * DAY,
    ...args,
  );
  const additive = ["views", "likes", "comments", "shares", "saved"] as const;
  const totals: Record<string, { sum: number; posts: number }> = {};
  for (const k of additive) {
    const have = posts.filter((p) => typeof p[k] === "number");
    totals[k] = { sum: have.reduce((a, p) => a + (p[k] as number), 0), posts: have.length };
  }

  const fromDay = localDay(f.from, f.tzOffsetMin);
  const toDay = localDay(f.to - 1, f.tzOffsetMin);
  const reachRows = await all<{ dim: string; value: number; days: number }>(
    db,
    `SELECT dim, SUM(value) AS value, COUNT(*) AS days FROM account_insights
      WHERE account_id IN ${ACC} AND metric = 'reach' AND breakdown = 'follow_type' AND day >= ? AND day <= ? GROUP BY dim`,
    t,
    fromDay,
    toDay,
  );
  const followers = reachRows.find((r) => r.dim === "FOLLOWER");
  const non = reachRows.find((r) => r.dim === "NON_FOLLOWER");
  const nf = await first<{ value: number | null; days: number }>(
    db,
    `SELECT SUM(value) AS value, COUNT(*) AS days FROM account_insights WHERE account_id IN ${ACC} AND metric = 'follower_count' AND day >= ? AND day <= ?`,
    t,
    fromDay,
    toDay,
  );
  const demo = await all<{ breakdown: string; dim: string; value: number; day: string }>(
    db,
    `SELECT a.breakdown, a.dim, a.value, a.day FROM account_insights a
      WHERE a.account_id IN ${ACC} AND a.metric = 'follower_demographics'
        AND a.day = (SELECT MAX(b.day) FROM account_insights b WHERE b.account_id = a.account_id AND b.metric = 'follower_demographics' AND b.breakdown = a.breakdown)
      ORDER BY a.breakdown, a.value DESC`,
    t,
  );
  const demographics: Record<string, { day: string; items: Array<{ dim: string; value: number }> }> = {};
  for (const r of demo) (demographics[r.breakdown] ??= { day: r.day, items: [] }).items.push({ dim: r.dim, value: r.value });

  return {
    ...base,
    posts: posts.map((p) => ({
      media_id: p.media_id,
      caption: p.caption,
      permalink: p.permalink,
      thumbnail_url: p.thumbnail_url,
      posted_at: p.posted_at,
      content_type: p.content_type ?? contentType(p.kind, p.media_type, p.media_product_type),
      captured_at: p.captured_at,
      status: p.status,
      ...Object.fromEntries(COLUMNS.map((k) => [k, p[k]])),
    })),
    totals: { ...totals, posts: posts.length },
    unread: { queued: unread?.queued ?? 0, too_old: unread?.old ?? 0 },
    follow_reach: followers || non ? { follower: followers?.value ?? 0, non_follower: non?.value ?? 0, days: Math.max(followers?.days ?? 0, non?.days ?? 0) } : null,
    new_followers: nf?.days ? { value: nf.value ?? 0, days: nf.days } : null,
    demographics: Object.keys(demographics).length ? demographics : null,
  };
}

/** Every stored reading of one post (its lifetime values over time), scoped to the customer. */
export async function mediaInsightsSeries(db: D1Database, t: number, mediaId: string) {
  return all<Snap>(
    db,
    `SELECT media_id, content_type, captured_at, status, ${COLUMNS.join(", ")} FROM media_insights
      WHERE account_id IN ${ACC} AND media_id = ? ORDER BY captured_at LIMIT 500`,
    t,
    mediaId,
  );
}
