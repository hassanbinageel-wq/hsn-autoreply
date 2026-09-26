import { beforeEach, describe, expect, it } from "vitest";
import { AUTO_RECHECK_DELAY_MS } from "../src/worker/engine/jobs";
import {
  apiError,
  commentPayload,
  DB,
  deliver,
  drain,
  flowsOf,
  following,
  lastEvent,
  makeCtx,
  messagePayload,
  MockMeta,
  needsInteraction,
  notFollowing,
  resetDb,
  seedAccount,
  seedCampaign,
  unknownField,
  unsupported,
  IG_ID,
  uid,
} from "./helpers";
import { claimNextJob, enqueue, recoverStaleLeases } from "../src/worker/engine/jobs";
import { runQueue } from "../src/worker/engine/executor";

const SECRET = "https://example.com/secret-course";

beforeEach(async () => {
  await resetDb();
  await seedAccount();
});

describe("comment campaign without follow requirement", () => {
  it("sends the content once as a private reply and ignores duplicate deliveries of the same event", async () => {
    await seedCampaign({ keywords: [{ keyword: "كورس" }] });
    const meta = new MockMeta();
    const p = commentPayload({ text: "أبغى الكورس 🔥", commentId: "c_dup" });
    await deliver(p, meta);
    await deliver(p, meta); // Meta retries the same webhook
    expect(meta.sends()).toHaveLength(1);
    expect(meta.sends()[0]).toMatchObject({ kind: "private_reply", target: "c_dup" });
    expect(meta.sends()[0].text).toContain(SECRET);
    const [f] = await flowsOf();
    expect(f.state).toBe("content_sent");
    expect(f.private_reply_status).toBe("accepted");
  });

  it("ignores non-matching comments, excluded words and threaded replies by default", async () => {
    await seedCampaign({ keywords: [{ keyword: "كورس" }, { keyword: "سعر", kind: "exclude" }] });
    const meta = new MockMeta();
    await deliver(commentPayload({ text: "مرحبا" }), meta);
    expect((await lastEvent()).reason).toContain("no_keyword_match");
    await deliver(commentPayload({ text: "كم سعر الكورس" }), meta);
    expect((await lastEvent()).reason).toContain("excluded_keyword");
    await deliver(commentPayload({ text: "كورس", parentId: "parent_1" }), meta);
    expect((await lastEvent()).reason).toContain("threaded_reply_excluded");
    expect(meta.sends()).toHaveLength(0);
  });

  it("never replies to the account's own comments or message echoes", async () => {
    await seedCampaign({ match_all: true, keywords: [] });
    const meta = new MockMeta();
    await deliver(commentPayload({ text: "كورس", from: IG_ID, username: "hsn_shop" }), meta);
    expect((await lastEvent()).reason).toBe("own_account");
    await deliver(commentPayload({ text: "كورس", from: "someone", username: "HSN_SHOP" }), meta);
    expect((await lastEvent()).reason).toBe("own_account");
    await deliver(messagePayload({ text: "كورس", echo: true }), meta);
    expect((await lastEvent()).reason).toBe("message_echo");
    expect(meta.sends()).toHaveLength(0);
  });

  it("ignores events older than the campaign activation", async () => {
    await seedCampaign({ activated_at: Date.now() });
    const meta = new MockMeta();
    await deliver(commentPayload({ text: "كورس", time: Date.now() - 3_600_000 }), meta);
    expect((await lastEvent()).reason).toContain("event_before_activation");
    expect(meta.sends()).toHaveLength(0);
  });

  it("respects media scope", async () => {
    await seedCampaign({ scope: "selected", media_ids: ["reel_A"] });
    const meta = new MockMeta();
    await deliver(commentPayload({ text: "كورس", mediaId: "reel_B" }), meta);
    expect((await lastEvent()).reason).toContain("media_not_in_scope");
    await deliver(commentPayload({ text: "كورس", mediaId: "reel_A" }), meta);
    expect(meta.sends()).toHaveLength(1);
  });

  it("runs only the highest-priority matching campaign", async () => {
    const low = await seedCampaign({ name: "low", priority: 10, final_text: "LOW", final_url: null });
    const high = await seedCampaign({ name: "high", priority: 500, final_text: "HIGH", final_url: null });
    const meta = new MockMeta();
    await deliver(commentPayload({ text: "كورس" }), meta);
    expect(meta.sends()).toHaveLength(1);
    expect(meta.sends()[0].text).toBe("HIGH");
    const ev = await lastEvent();
    expect(ev.campaign_id).toBe(high);
    expect(ev.campaign_id).not.toBe(low);
  });

  it("limits deliveries per user", async () => {
    await seedCampaign({ max_deliveries_per_user: 1 });
    const meta = new MockMeta();
    await deliver(commentPayload({ text: "كورس" }), meta);
    await deliver(commentPayload({ text: "كورس مرة ثانية" }), meta);
    expect(meta.sends()).toHaveLength(1);
    expect((await lastEvent()).reason).toBe("max_deliveries_reached");
  });
});

describe("public reply vs private reply are recorded independently", () => {
  it("private OK + public FAIL", async () => {
    await seedCampaign({ public_reply_enabled: true, public_reply_text: "أرسلت لك في الخاص 🙌" });
    const meta = new MockMeta();
    meta.publicReply = "fail";
    await deliver(commentPayload({ text: "كورس" }), meta);
    const [f] = await flowsOf();
    expect(f.state).toBe("content_sent");
    expect(f.private_reply_status).toBe("accepted");
    expect(f.public_reply_status).toBe("failed");
  });

  it("private FAIL → no delivery claim; optional fallback public reply", async () => {
    await seedCampaign({ public_reply_enabled: true, public_reply_text: "أرسلت لك 🙌", public_reply_on_dm_fail: "fallback", public_reply_fallback_text: "راسلنا على الخاص 🙏" });
    const meta = new MockMeta();
    meta.privateReply = "fail";
    await deliver(commentPayload({ text: "كورس" }), meta);
    const publics = meta.calls.filter((c) => c.kind === "public_reply");
    expect(publics).toHaveLength(1);
    expect(publics[0].text).toBe("راسلنا على الخاص 🙏");
    const [f] = await flowsOf();
    expect(f.private_reply_status).toBe("failed");
    expect(f.public_reply_status).toBe("accepted");
    expect(f.state).toBe("failed");
  });

  it("private FAIL without fallback → no public reply at all", async () => {
    await seedCampaign({ public_reply_enabled: true, public_reply_text: "شيّك الخاص" });
    const meta = new MockMeta();
    meta.privateReply = "fail";
    await deliver(commentPayload({ text: "كورس" }), meta);
    expect(meta.calls.filter((c) => c.kind === "public_reply")).toHaveLength(0);
  });
});

describe("follow-gated comment flow", () => {
  it("opening message never leaks content; 'I followed' without following does not deliver; re-check then delivers once", async () => {
    await seedCampaign({ require_follow: true, public_reply_enabled: true, public_reply_text: "أرسلت لك المحتوى ✅", verify_cooldown_seconds: 5 });
    const meta = new MockMeta();
    const clock = { t: Date.now() };

    // 1) comment → one private reply asking to reply "ابدأ" (no content), public reply must not claim delivery
    await deliver(commentPayload({ text: "ابغى الكورس", commentId: "c_follow", time: clock.t }), meta, clock);
    expect(meta.sends().map((s) => s.kind)).toEqual(["private_reply", "public_reply"]);
    expect(meta.sends()[0].text).toContain("ابدأ");
    expect(meta.sends()[0].text).not.toContain(SECRET);
    expect(meta.sends()[1].text).toBe("شيّك الخاص لإكمال الخطوات 🙌");
    expect(meta.calls.some((c) => c.kind === "follow_check")).toBe(false); // no consent yet
    expect((await flowsOf())[0].state).toBe("awaiting_user_interaction");

    // 2) user replies "ابدأ" → follow check → not following → follow request DM with a verify button, still no content
    meta.follow = [notFollowing()];
    clock.t += 1000;
    await deliver(messagePayload({ text: "ابدأ", time: clock.t }), meta, clock);
    let dms = meta.sends().filter((s) => s.kind === "dm");
    expect(dms).toHaveLength(1);
    expect(dms[0].text).not.toContain(SECRET);
    expect(dms[0].text).toMatch(/تحقق|تحقّق/);
    const qr = dms[0].msg!.quickReplies![0];
    expect(qr.payload).toMatch(/^hsn:v1:verify:[A-Za-z0-9_-]{16,}$/);
    expect(qr.payload).not.toContain("example.com");
    expect((await flowsOf())[0].state).toBe("awaiting_follow");

    // 3) user taps the button but still does not follow → reminder, no content
    meta.follow = [notFollowing()];
    clock.t += 10_000;
    await deliver(messagePayload({ text: "تحقّق من المتابعة", quickReply: qr.payload, time: clock.t }), meta, clock);
    dms = meta.sends().filter((s) => s.kind === "dm");
    expect(dms).toHaveLength(2);
    expect(dms[1].text).not.toContain(SECRET);
    // typing "تابعت" is only a request to verify — never proof
    meta.follow = [notFollowing()];
    clock.t += 10_000;
    await deliver(messagePayload({ text: "تابعت", time: clock.t }), meta, clock);
    expect(meta.sends().filter((s) => s.kind === "dm" && s.text?.includes(SECRET))).toHaveLength(0);

    // 4) the user follows and verifies again → fresh check → content delivered exactly once
    meta.follow = [following()];
    clock.t += 10_000;
    await deliver(messagePayload({ text: "تحقق", time: clock.t }), meta, clock);
    const withContent = meta.sends().filter((s) => s.text?.includes(SECRET));
    expect(withContent).toHaveLength(1);
    expect(withContent[0].kind).toBe("dm");
    const [f] = await flowsOf();
    expect(f.state).toBe("content_sent");

    // 5) further verify taps do nothing (flow closed)
    clock.t += 10_000;
    await deliver(messagePayload({ text: "تحقق", quickReply: qr.payload, time: clock.t }), meta, clock);
    expect(meta.sends().filter((s) => s.text?.includes(SECRET))).toHaveLength(1);
    const checks = await DB.prepare("SELECT result FROM follow_checks ORDER BY id").all<any>();
    expect(checks.results.map((r) => r.result)).toEqual(["not_following", "not_following", "not_following", "following"]);
  });

  it("follower who already messaged us: checks immediately and sends content in the single private reply", async () => {
    await seedCampaign({ require_follow: true });
    const meta = new MockMeta();
    await deliver(messagePayload({ text: "السلام عليكم" }), meta); // opens the window + consent
    meta.follow = [following()];
    await deliver(commentPayload({ text: "كورس", commentId: "c_fast" }), meta);
    const s = meta.sends();
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ kind: "private_reply", target: "c_fast" });
    expect(s[0].text).toContain(SECRET);
  });

  it("needs_interaction from the API sends the opening (no content) and waits", async () => {
    await seedCampaign({ require_follow: true });
    const meta = new MockMeta();
    await deliver(messagePayload({ text: "hi" }), meta);
    meta.follow = [needsInteraction()];
    await deliver(commentPayload({ text: "كورس" }), meta);
    const [f] = await flowsOf();
    expect(f.state).toBe("awaiting_user_interaction");
    expect(meta.sends()[0].kind).toBe("private_reply");
    expect(meta.sends()[0].text).not.toContain(SECRET);
  });

  it.each([
    ["unknown (field missing)", unknownField],
    ["API error", apiError],
  ])("%s is NOT treated as not-following and never delivers", async (_n, outcome) => {
    await seedCampaign({ require_follow: true, type: "story_reply", match_all: true, keywords: [] });
    const meta = new MockMeta();
    meta.follow = [outcome()];
    await deliver(messagePayload({ text: "😍", storyReply: { id: "story_1" } }), meta);
    const s = meta.sends();
    expect(s).toHaveLength(1);
    expect(s[0].text).toContain("ما قدرنا نتحقق");
    expect(s[0].text).not.toContain(SECRET);
    const [f] = await flowsOf();
    expect(f.state).toBe("awaiting_follow");
    expect(f.last_follow_result).not.toBe("not_following");
  });

  it("unsupported follow check → verification_unavailable, reason stored on the account, no content", async () => {
    await seedCampaign({ require_follow: true, type: "story_reply", match_all: true, keywords: [] });
    const meta = new MockMeta();
    meta.follow = [unsupported()];
    await deliver(messagePayload({ text: "واو", storyReply: { id: "st" } }), meta);
    const [f] = await flowsOf();
    expect(f.state).toBe("verification_unavailable");
    expect(meta.sends().some((s) => s.text?.includes(SECRET))).toBe(false);
    const acc = await DB.prepare("SELECT follow_check_support, follow_check_note FROM instagram_accounts").first<any>();
    expect(acc.follow_check_support).toBe("unsupported");
    expect(acc.follow_check_note).toContain("no permission");
  });

  it("a tap inside the verify cooldown is deferred to the end of the cooldown (never dropped); max attempts still enforced", async () => {
    await seedCampaign({ require_follow: true, type: "story_reply", match_all: true, keywords: [], max_verify_attempts: 2, verify_cooldown_seconds: 60 });
    const meta = new MockMeta();
    const clock = { t: Date.now() };
    meta.follow = [notFollowing()];
    await deliver(messagePayload({ text: "واو", storyReply: { id: "st" }, time: clock.t }), meta, clock);
    clock.t += 1000;
    await deliver(messagePayload({ text: "تحقق", time: clock.t }), meta, clock); // attempt 1 → check now
    const checksAfter1 = meta.calls.filter((c) => c.kind === "follow_check").length;
    clock.t += 5_000;
    await deliver(messagePayload({ text: "تحقق", time: clock.t }), meta, clock); // attempt 2 → scheduled for the end of the cooldown
    expect((await lastEvent()).reason).toBe("verify_deferred");
    expect(meta.calls.filter((c) => c.kind === "follow_check")).toHaveLength(checksAfter1);
    expect((await flowsOf())[0].state).toBe("checking_follow");
    clock.t += 56_000; // cooldown over → the deferred check runs on its own
    await drain(meta, clock);
    expect(meta.calls.filter((c) => c.kind === "follow_check").length).toBeGreaterThan(checksAfter1);
    clock.t += 61_000;
    await deliver(messagePayload({ text: "تحقق", time: clock.t }), meta, clock); // exceeded
    expect((await lastEvent()).reason).toBe("verify_attempts_exceeded");
    expect(meta.sends().at(-1)!.text).toContain("الأعلى من محاولات التحقق");
  });

  it("after a 'not following' result on a verify tap, re-checks once quietly and delivers if the follow lands", async () => {
    await seedCampaign({ require_follow: true, type: "story_reply", match_all: true, keywords: [], verify_cooldown_seconds: 10 });
    const meta = new MockMeta();
    const clock = { t: Date.now() };
    meta.follow = [notFollowing()];
    await deliver(messagePayload({ text: "واو", storyReply: { id: "st" }, time: clock.t }), meta, clock); // follow request
    clock.t += 3000;
    await deliver(messagePayload({ text: "تحقق", time: clock.t }), meta, clock); // still not following (Instagram lag)
    const sendsBefore = meta.sends().length;
    expect(meta.sends().some((s) => s.text?.includes(SECRET))).toBe(false);
    // the follow now shows up; nobody taps anything
    meta.follow = [following()];
    clock.t += AUTO_RECHECK_DELAY_MS;
    await drain(meta, clock);
    const content = meta.sends().filter((s) => s.text?.includes(SECRET));
    expect(content).toHaveLength(1);
    expect(meta.sends()).toHaveLength(sendsBefore + 1);
    expect((await flowsOf())[0].state).toBe("content_sent");
  });

  it("the quiet re-check sends nothing when the person still does not follow, and happens only once", async () => {
    await seedCampaign({ require_follow: true, type: "story_reply", match_all: true, keywords: [], verify_cooldown_seconds: 10 });
    const meta = new MockMeta();
    const clock = { t: Date.now() };
    meta.follow = [notFollowing()];
    await deliver(messagePayload({ text: "واو", storyReply: { id: "st" }, time: clock.t }), meta, clock);
    clock.t += 3000;
    await deliver(messagePayload({ text: "تحقق", time: clock.t }), meta, clock);
    const sends = meta.sends().length;
    const checks = meta.calls.filter((c) => c.kind === "follow_check").length;
    for (let i = 0; i < 3; i++) {
      clock.t += AUTO_RECHECK_DELAY_MS;
      await drain(meta, clock);
    }
    expect(meta.sends()).toHaveLength(sends);
    expect(meta.calls.filter((c) => c.kind === "follow_check")).toHaveLength(checks + 1);
    const [f] = await flowsOf();
    expect(f.state).toBe("awaiting_follow");
    // the person can still verify by hand afterwards
    meta.follow = [following()];
    clock.t += 1000;
    await deliver(messagePayload({ text: "تحقق", time: clock.t }), meta, clock);
    expect(meta.sends().filter((s) => s.text?.includes(SECRET))).toHaveLength(1);
  });
});

describe("story reply & story mention", () => {
  it("story reply triggers the story campaign (not the comment campaign) and delivers inside the conversation", async () => {
    await seedCampaign({ type: "comment", keywords: [{ keyword: "واو" }], final_text: "COMMENT", final_url: null });
    await seedCampaign({ type: "story_reply", keywords: [{ keyword: "واو" }], final_text: "STORY {{content_url}}" });
    const meta = new MockMeta();
    await deliver(messagePayload({ text: "واو 😍", storyReply: { id: "story_9" } }), meta);
    expect(meta.sends()).toHaveLength(1);
    expect(meta.sends()[0]).toMatchObject({ kind: "dm", target: "igsid_user_1" });
    expect(meta.sends()[0].text).toBe(`STORY ${SECRET}`);
  });

  it("a plain DM is not treated as a story reply", async () => {
    await seedCampaign({ type: "story_reply", match_all: true, keywords: [] });
    const meta = new MockMeta();
    await deliver(messagePayload({ text: "واو" }), meta);
    expect(meta.sends()).toHaveLength(0);
    expect((await lastEvent()).reason).toBe("plain_message_no_trigger");
  });

  it("story mention: thanks once per event, rate-limited per user, duplicates ignored", async () => {
    await seedCampaign({ type: "story_mention", keywords: [], final_text: "تسلم على المنشن 🙌 {{content_url}}", per_user_cooldown_hours: 24, max_deliveries_per_user: 0 });
    const meta = new MockMeta();
    const p = messagePayload({ storyMention: true, mid: "mention_mid_1" });
    await deliver(p, meta);
    await deliver(p, meta); // duplicate webhook
    await deliver(messagePayload({ storyMention: true }), meta); // second mention within cooldown
    expect(meta.sends()).toHaveLength(1);
    expect(meta.sends()[0].text).toContain("تسلم على المنشن");
    expect((await lastEvent()).reason).toBe("user_cooldown");
  });

  it("a public @mention in a comment only follows comment campaigns — it never opens a DM by itself", async () => {
    await seedCampaign({ type: "story_mention", keywords: [] });
    const meta = new MockMeta();
    await deliver(commentPayload({ text: "@hsn_shop شوفوا" }), meta);
    expect(meta.sends()).toHaveLength(0);
    expect((await lastEvent()).reason).toBe("no_active_campaign");
  });
});

describe("messaging window & uncertain results", () => {
  it("does not send when the 24h window has closed; flow expires", async () => {
    await seedCampaign({ require_follow: true });
    const meta = new MockMeta();
    const clock = { t: Date.now() };
    await deliver(commentPayload({ text: "كورس", time: clock.t }), meta, clock);
    meta.follow = [notFollowing()];
    clock.t += 1000;
    await deliver(messagePayload({ text: "ابدأ", time: clock.t }), meta, clock);
    // 25 hours later the follow request is re-sent? No: simulate a reminder job due after the window
    clock.t += 25 * 3_600_000;
    const [f] = await flowsOf();
    await enqueue(DB, { kind: "send_message", purpose: "reminder", flowId: f.id, campaignId: f.campaign_id, accountId: f.account_id, dedupKey: uid("late_") }, clock.t);
    const before = meta.sends().length;
    await drain(meta, clock);
    expect(meta.sends().length).toBe(before);
    const [f2] = await flowsOf();
    expect(f2.state).toBe("expired");
    expect(f2.state_reason).toBe("messaging_window_closed");
  });

  it("Meta 'outside of allowed window' error expires the flow", async () => {
    await seedCampaign({ type: "story_reply", match_all: true, keywords: [] });
    const meta = new MockMeta();
    meta.dm = "window_closed";
    await deliver(messagePayload({ text: "x", storyReply: { id: "s" } }), meta);
    const [f] = await flowsOf();
    expect(f.state).toBe("expired");
  });

  it("an uncertain send is never retried blindly", async () => {
    await seedCampaign({});
    const meta = new MockMeta();
    meta.privateReply = "uncertain";
    await deliver(commentPayload({ text: "كورس" }), meta);
    await drain(meta);
    expect(meta.sends()).toHaveLength(1);
    const job = await DB.prepare("SELECT status FROM action_jobs WHERE kind = 'send_message'").first<any>();
    expect(job.status).toBe("uncertain");
  });

  it("stale lease after the request started → uncertain; before the request → rescheduled", async () => {
    const now = Date.now();
    await enqueue(DB, { kind: "send_message", purpose: "content", dedupKey: "stale_a" }, now);
    await enqueue(DB, { kind: "follow_check", dedupKey: "stale_b" }, now);
    const a = (await claimNextJob(DB, "w1", now, 1000))!;
    const b = (await claimNextJob(DB, "w1", now, 1000))!;
    await DB.prepare("UPDATE action_jobs SET external_call_started_at = ? WHERE id = ?").bind(now, a.id).run();
    await recoverStaleLeases(DB, now + 5000);
    const rows = (await DB.prepare("SELECT id, status FROM action_jobs ORDER BY id").all<any>()).results;
    expect(rows.find((r) => r.id === a.id).status).toBe("uncertain");
    expect(rows.find((r) => r.id === b.id).status).toBe("retry_scheduled");
  });

  it("rate-limited sends are retried with backoff", async () => {
    await seedCampaign({});
    const meta = new MockMeta();
    meta.privateReply = "rate_limited";
    await deliver(commentPayload({ text: "كورس" }), meta);
    const job = await DB.prepare("SELECT status, run_at FROM action_jobs WHERE kind = 'send_message'").first<any>();
    expect(job.status).toBe("retry_scheduled");
    expect(job.run_at).toBeGreaterThan(Date.now());
  });
});

describe("concurrency", () => {
  it("two workers never claim the same job", async () => {
    const now = Date.now();
    for (let i = 0; i < 10; i++) await enqueue(DB, { kind: "follow_check", dedupKey: `cc_${i}` }, now);
    const claims = await Promise.all(Array.from({ length: 16 }, (_, i) => claimNextJob(DB, `w${i}`, now, 60_000)));
    const ids = claims.filter(Boolean).map((j) => j!.id);
    expect(ids).toHaveLength(10);
    expect(new Set(ids).size).toBe(10);
  });

  it("parallel queue runners deliver content only once", async () => {
    await seedCampaign({});
    const meta = new MockMeta();
    const { parseWebhook } = await import("../src/worker/meta/webhook-parse");
    const { storeEvents } = await import("../src/worker/services/webhook");
    await storeEvents(DB, await parseWebhook(commentPayload({ text: "كورس" })));
    for (let i = 0; i < 4; i++) {
      await Promise.all([runQueue(makeCtx(meta), { owner: "a" }), runQueue(makeCtx(meta), { owner: "b" }), runQueue(makeCtx(meta), { owner: "c" })]);
    }
    expect(meta.sends()).toHaveLength(1);
  });
});

describe("pausing campaigns / disconnecting / global stop", () => {
  it("pausing a campaign cancels its pending jobs and open flows", async () => {
    const id = await seedCampaign({ require_follow: true });
    const meta = new MockMeta();
    const { parseWebhook } = await import("../src/worker/meta/webhook-parse");
    const { storeEvents } = await import("../src/worker/services/webhook");
    await storeEvents(DB, await parseWebhook(commentPayload({ text: "كورس" })));
    await runQueue(makeCtx(meta), { maxJobs: 1 }); // only process_event → opening job pending
    await DB.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").bind(id).run();
    await drain(meta);
    expect(meta.sends()).toHaveLength(0);
    const [f] = await flowsOf();
    expect(f.state).toBe("cancelled");
    expect(f.state_reason).toBe("campaign_not_active");
  });

  it("global automation switch stops processing", async () => {
    await seedCampaign({});
    await DB.prepare("UPDATE app_settings SET value = 'false' WHERE key = 'automation_enabled'").run();
    const meta = new MockMeta();
    await deliver(commentPayload({ text: "كورس" }), meta);
    expect(meta.sends()).toHaveLength(0);
    expect((await lastEvent()).reason).toBe("automation_paused");
  });

  it("auth errors put the account in needs_reauth and stop further sends", async () => {
    await seedCampaign({ type: "story_reply", match_all: true, keywords: [], require_follow: true });
    const meta = new MockMeta();
    meta.follow = [{ result: "temporary_error", fieldPresent: false, errorCode: "190", error: { kind: "auth", message: "token expired" } }];
    await deliver(messagePayload({ text: "x", storyReply: { id: "s" } }), meta);
    const acc = await DB.prepare("SELECT status FROM instagram_accounts").first<any>();
    expect(acc.status).toBe("needs_reauth");
    expect(meta.sends()).toHaveLength(0);
  });
});

describe("routing of control words across campaigns", () => {
  it("'ابدأ' goes to the flow awaiting interaction and does not start another campaign", async () => {
    await seedCampaign({ name: "A", require_follow: true, keywords: [{ keyword: "كورس" }] });
    await seedCampaign({ name: "B", type: "story_reply", keywords: [{ keyword: "ابدأ" }], final_text: "WRONG", final_url: null });
    const meta = new MockMeta();
    await deliver(commentPayload({ text: "كورس" }), meta);
    meta.follow = [following()];
    await deliver(messagePayload({ text: "ابدأ" }), meta);
    expect(meta.sends().some((s) => s.text === "WRONG")).toBe(false);
    expect(meta.sends().filter((s) => s.text?.includes(SECRET))).toHaveLength(1);
  });

  it("button payload tokens are bound to their participant", async () => {
    await seedCampaign({ require_follow: true, type: "story_reply", match_all: true, keywords: [] });
    const meta = new MockMeta();
    meta.follow = [notFollowing()];
    await deliver(messagePayload({ text: "x", storyReply: { id: "s" }, from: "victim" }), meta);
    const payload = meta.sends()[0].msg!.quickReplies![0].payload;
    meta.follow = [following()];
    await deliver(messagePayload({ text: "x", quickReply: payload, from: "attacker" }), meta);
    expect((await lastEvent()).reason).toBe("invalid_button_token");
    expect(meta.sends().some((s) => s.text?.includes(SECRET))).toBe(false);
  });
});

describe("regression: free-text replies while waiting on the follow gate", () => {
  it("a phrase like «تحقق من المتابعة» or any message triggers a fresh check and delivers once following", async () => {
    await seedCampaign({ require_follow: true, verify_cooldown_seconds: 5 });
    const meta = new MockMeta();
    const clock = { t: Date.now() };
    // the user already talked to us → immediate check → not following → follow request as the private reply
    await deliver(messagePayload({ text: "hi", time: clock.t }), meta, clock);
    meta.follow = [notFollowing()];
    clock.t += 1000;
    await deliver(commentPayload({ text: "كورس", time: clock.t }), meta, clock);
    expect((await flowsOf())[0].state).toBe("awaiting_follow");
    expect(meta.sends()[0].kind).toBe("private_reply");

    // full phrase (not the single word) — previously ignored as "plain_message_no_trigger"
    meta.follow = [notFollowing()];
    clock.t += 10_000;
    await deliver(messagePayload({ text: "تحقّق من المتابعة", time: clock.t }), meta, clock);
    expect((await lastEvent()).reason).toBe("verify_requested");
    expect(meta.sends().some((s) => s.text?.includes(SECRET))).toBe(false);

    // arbitrary text after following → fresh check → content exactly once
    meta.follow = [following()];
    clock.t += 10_000;
    await deliver(messagePayload({ text: "خلاص تابعتك الحين", time: clock.t }), meta, clock);
    expect(meta.sends().filter((s) => s.text?.includes(SECRET))).toHaveLength(1);
    expect((await flowsOf())[0].state).toBe("content_sent");
  });

  it("free text within the cooldown schedules one check for the end of the cooldown instead of an immediate extra one", async () => {
    await seedCampaign({ require_follow: true, type: "story_reply", match_all: true, keywords: [], verify_cooldown_seconds: 60 });
    const meta = new MockMeta();
    const clock = { t: Date.now() };
    meta.follow = [notFollowing()];
    await deliver(messagePayload({ text: "واو", storyReply: { id: "s" }, time: clock.t }), meta, clock);
    clock.t += 1000;
    await deliver(messagePayload({ text: "تابعت", time: clock.t }), meta, clock);
    clock.t += 2000;
    await deliver(messagePayload({ text: "طيب", time: clock.t }), meta, clock);
    expect((await lastEvent()).reason).toBe("verify_deferred");
    expect(meta.calls.filter((c) => c.kind === "follow_check")).toHaveLength(2); // scheduled, not run yet
    await deliver(messagePayload({ text: "طيب طيب", time: clock.t }), meta, clock); // more text while one is pending
    expect(meta.calls.filter((c) => c.kind === "follow_check")).toHaveLength(2);
    clock.t += 60_000;
    await drain(meta, clock);
    expect(meta.calls.filter((c) => c.kind === "follow_check")).toHaveLength(3); // exactly one deferred check
  });
});
