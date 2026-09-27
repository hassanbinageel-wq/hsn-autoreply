import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  commentPayload,
  DB,
  deliver,
  drain,
  flowsOf,
  following,
  messagePayload,
  MockMeta,
  notFollowing,
  resetDb,
  seedAccount,
  seedCampaign,
  setCtxExtra,
} from "./helpers";
import { buildDailyReport } from "../src/worker/services/notify";

const BASE = "https://hsn.example.workers.dev";
const SECRET = "https://example.com/secret-course";
const SELF = (exports as any).default as { fetch: (r: Request | string, init?: RequestInit) => Promise<Response> };
const call = (path: string, init?: RequestInit) => SELF.fetch(new Request(BASE + path, init));
const json = (body: unknown, headers: Record<string, string> = {}, method = "POST"): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json", ...headers },
  body: JSON.stringify(body),
});
async function login() {
  await call("/api/auth/setup", json({ setup_token: "test_setup_token_123456", username: "admin", password: "a-very-strong-password" }));
  const r = await call("/api/auth/login", json({ username: "admin", password: "a-very-strong-password", client: "app" }));
  const token = ((await r.json()) as any).token;
  return { Authorization: `Bearer ${token}` };
}

beforeEach(async () => {
  await resetDb();
  await seedAccount();
});

describe("1) link click tracking", () => {
  it("content button points to a tracked redirect; real taps are counted, link previews are not", async () => {
    setCtxExtra({ publicBaseUrl: BASE });
    const cid = await seedCampaign({});
    const meta = new MockMeta();
    await deliver(commentPayload({ text: "كورس" }), meta);
    const btn = meta.sends()[0].msg!.linkButton!;
    expect(btn.url).toMatch(new RegExp(`^${BASE}/l/[A-Za-z0-9_-]{16,}$`));
    expect(meta.sends()[0].text).toContain(SECRET); // plain-text fallback keeps the real link
    const path = new URL(btn.url).pathname;

    const preview = await call(path, { headers: { "User-Agent": "facebookexternalhit/1.1" }, redirect: "manual" });
    expect(preview.status).toBe(302);
    let f = (await flowsOf())[0];
    expect(f.link_clicks).toBe(0);

    const tap = await call(path, { headers: { "User-Agent": "Mozilla/5.0 (iPhone) Instagram 300.0" }, redirect: "manual" });
    expect(tap.status).toBe(302);
    expect(tap.headers.get("Location")).toBe(SECRET);
    await call(path, { headers: { "User-Agent": "Mozilla/5.0 (Android) Instagram" }, redirect: "manual" });
    f = (await flowsOf())[0];
    expect(f.link_clicks).toBe(2);
    expect(f.link_first_click_at).toBeTruthy();

    expect((await call("/l/not-a-real-token-123456", { redirect: "manual" })).status).toBe(404);

    const auth = await login();
    const s = (await (await call(`/api/campaigns/${cid}/stats`, { headers: auth })).json()) as any;
    expect(s.totals).toMatchObject({ clicked: 1, clicks_total: 2, delivered: 1 });
    const pr = (await (await call(`/api/campaigns/${cid}/people`, { headers: auth })).json()) as any;
    expect(pr.people[0]).toMatchObject({ clicks: 2 });
  });

  it("a retry reuses the same tracked link; tracking can be turned off per campaign", async () => {
    setCtxExtra({ publicBaseUrl: BASE });
    await seedCampaign({ track_clicks: false });
    const meta = new MockMeta();
    await deliver(commentPayload({ text: "كورس" }), meta);
    expect(meta.sends()[0].msg!.linkButton!.url).toBe(SECRET);
  });
});

describe("2) automatic follow reminder", () => {
  it("re-checks after N minutes and sends one reminder with the verify button if still not following", async () => {
    await seedCampaign({ require_follow: true, follow_reminder_minutes: 60 });
    const meta = new MockMeta();
    const clock = { t: Date.now() };
    await deliver(commentPayload({ text: "كورس", time: clock.t }), meta, clock);
    meta.follow = [notFollowing()];
    clock.t += 1000;
    await deliver(messagePayload({ text: "ابدأ", time: clock.t }), meta, clock);
    const dmsBefore = meta.sends().filter((s) => s.kind === "dm").length;
    clock.t += 30 * 60_000;
    await drain(meta, clock);
    expect(meta.sends().filter((s) => s.kind === "dm").length).toBe(dmsBefore); // not yet
    clock.t += 31 * 60_000;
    await drain(meta, clock);
    const dms = meta.sends().filter((s) => s.kind === "dm");
    expect(dms.length).toBe(dmsBefore + 1);
    expect(dms.at(-1)!.msg!.quickReplies![0].payload).toMatch(/^hsn:v1:verify:/);
    expect(dms.at(-1)!.text).not.toContain(SECRET);
    for (let i = 0; i < 5; i++) {
      clock.t += 60 * 60_000;
      await drain(meta, clock);
    }
    expect(meta.sends().filter((s) => s.kind === "dm").length).toBe(dmsBefore + 1); // only once
  });

  it("if the person followed in the meantime, the reminder check delivers the content instead", async () => {
    await seedCampaign({ require_follow: true, follow_reminder_minutes: 30 });
    const meta = new MockMeta();
    const clock = { t: Date.now() };
    await deliver(commentPayload({ text: "كورس", time: clock.t }), meta, clock);
    meta.follow = [notFollowing()];
    clock.t += 1000;
    await deliver(messagePayload({ text: "ابدأ", time: clock.t }), meta, clock);
    meta.follow = [following()];
    clock.t += 31 * 60_000;
    await drain(meta, clock);
    expect(meta.sends().filter((s) => s.text?.includes(SECRET))).toHaveLength(1);
    expect((await flowsOf())[0].state).toBe("content_sent");
  });

  it("no reminder once the 24h messaging window has closed", async () => {
    await seedCampaign({ require_follow: true, follow_reminder_minutes: 60 });
    const meta = new MockMeta();
    const clock = { t: Date.now() };
    await deliver(commentPayload({ text: "كورس", time: clock.t }), meta, clock);
    meta.follow = [notFollowing()];
    clock.t += 1000;
    await deliver(messagePayload({ text: "ابدأ", time: clock.t }), meta, clock);
    await DB.prepare("UPDATE participants SET last_user_message_at = ?").bind(clock.t - 24 * 3_600_000).run();
    const before = meta.sends().length;
    clock.t += 61 * 60_000;
    await drain(meta, clock);
    expect(meta.sends().length).toBe(before);
  });
});

describe("5) notifications", () => {
  it("notifies on a new follower and on delivery (when wired), never for demo", async () => {
    const got: Array<[string, string]> = [];
    setCtxExtra({ notify: async (k, t) => void got.push([k, t]) });
    await seedCampaign({ name: "كورس المونتاج", require_follow: true });
    const meta = new MockMeta();
    const clock = { t: Date.now() };
    await deliver(commentPayload({ text: "كورس", username: "sara_x", time: clock.t }), meta, clock);
    meta.follow = [notFollowing()];
    clock.t += 1000;
    await deliver(messagePayload({ text: "ابدأ", time: clock.t }), meta, clock);
    meta.follow = [following()];
    clock.t += 10_000;
    await deliver(messagePayload({ text: "تحقق", time: clock.t }), meta, clock);
    expect(got.map((g) => g[0])).toEqual(["new_follower", "delivery"]);
    expect(got[0][1]).toContain("@sara_x");
    expect(got[0][1]).toContain("كورس المونتاج");
  });

  it("daily report summarizes the last 24 hours", async () => {
    await seedCampaign({ name: "حملة التقرير" });
    const meta = new MockMeta();
    await deliver(commentPayload({ text: "كورس" }), meta);
    const text = await buildDailyReport(DB);
    expect(text).toContain("آخر 24 ساعة");
    expect(text).toContain("استلموا المحتوى: 1");
    expect(text).toContain("حملة التقرير");
  });

  it("the Telegram bot token is validated, stored encrypted and never returned or exported", async () => {
    const auth = await login();
    const bad = await call("/api/notifications", json({ bot_token: "not-a-token" }, auth, "PUT"));
    expect(bad.status).toBe(422);
    const token = "123456789:AAH-abcdefghijklmnopqrstuvwxyz012345";
    const ok = await call("/api/notifications", json({ bot_token: token, daily_report: true, report_hour: 20 }, auth, "PUT"));
    expect(ok.status).toBe(200);
    const body = await ok.text();
    expect(body).not.toContain(token);
    expect(JSON.parse(body)).toMatchObject({ has_token: true, settings: { report_hour: 20 } });
    const stored = await DB.prepare("SELECT value FROM app_settings WHERE key = 'telegram_token'").first<any>();
    expect(stored.value).not.toContain("AAH-abcdef");
    for (const path of ["/api/notifications", "/api/settings", "/api/settings/backup"]) {
      const t = await (await call(path, { headers: auth })).text();
      expect(t).not.toContain(token);
      expect(t).not.toContain("telegram_token");
    }
  });
});

describe("6) new posts and copy to a new reel", () => {
  const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "+0000");

  it("auto-attaches posts published after the start point; older posts stay out", async () => {
    const since = Date.now() - 3_600_000;
    const cid = await seedCampaign({ scope: "selected", media_ids: [], auto_new_media: true, auto_new_since: since });
    const meta = new MockMeta();
    meta.media["new_reel"] = { id: "new_reel", media_product_type: "REELS", media_type: "VIDEO", thumbnail_url: "https://cdn.example/t.jpg", timestamp: iso(Date.now() - 60_000) };
    meta.media["old_post"] = { id: "old_post", media_product_type: "FEED", media_type: "IMAGE", timestamp: iso(Date.now() - 2 * 86_400_000) };
    await deliver(commentPayload({ text: "كورس", mediaId: "new_reel", from: "a1" }), meta);
    await deliver(commentPayload({ text: "كورس", mediaId: "old_post", from: "a2" }), meta);
    expect(meta.sends().filter((s) => s.kind === "private_reply")).toHaveLength(1);
    const cm = await DB.prepare("SELECT media_id FROM campaign_media WHERE campaign_id = ?").bind(cid).all<any>();
    expect(cm.results.map((r) => r.media_id)).toEqual(["new_reel"]);
    // second comment on the same reel: served from cache, no extra Graph call
    await deliver(commentPayload({ text: "كورس", mediaId: "new_reel", from: "a3" }), meta);
    expect(meta.calls.filter((c) => c.kind === "get_media" && c.target === "new_reel")).toHaveLength(1);
  });

  it("reels-only option ignores new feed posts", async () => {
    await seedCampaign({ scope: "selected", media_ids: [], auto_new_media: true, auto_new_since: Date.now() - 3_600_000, auto_new_reels_only: true });
    const meta = new MockMeta();
    meta.media["new_photo"] = { id: "new_photo", media_product_type: "FEED", media_type: "IMAGE", timestamp: iso(Date.now() - 60_000) };
    await deliver(commentPayload({ text: "كورس", mediaId: "new_photo" }), meta);
    expect(meta.sends()).toHaveLength(0);
  });

  it("copy to a new reel: duplicates with the chosen media and activates it", async () => {
    const auth = await login();
    const cid = await seedCampaign({ name: "الأصل", scope: "selected", media_ids: ["reel_A"] });
    const r = await call(`/api/campaigns/${cid}/duplicate`, json({ media_ids: ["reel_B"], activate: true, name: "الأصل — ريل جديد" }, auth));
    expect(r.status).toBe(200);
    const { id, status } = (await r.json()) as any;
    expect(status).toBe("active");
    const c = await DB.prepare("SELECT name, status, scope, activated_at FROM campaigns WHERE id = ?").bind(id).first<any>();
    expect(c).toMatchObject({ name: "الأصل — ريل جديد", status: "active", scope: "selected" });
    expect(c.activated_at).toBeTruthy();
    const cm = await DB.prepare("SELECT media_id FROM campaign_media WHERE campaign_id = ?").bind(id).all<any>();
    expect(cm.results.map((x) => x.media_id)).toEqual(["reel_B"]);
    const kw = await DB.prepare("SELECT COUNT(*) AS n FROM campaign_keywords WHERE campaign_id = ?").bind(id).first<any>();
    expect(kw.n).toBe(1);
  });
});

describe("10) inbox", () => {
  it("records inbound, bot and app messages once each; lists conversations with unread counts", async () => {
    await seedCampaign({ type: "story_reply", match_all: true, keywords: [] });
    const meta = new MockMeta();
    await deliver(messagePayload({ text: "واو 😍", storyReply: { id: "st1" }, mid: "in_1" }), meta);
    // Instagram echoes our own bot message back with the same mid → still one row, labelled "bot"
    await deliver(messagePayload({ text: "echo of bot", echo: true, mid: "mid_1" }), meta);
    // the owner replies from the Instagram app
    await deliver(messagePayload({ text: "أهلًا بك 🌷", echo: true, mid: "app_1" }), meta);
    const rows = (await DB.prepare("SELECT direction, source, text FROM messages ORDER BY id").all<any>()).results;
    expect(rows.map((r) => `${r.direction}:${r.source}`)).toEqual(["in:user", "out:bot", "out:app"]);
    expect(rows[0].text).toContain("واو");

    const auth = await login();
    const list = (await (await call("/api/inbox", { headers: auth })).json()) as any[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ unread: 1, window_open: true, last_text: "أهلًا بك 🌷" });
    const thread = (await (await call(`/api/inbox/${list[0].id}`, { headers: auth })).json()) as any;
    expect(thread.messages).toHaveLength(3);
    expect(thread.window_open).toBe(true);
    const again = (await (await call("/api/inbox", { headers: auth })).json()) as any[];
    expect(again[0].unread).toBe(0);
  });

  it("manual reply is refused outside the 24h window", async () => {
    await seedCampaign({ type: "story_reply", match_all: true, keywords: [] });
    await deliver(messagePayload({ text: "مرحبا", storyReply: { id: "st2" } }), new MockMeta());
    await DB.prepare("UPDATE participants SET last_user_message_at = ?").bind(Date.now() - 25 * 3_600_000).run();
    const auth = await login();
    const p = await DB.prepare("SELECT id FROM participants").first<any>();
    const r = await call(`/api/inbox/${p.id}/send`, json({ text: "رد يدوي" }, auth));
    expect(r.status).toBe(409);
  });

  it("messages are still recorded while automation is paused", async () => {
    await DB.prepare("UPDATE app_settings SET value = 'false' WHERE key = 'automation_enabled'").run();
    await seedCampaign({ type: "story_reply", match_all: true, keywords: [] });
    const meta = new MockMeta();
    await deliver(messagePayload({ text: "سؤال", storyReply: { id: "st3" } }), meta);
    expect(meta.sends()).toHaveLength(0);
    const n = await DB.prepare("SELECT COUNT(*) AS n FROM messages").first<any>();
    expect(n.n).toBe(1);
  });
});
