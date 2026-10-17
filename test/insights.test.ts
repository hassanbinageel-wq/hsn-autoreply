import { beforeEach, describe, expect, it } from "vitest";
import { DB, resetDb, seedAccount } from "./helpers";
import { captureInsights, insightsSummary, mediaInsightsSeries, runInsights, wantsInsightsScope, type InsightsClient } from "../src/worker/services/insights";
import { HttpMetaClient, INSIGHTS_SCOPE, INSTAGRAM_SCOPES, type InsightsResponse } from "../src/worker/meta/client";
import { setSetting } from "../src/worker/lib/db";
import type { MetaResult } from "../src/worker/meta/types";
import { TEST_ENV } from "./helpers";

const DAY = 86_400_000;
const NOW = Date.now();
const ok = <T>(data: T): MetaResult<T> => ({ ok: true, httpStatus: 200, data });

/** Scriptable insights client; records every request. No network. */
class FakeInsights implements InsightsClient {
  calls: string[] = [];
  media: Record<string, InsightsResponse | "invalid_metric" | "permission"> = {};
  stories: Array<{ id: string; timestamp: string; media_type?: string }> = [];
  posts: Array<{ id: string; timestamp: string; media_type?: string; media_product_type?: string; caption?: string }> = [];
  async listStories() {
    this.calls.push("stories");
    return ok({ data: this.stories });
  }
  async listMedia() {
    this.calls.push("media");
    return ok({ data: this.posts });
  }
  async mediaInsights(_t: string, id: string, metrics: readonly string[]): Promise<MetaResult<InsightsResponse>> {
    this.calls.push(`insights:${id}:${metrics.join(",")}`);
    const r = this.media[id];
    if (r === "permission") return { ok: false, error: { kind: "permission", code: 10, message: "Application does not have permission" } };
    if (r === "invalid_metric" && metrics.includes("views")) return { ok: false, error: { kind: "permanent", code: 100, message: "metric views is not supported" } };
    if (r === "invalid_metric") return ok({ data: [{ name: "reach", values: [{ value: 40 }] }] });
    return ok(r ?? { data: [] });
  }
  async accountInsights(_t: string, q: Record<string, string>): Promise<MetaResult<InsightsResponse>> {
    this.calls.push(`account:${q.metric}:${q.breakdown ?? ""}`);
    if (q.metric === "reach")
      return ok({ data: [{ name: "reach", total_value: { value: 120, breakdowns: [{ results: [{ dimension_values: ["FOLLOWER"], value: 70 }, { dimension_values: ["NON_FOLLOWER"], value: 55 }] }] } }] });
    if (q.metric === "follower_count") return ok({ data: [{ name: "follower_count", values: [{ value: 4, end_time: new Date(NOW - DAY).toISOString() }] }] });
    const dims: Record<string, Array<[string, number]>> = { age: [["18-24", 30], ["25-34", 50]], gender: [["F", 60], ["M", 40]], country: [["SA", 80], ["YE", 12]] };
    return ok({ data: [{ name: "follower_demographics", total_value: { breakdowns: [{ results: (dims[q.breakdown] ?? []).map(([d, v]) => ({ dimension_values: [d], value: v })) }] } }] });
  }
}

const metric = (o: Record<string, number>): InsightsResponse => ({ data: Object.entries(o).map(([name, value]) => ({ name, values: [{ value }] })) });

async function account(scoped = true) {
  const id = await seedAccount();
  if (scoped) await DB.prepare("UPDATE instagram_accounts SET scopes = ? WHERE id = ?").bind(JSON.stringify([...INSTAGRAM_SCOPES, INSIGHTS_SCOPE]), id).run();
  return (await DB.prepare("SELECT * FROM instagram_accounts WHERE id = ?").bind(id).first<any>())!;
}
const F = { from: NOW - 7 * DAY, to: NOW + 60_000, tzOffsetMin: 180 };

beforeEach(async () => {
  await resetDb();
});

describe("instagram insights", () => {
  it("stores lifetime snapshots; a metric Meta left out is unavailable (NULL), not 0; reach is never summed", async () => {
    const acc = await account();
    const meta = new FakeInsights();
    meta.posts = [
      { id: "p1", timestamp: new Date(NOW - DAY).toISOString(), media_type: "IMAGE" },
      { id: "p2", timestamp: new Date(NOW - 2 * DAY).toISOString(), media_type: "VIDEO", media_product_type: "REELS" },
      { id: "p3", timestamp: new Date(NOW - 3 * DAY).toISOString(), media_type: "CAROUSEL_ALBUM" },
    ];
    meta.media = { p1: metric({ views: 100, reach: 80, likes: 10, comments: 2, saved: 1 }), p2: metric({ views: 300, reach: 200, likes: 30, shares: 5 }), p3: { data: [] } };
    const s = await captureInsights(DB, meta, acc, "tok", 1, { left: 20 }, NOW);
    expect(s.media).toBe(3);
    const p1 = await DB.prepare("SELECT * FROM media_insights WHERE media_id = 'p1'").first<any>();
    expect(p1).toMatchObject({ status: "ok", views: 100, reach: 80, shares: null, content_type: "POST" });
    const p3 = await DB.prepare("SELECT * FROM media_insights WHERE media_id = 'p3'").first<any>();
    expect(p3).toMatchObject({ status: "empty", views: null, content_type: "CAROUSEL" });

    const sum = await insightsSummary(DB, 1, F);
    expect(sum.granted).toBe(true);
    expect((sum.totals as any).views).toEqual({ sum: 400, posts: 2 });
    expect((sum.totals as any).shares).toEqual({ sum: 5, posts: 1 });
    expect((sum.totals as any).reach).toBeUndefined();
    expect(sum.posts.find((p: any) => p.media_id === "p2")).toMatchObject({ content_type: "REELS", reach: 200 });
    // account values: follower / non-follower reach, new followers, demographics
    expect(sum.follow_reach).toMatchObject({ follower: 70, non_follower: 55 });
    expect(sum.new_followers).toMatchObject({ value: 4 });
    expect(sum.demographics!.gender.items[0]).toEqual({ dim: "F", value: 60 });
    expect(sum.demographics!.country.items.map((x) => x.dim)).toEqual(["SA", "YE"]);
    expect(sum.unread).toEqual({ queued: 0, too_old: 0 });
    // a post not read yet (queued) and one older than 90 days (never read) are counted for the explanation
    await DB.prepare("INSERT INTO media_cache (account_id, media_id, kind, posted_at, fetched_at) VALUES (?, 'p9', 'media', ?, ?), (?, 'old1', 'media', ?, ?)")
      .bind(acc.id, NOW - 2 * DAY, NOW, acc.id, NOW - 120 * DAY, NOW).run();
    const wide = await insightsSummary(DB, 1, { ...F, from: NOW - 200 * DAY });
    expect(wide.unread).toEqual({ queued: 1, too_old: 1 });
    expect((await insightsSummary(DB, 999, { ...F, from: NOW - 200 * DAY })).unread).toBeNull();
  });

  it("isolates customers: another tenant sees nothing", async () => {
    const acc = await account();
    const meta = new FakeInsights();
    meta.posts = [{ id: "p1", timestamp: new Date(NOW - DAY).toISOString() }];
    meta.media = { p1: metric({ views: 9 }) };
    await captureInsights(DB, meta, acc, "tok", 1, { left: 20 }, NOW);
    const other = await insightsSummary(DB, 999, F);
    expect(other.granted).toBe(false);
    expect(other.posts).toEqual([]);
    expect(await mediaInsightsSeries(DB, 999, "p1")).toEqual([]);
    expect((await mediaInsightsSeries(DB, 1, "p1")).length).toBe(1);
  });

  it("reads live stories, retries an unsupported metric once with the smaller set, and respects the budget", async () => {
    const acc = await account();
    const meta = new FakeInsights();
    meta.stories = [{ id: "s1", timestamp: new Date(NOW - 3_600_000).toISOString(), media_type: "IMAGE" }];
    meta.media = { s1: "invalid_metric" };
    await captureInsights(DB, meta, acc, "tok", 1, { left: 4 }, NOW);
    const s1 = await DB.prepare("SELECT * FROM media_insights WHERE media_id = 's1'").first<any>();
    expect(s1).toMatchObject({ status: "ok", reach: 40, views: null, content_type: "STORY" });
    expect(meta.calls.filter((c) => c.startsWith("insights:s1")).length).toBe(2);
    expect(meta.calls.length).toBeLessThanOrEqual(4);
    // a story already read in the last 50 minutes is not read again
    const meta2 = new FakeInsights();
    meta2.stories = meta.stories;
    await captureInsights(DB, meta2, acc, "tok", 1, { left: 4 }, NOW + 10 * 60_000);
    expect(meta2.calls.some((c) => c.startsWith("insights:s1"))).toBe(false);
  });

  it("stops on a permission error and records it", async () => {
    const acc = await account();
    const meta = new FakeInsights();
    meta.posts = [{ id: "p1", timestamp: new Date(NOW - DAY).toISOString() }, { id: "p2", timestamp: new Date(NOW - DAY).toISOString() }];
    meta.media = { p1: "permission", p2: "permission" };
    const s = await captureInsights(DB, meta, acc, "tok", 1, { left: 20 }, NOW);
    expect(s.stopped).toBe("permission");
    expect(meta.calls.filter((c) => c.startsWith("insights:")).length).toBe(1);
    expect(meta.calls.some((c) => c.startsWith("account:"))).toBe(false);
    const sum = await insightsSummary(DB, 1, F);
    expect(sum.status).toMatchObject({ ok: false, reason: "permission" });
  });

  it("is opt-in: no permission → nothing read, and the scope is only requested where the owner enabled it", async () => {
    await account(false);
    expect(await runInsights(TEST_ENV, (1 + 47) % 60)).toBe(0);
    expect((await insightsSummary(DB, 1, F)).granted).toBe(false);

    expect(await wantsInsightsScope(DB, 1)).toBe(false);
    await setSetting(DB, 1, "insights_scope", "owner");
    expect(await wantsInsightsScope(DB, 1)).toBe(true);
    expect(await wantsInsightsScope(DB, 2)).toBe(false);
    await setSetting(DB, 1, "insights_scope", "all");
    expect(await wantsInsightsScope(DB, 2)).toBe(true);

    const client = new HttpMetaClient({ apiVersion: "v26.0", appId: "1", appSecret: "s" });
    expect(new URL(client.authorizeUrl("https://x/cb", "st")).searchParams.get("scope")).not.toContain(INSIGHTS_SCOPE);
    expect(new URL(client.authorizeUrl("https://x/cb", "st", [INSIGHTS_SCOPE])).searchParams.get("scope")).toContain(INSIGHTS_SCOPE);
  });
});
