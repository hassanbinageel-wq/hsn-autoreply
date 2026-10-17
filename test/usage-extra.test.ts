import { beforeEach, describe, expect, it } from "vitest";
import { DB, resetDb, TEST_ENV } from "./helpers";
import { parseRdap } from "../src/worker/services/domain";
import { cloudflareUsage } from "../src/worker/services/cfusage";
import { platformUsage } from "../src/worker/services/usage";

beforeEach(resetDb);

describe("usage: domain and exact Cloudflare figures", () => {
  it("reads registration / expiry / registrar from an RDAP record", () => {
    const d = parseRdap("hsnreply.online", {
      events: [{ eventAction: "registration", eventDate: "2026-09-20T10:00:00Z" }, { eventAction: "expiration", eventDate: "2027-09-20T10:00:00Z" }],
      entities: [{ roles: ["registrar"], vcardArray: ["vcard", [["version", {}, "text", "4.0"], ["fn", {}, "text", "Cloudflare, Inc."]]] }],
    });
    expect(d).toMatchObject({ registered_at: Date.parse("2026-09-20T10:00:00Z"), expires_at: Date.parse("2027-09-20T10:00:00Z"), registrar: "Cloudflare, Inc." });
    expect(parseRdap("x.online", {}).expires_at).toBeNull();
  });

  it("uses Cloudflare's numbers when the token is set, and keeps estimates for a dataset that fails", async () => {
    const env = { ...TEST_ENV, CF_ANALYTICS_TOKEN: "t", CF_ACCOUNT_ID: "a".repeat(32) };
    const fake = (async (_u: string, init: RequestInit) => {
      const q = JSON.parse(String(init.body)).query as string;
      const acc = (x: unknown) => new Response(JSON.stringify({ data: { viewer: { accounts: [x] } } }));
      if (q.includes("workersInvocationsAdaptive")) return acc({ workersInvocationsAdaptive: [{ sum: { requests: 1200 } }, { sum: { requests: 300 } }] });
      if (q.includes("d1AnalyticsAdaptiveGroups")) return acc({ d1AnalyticsAdaptiveGroups: [{ sum: { rowsRead: 250000, rowsWritten: 4000 } }] });
      if (q.includes("d1StorageAdaptiveGroups")) return acc({ d1StorageAdaptiveGroups: [{ max: { databaseSizeBytes: 12_000_000 } }] });
      if (q.includes("r2OperationsAdaptiveGroups"))
        return acc({ r2OperationsAdaptiveGroups: [{ sum: { requests: 7 }, dimensions: { actionType: "PutObject" } }, { sum: { requests: 20 }, dimensions: { actionType: "GetObject" } }, { sum: { requests: 5 }, dimensions: { actionType: "DeleteObject" } }] });
      return new Response(JSON.stringify({ errors: [{ message: "unknown field" }] }));
    }) as unknown as typeof fetch;
    const cf = await cloudflareUsage(env, Date.now(), true, fake);
    expect(cf).toMatchObject({ requests_today: 1500, d1_rows_read_today: 250000, d1_rows_written_today: 4000, d1_size_bytes: 12_000_000, r2_class_a_month: 7, r2_class_b_month: 20 });
    expect(cf!.errors.length).toBe(1); // r2 storage failed
    const u = await platformUsage(DB, true, Date.now(), cf);
    const by = Object.fromEntries(u.meters.map((m) => [m.key, m]));
    expect(by.requests).toMatchObject({ used: 1500, estimate: false });
    expect(by.reads).toMatchObject({ used: 250000, limit: 5_000_000, pct: 5 });
    expect(by.writes.estimate).toBe(false);
    expect(by.r2_size.estimate).toBe(false); // from the system's own records
    // cached for 10 minutes: no second call
    let calls = 0;
    await cloudflareUsage(env, Date.now(), false, (async () => (calls++, new Response("{}"))) as unknown as typeof fetch);
    expect(calls).toBe(0);
    // without a token: no Cloudflare figures at all
    expect(await cloudflareUsage(TEST_ENV)).toBeNull();
  });
});
