import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { commentPayload, DB, deliver, IG_ID, makeCtx, MockMeta, resetDb, seedAccount, seedCampaign, TEST_ENV } from "./helpers";
import { analyticsByPost, analyticsDevices, analyticsFollow, analyticsHeatmap, analyticsOverview, analyticsRetention, osFamily, type AnalyticsFilter } from "../src/worker/services/analytics";
import { recheckTenant } from "../src/worker/services/retention";
import { setSetting } from "../src/worker/lib/db";

const SELF = (exports as any).default as { fetch: (r: Request | string, init?: RequestInit) => Promise<Response> };
const day = 86_400_000;
const F = (extra: Partial<AnalyticsFilter> = {}): AnalyticsFilter => ({ from: Date.now() - 7 * day, to: Date.now() + 60_000, tzOffsetMin: 180, ...extra });

beforeEach(async () => {
  await resetDb();
  await seedAccount();
});

async function twoPeopleThreeComments() {
  const cid = await seedCampaign({ scope: "selected", media_ids: ["media_A"] });
  const meta = new MockMeta();
  await deliver(commentPayload({ text: "كورس", commentId: "c1", mediaId: "media_A", from: "u1", username: "one" }), meta);
  await deliver(commentPayload({ text: "كورس مرة ثانية", commentId: "c2", mediaId: "media_A", from: "u1", username: "one" }), meta);
  await deliver(commentPayload({ text: "كورس", commentId: "c3", mediaId: "media_A", from: "u2", username: "two" }), meta);
  // the account's own reply under a comment is not audience activity
  await deliver(commentPayload({ text: "أرسلنا لك", commentId: "mine", mediaId: "media_A", from: IG_ID, username: "hsn_shop" }), meta);
  return { cid, meta };
}

describe("analytics", () => {
  it("counts events and people separately, without the account's own comments", async () => {
    const { cid } = await twoPeopleThreeComments();
    const o = await analyticsOverview(DB, 1, F());
    expect(o.events).toEqual({ total: 3, people: 2 });
    const flows = await DB.prepare("SELECT COUNT(DISTINCT participant_id) AS n FROM conversation_flows WHERE campaign_id = ?").bind(cid).first<any>();
    expect(o.flows.people).toBe(flows.n);
    expect(o.series.reduce((a, d) => a + d.events, 0)).toBe(3);
    // per post: one post, the same campaign, comments vs commenters
    const posts = await analyticsByPost(DB, 1, F());
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ media_id: "media_A", comments: 3, commenters: 2 });
    expect(posts[0].campaigns.map((c) => c.id)).toEqual([cid]);
    // filters
    expect((await analyticsOverview(DB, 1, F({ mediaId: "other" }))).events.total).toBe(0);
    expect((await analyticsOverview(DB, 1, F({ type: "story_reply" }))).events.total).toBe(0);
    // heatmap is built from the same events
    const h = await analyticsHeatmap(DB, 1, F(), "comments");
    expect(h.total).toBe(3);
    expect(h.top_hours).toEqual([]); // not enough data for a suggestion
  });

  it("is scoped to the customer", async () => {
    await twoPeopleThreeComments();
    const other = await analyticsOverview(DB, 999, F());
    expect(other.events).toEqual({ total: 0, people: 0 });
    expect(other.flows.people).toBe(0);
    expect(await analyticsByPost(DB, 999, F())).toEqual([]);
  });

  it("an unknown or failed follow check is never counted as not following", async () => {
    await twoPeopleThreeComments();
    const people = (await DB.prepare("SELECT id FROM participants ORDER BY id").all<any>()).results;
    const flow = (pid: number) => DB.prepare("SELECT id FROM conversation_flows WHERE participant_id = ? LIMIT 1").bind(pid).first<any>();
    await DB.prepare("DELETE FROM follow_checks").run();
    const now = Date.now();
    await DB.prepare("INSERT INTO follow_checks (flow_id, participant_id, result, checked_at) VALUES (?, ?, 'temporary_error', ?)").bind((await flow(people[0].id)).id, people[0].id, now).run();
    await DB.prepare("INSERT INTO follow_checks (flow_id, participant_id, result, checked_at) VALUES (?, ?, 'not_following', ?)").bind((await flow(people[1].id)).id, people[1].id, now).run();
    const f = await analyticsFollow(DB, 1, F());
    expect(f.people).toBe(2);
    expect(f.at_participation).toEqual({ following: 0, not_following: 1, unknown: 1 });
  });

  it("retention: only a later successful 'not following' after a 'following' at delivery counts", async () => {
    await twoPeopleThreeComments();
    await DB.prepare("DELETE FROM follow_checks").run();
    const now = Date.now();
    const flows = (await DB.prepare("SELECT id, participant_id FROM conversation_flows").all<any>()).results;
    await DB.prepare("UPDATE conversation_flows SET state = 'content_sent', content_delivered_at = ?").bind(now - 3 * day).run();
    const [a, b] = [...new Map(flows.map((f: any) => [f.participant_id, f])).values()] as any[];
    const check = (f: any, r: string, at: number) => DB.prepare("INSERT INTO follow_checks (flow_id, participant_id, result, checked_at) VALUES (?, ?, ?, ?)").bind(f.id, f.participant_id, r, at).run();
    await check(a, "following", now - 3 * day - 1000);
    await check(a, "not_following", now - day);
    await check(b, "following", now - 3 * day - 1000);
    await check(b, "temporary_error", now - day); // failed re-check: stays unknown
    const r = await analyticsRetention(DB, 1, F());
    expect(r).toMatchObject({ cohort: 2, rechecked: 1, no_longer_following: 1, still_following: 0, unknown: 1 });
    expect(r.items.find((i) => i.username === "one")?.last_status).toBe("not_following");
  });

  it("logs link taps with an approximate OS and keeps link-preview bots out", async () => {
    await twoPeopleThreeComments();
    const flow = await DB.prepare("SELECT id FROM conversation_flows LIMIT 1").first<any>();
    await DB.prepare("UPDATE conversation_flows SET link_token = 'tok_aaaaaaaaaaaaaaaa1', link_url = 'https://example.com/x' WHERE id = ?").bind(flow.id).run();
    const tap = (ua: string) => SELF.fetch(new Request("https://hsn.example.workers.dev/l/tok_aaaaaaaaaaaaaaaa1", { headers: { "User-Agent": ua }, redirect: "manual" }));
    expect((await tap("Mozilla/5.0 (Linux; Android 14) Instagram 300")).status).toBe(302);
    await tap("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)");
    await tap("facebookexternalhit/1.1");
    const d = await analyticsDevices(DB, 1, F());
    expect(d.android.clicks).toBe(1);
    expect(d.ios.clicks).toBe(1);
    expect(d.other.clicks + d.unknown.clicks).toBe(0);
    expect((await analyticsOverview(DB, 1, F())).clicks.total).toBe(2);
    expect(osFamily(undefined)).toBe("unknown");
  });

  it("follow re-check is off by default and never turns a failed read into 'not following'", async () => {
    await twoPeopleThreeComments();
    await DB.prepare("DELETE FROM follow_checks").run();
    const old = Date.now() - 10 * day;
    await DB.prepare("UPDATE conversation_flows SET state = 'content_sent', content_delivered_at = ?").bind(old).run();
    const flows = (await DB.prepare("SELECT id, participant_id FROM conversation_flows").all<any>()).results;
    for (const f of flows) await DB.prepare("INSERT INTO follow_checks (flow_id, participant_id, result, checked_at) VALUES (?, ?, 'following', ?)").bind(f.id, f.participant_id, old).run();
    const meta = new MockMeta();
    expect(await recheckTenant(TEST_ENV, makeCtx(meta), 1)).toBe(0); // off
    await setSetting(DB, 1, "follow_recheck_enabled", true);
    meta.follow = [{ result: "temporary_error", fieldPresent: false }];
    const n = await recheckTenant(TEST_ENV, makeCtx(meta), 1);
    expect(n).toBeGreaterThan(0);
    const latest = await DB.prepare("SELECT result FROM follow_checks ORDER BY id DESC LIMIT 1").first<any>();
    expect(latest.result).toBe("temporary_error");
    const r = await analyticsRetention(DB, 1, F({ from: old - day }));
    expect(r.no_longer_following).toBe(0);
  });
});
