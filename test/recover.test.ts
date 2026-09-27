import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { commentPayload, DB, deliver, drain, makeCtx, MockMeta, resetDb, seedAccount, seedCampaign } from "./helpers";
import { recoverMissedComments } from "../src/worker/services/recover";
import { estimateUsage } from "../src/worker/services/usage";

const BASE = "https://hsn.example.workers.dev";
const SELF = (exports as any).default as { fetch: (r: Request | string, init?: RequestInit) => Promise<Response> };
const call = (path: string, init?: RequestInit) => SELF.fetch(new Request(BASE + path, init));
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "+0000");

beforeEach(async () => {
  await resetDb();
  await seedAccount();
});

describe("recovery of comments whose webhook never arrived", () => {
  it("answers missed comments once, skips known and too-old ones, and never answers twice", async () => {
    await seedCampaign({ scope: "selected", media_ids: ["media_A"] });
    const meta = new MockMeta();
    // one comment did arrive by webhook
    await deliver(commentPayload({ text: "كورس", commentId: "seen_1", mediaId: "media_A", from: "u_seen" }), meta);
    expect(meta.sends().filter((s) => s.kind === "private_reply")).toHaveLength(1);
    const now = Date.now();
    meta.comments["media_A"] = [
      { id: "missed_1", text: "أبغى الكورس", timestamp: iso(now - 20_000), from: { id: "u_missed", username: "missed_user" } },
      { id: "seen_1", text: "كورس", timestamp: iso(now - 30_000), from: { id: "u_seen", username: "seen_user" } },
      { id: "old_1", text: "كورس", timestamp: iso(now - 8 * 86_400_000), from: { id: "u_old", username: "old_user" } },
      { id: "nomatch_1", text: "ماشاء الله", timestamp: iso(now - 10_000), from: { id: "u_x", username: "x" } },
    ];
    const r = await recoverMissedComments(makeCtx(meta), { maxMedia: 10 });
    expect(r).toMatchObject({ media: 1, fetched: 4, recovered: 2 }); // missed_1 + nomatch_1 (stored, then ignored by matching)
    await drain(meta);
    const replies = meta.sends().filter((s) => s.kind === "private_reply").map((s) => s.target);
    expect(replies).toEqual(["seen_1", "missed_1"]);
    const p = await DB.prepare("SELECT username FROM participants WHERE igsid = 'u_missed'").first<any>();
    expect(p.username).toBe("missed_user");

    // running again, or the late webhook finally arriving, changes nothing
    expect((await recoverMissedComments(makeCtx(meta))).recovered).toBe(0);
    await deliver(commentPayload({ text: "أبغى الكورس", commentId: "missed_1", mediaId: "media_A", from: "u_missed" }), meta);
    expect(meta.sends().filter((s) => s.kind === "private_reply")).toHaveLength(2);
    // the app can list what was recovered: who, on which post, and what was sent
    await DB.prepare("INSERT INTO media_cache (account_id, media_id, kind, caption, fetched_at) SELECT id, 'media_A', 'media', 'ريل الكورس', 0 FROM instagram_accounts").run();
    await call("/api/auth/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ setup_token: "test_setup_token_123456", username: "admin", password: "a-very-strong-password" }) });
    const lr = await call("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "a-very-strong-password", client: "app" }) });
    const auth = { Authorization: `Bearer ${((await lr.json()) as any).token}` };
    const items = ((await (await call("/api/recover/items", { headers: auth })).json()) as any).items;
    expect(items.map((i: any) => i.sender_username).sort()).toEqual(["missed_user", "x"]);
    const got = items.find((i: any) => i.sender_username === "missed_user");
    expect(got).toMatchObject({ text: "أبغى الكورس", caption: "ريل الكورس", status: "processed", campaign_name: "حملة" });
    expect(got.sent.length).toBeGreaterThan(0);
    expect(items.find((i: any) => i.sender_username === "x").status).toBe("ignored");
    // recovered events do not pretend a webhook arrived
    const acc = await DB.prepare("SELECT last_webhook_at FROM instagram_accounts").first<any>();
    expect(acc.last_webhook_at).toBeTruthy();
  });

  it("does nothing without an active comment campaign or while automation is paused", async () => {
    const meta = new MockMeta();
    expect((await recoverMissedComments(makeCtx(meta))).skipped_reason).toBe("no_active_comment_campaign");
    await seedCampaign({ scope: "selected", media_ids: ["m"] });
    await DB.prepare("UPDATE app_settings SET value = 'false' WHERE key = 'automation_enabled'").run();
    expect((await recoverMissedComments(makeCtx(meta))).skipped_reason).toBe("automation_paused");
    expect(meta.calls.filter((c) => c.kind === "list_comments")).toHaveLength(0);
  });

  it("'all posts' campaigns look at posts with recent comment activity", async () => {
    await seedCampaign({ scope: "all" });
    const meta = new MockMeta();
    await deliver(commentPayload({ text: "سلام", commentId: "act_1", mediaId: "busy_reel", from: "u1" }), meta);
    meta.comments["busy_reel"] = [{ id: "missed_2", text: "كورس", timestamp: iso(Date.now() - 20_000), from: { id: "u2", username: "two" } }];
    const r = await recoverMissedComments(makeCtx(meta));
    expect(r.recovered).toBe(1);
    await drain(meta);
    expect(meta.sends().some((s) => s.target === "missed_2")).toBe(true);
  });
});

describe("daily usage estimate", () => {
  it("grows with activity and reports percentages of the free limits", async () => {
    const before = await estimateUsage(DB);
    await seedCampaign({});
    const meta = new MockMeta();
    for (let i = 0; i < 5; i++) await deliver(commentPayload({ text: "كورس", from: `p${i}`, commentId: `uc_${i}` }), meta);
    const after = await estimateUsage(DB);
    expect(after.counts.events).toBe(before.counts.events + 5);
    expect(after.writes.used).toBeGreaterThan(before.writes.used);
    expect(after.writes.limit).toBe(100_000);
    expect(after.reset_at - after.day_start).toBe(86_400_000);
    expect(after.writes.pct).toBeGreaterThanOrEqual(0);
  });

  it("API: usage and manual recovery endpoints", async () => {
    await call("/api/auth/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ setup_token: "test_setup_token_123456", username: "admin", password: "a-very-strong-password" }) });
    const lr = await call("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "a-very-strong-password", client: "app" }) });
    const auth = { Authorization: `Bearer ${((await lr.json()) as any).token}` };
    const u = (await (await call("/api/usage", { headers: auth })).json()) as any;
    expect(u.usage.requests.limit).toBe(100_000);
    expect(u.auto_recover).toBe(true);
    const r = await call("/api/recover", { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: "{}" });
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).recovered).toBe(0);
  });
});
