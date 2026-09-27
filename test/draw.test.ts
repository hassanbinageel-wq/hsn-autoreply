import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DrawError,
  exclusionReason,
  identityKey,
  instagramShortcode,
  pickWinners,
  secureRandomInt,
  summarize,
  type DrawEntry,
  type DrawSettings,
} from "../src/shared/draw";
import { fetchBatch, replaceWinner, runDraw, winnersOf } from "../src/worker/services/draws";
import { DB, IG_ID, makeCtx, MockMeta, resetDb, seedAccount, seedCampaign, deliver, messagePayload } from "./helpers";
import type { CommentItem } from "../src/worker/meta/types";

const BASE = "https://hsn.example.workers.dev";
const SELF = (exports as any).default as { fetch: (r: Request | string, init?: RequestInit) => Promise<Response> };
const call = (path: string, init?: RequestInit) => SELF.fetch(new Request(BASE + path, init));

let seq = 0;
const entry = (author: string | null, o: Partial<DrawEntry> = {}): DrawEntry => ({
  id: ++seq,
  comment_id: `c${seq}`,
  author_id: author,
  author_username: author ? `user_${author}` : null,
  text: "مشاركة",
  created_time: 1_000_000,
  source: "comment",
  ...o,
});
const base: DrawSettings = {
  starts_at: null,
  ends_at: null,
  include_replies: false,
  keyword: null,
  exclude_own: true,
  excluded_accounts: [],
  entry_mode: "per_person",
  allow_repeat_winner: false,
};
const ctx0 = { own_ids: ["OWN"], own_username: "hsn_shop", previous_winner_keys: new Set<string>() };

describe("secure random", () => {
  it("is uniform (chi-square) and rejects biased values", () => {
    const n = 7;
    const counts = new Array(n).fill(0);
    const N = 70_000;
    for (let i = 0; i < N; i++) counts[secureRandomInt(n)]++;
    const exp = N / n;
    const chi = counts.reduce((a, c) => a + (c - exp) ** 2 / exp, 0);
    expect(chi).toBeLessThan(22.46); // p=0.001 critical value for 6 degrees of freedom
    // values in the biased tail (>= floor(2^32/n)*n) are rejected, never folded with modulo
    const seqVals = [0xffffffff, 0xfffffffe, 5];
    expect(secureRandomInt(n, () => seqVals.shift()!)).toBe(5);
  });
});

describe("fairness of the two counting modes", () => {
  const A = Array.from({ length: 10 }, () => entry("A"));
  const B = [entry("B")];
  const trials = 20_000;

  it("one chance per person: 10 comments and 1 comment win equally often", () => {
    let a = 0;
    for (let i = 0; i < trials; i++) if (pickWinners([...A, ...B], base, 1)[0].author_id === "A") a++;
    expect(a / trials).toBeGreaterThan(0.47);
    expect(a / trials).toBeLessThan(0.53);
  });

  it("each comment is a chance: 10 comments win ~10x more often", () => {
    let a = 0;
    for (let i = 0; i < trials; i++) if (pickWinners([...A, ...B], { ...base, entry_mode: "per_comment" }, 1)[0].author_id === "A") a++;
    expect(a / trials).toBeGreaterThan(0.89);
    expect(a / trials).toBeLessThan(0.93);
  });

  it("without repeat winners a person wins once; with repeat, never the same comment twice", () => {
    for (let i = 0; i < 200; i++) {
      const w = pickWinners([...A, ...B], { ...base, entry_mode: "per_comment" }, 2);
      expect(new Set(w.map((x) => x.author_id))).toEqual(new Set(["A", "B"]));
    }
    const three = Array.from({ length: 3 }, () => entry("C"));
    for (let i = 0; i < 100; i++) {
      const w = pickWinners(three, { ...base, entry_mode: "per_comment", allow_repeat_winner: true }, 3);
      expect(new Set(w.map((x) => x.comment_id)).size).toBe(3);
    }
    expect(() => pickWinners(three, { ...base, entry_mode: "per_comment", allow_repeat_winner: true }, 4)).toThrow(DrawError);
  });

  it("one chance per person ignores 'allow repeat' (a person can win only once)", () => {
    const w = pickWinners([...A, ...B], { ...base, allow_repeat_winner: true }, 2);
    expect(new Set(w.map((x) => x.author_id)).size).toBe(2);
    try {
      pickWinners([...A, ...B], { ...base, allow_repeat_winner: true }, 3);
      throw new Error("should fail");
    } catch (e) {
      expect(e).toBeInstanceOf(DrawError);
      expect((e as DrawError).possible).toBe(2);
    }
  });
});

describe("eligibility rules", () => {
  it("replies, time window, keyword (Arabic-normalized), own, manual and previous winners, unknown author", () => {
    const s: DrawSettings = { ...base, starts_at: 100, ends_at: 200, keyword: "مسابقه", excluded_accounts: ["@Blocked_One", "id:X9"] };
    const ctx = { ...ctx0, previous_winner_keys: new Set(["id:PREV"]) };
    expect(exclusionReason(entry("R", { source: "reply", created_time: 150, text: "مسابقة" }), s, ctx)).toBe("reply_excluded");
    expect(exclusionReason(entry("T", { created_time: 50, text: "مسابقة" }), s, ctx)).toBe("before_start");
    expect(exclusionReason(entry("T", { created_time: 250, text: "مسابقة" }), s, ctx)).toBe("after_end");
    expect(exclusionReason(entry("K", { created_time: 150, text: "ما شاء الله" }), s, ctx)).toBe("missing_keyword");
    expect(exclusionReason(entry("K", { created_time: 150, text: "أشارك في المُسابقة 🎉" }), s, ctx)).toBeNull();
    expect(exclusionReason(entry("OWN", { created_time: 150, text: "مسابقة" }), s, ctx)).toBe("own_account");
    expect(exclusionReason(entry("Z", { created_time: 150, text: "مسابقة", author_username: "blocked_one" }), s, ctx)).toBe("excluded_manually");
    expect(exclusionReason(entry("X9", { created_time: 150, text: "مسابقة" }), s, ctx)).toBe("excluded_manually");
    expect(exclusionReason(entry("PREV", { created_time: 150, text: "مسابقة" }), s, ctx)).toBe("previous_winner");
    expect(exclusionReason(entry(null, { created_time: 150, text: "مسابقة" }), s, ctx)).toBe("unknown_author");
    // identity = stable id, not the display name
    expect(identityKey({ author_id: "123", author_username: "renamed" })).toBe("id:123");
  });

  it("summary counts unique people and the maximum possible winners", () => {
    const list = [entry("A"), entry("A"), entry("B"), entry("OWN")];
    const s1 = summarize(list, base, ctx0);
    expect(s1).toMatchObject({ total: 4, unique_people: 2, max_winners: 2 });
    expect(s1.reasons.own_account).toBe(1);
    expect(summarize(list, { ...base, entry_mode: "per_comment", allow_repeat_winner: true }, ctx0).max_winners).toBe(3);
  });

  it("parses post / reel links", () => {
    expect(instagramShortcode("https://www.instagram.com/reel/DAbc123_xY/?igsh=1")).toBe("DAbc123_xY");
    expect(instagramShortcode("https://instagram.com/p/C9zz-1/")).toBe("C9zz-1");
    expect(instagramShortcode("https://example.com/p/abc")).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------

const cm = (id: string, from: string, o: Partial<CommentItem> = {}): CommentItem => ({
  id,
  text: "مشاركة",
  timestamp: new Date(1_700_000_000_000).toISOString(),
  from: { id: from, username: `u_${from}` },
  ...o,
});

async function newDraw(campaignId: number, o: Record<string, unknown> = {}) {
  const now = Date.now();
  const r = await DB.prepare(
    `INSERT INTO draws (campaign_id, name, source_type, media_id, winners_count, include_replies, exclude_own, excluded_accounts, entry_mode, allow_repeat_winner,
       exclude_previous_winners, created_at, updated_at)
     VALUES (?, 'سحب', ?, ?, ?, ?, 1, '[]', ?, ?, ?, ?, ?) RETURNING id`,
  )
    .bind(
      campaignId,
      o.source_type ?? "media",
      o.media_id ?? "reel_1",
      o.winners_count ?? 1,
      o.include_replies ? 1 : 0,
      o.entry_mode ?? "per_person",
      o.allow_repeat_winner ? 1 : 0,
      o.exclude_previous_winners ? 1 : 0,
      now,
      now,
    )
    .first<{ id: number }>();
  return r!.id;
}

describe("fetching participations", () => {
  beforeEach(async () => {
    await resetDb();
    await seedAccount();
  });

  it("follows every page and reply page, never stores a comment twice, resumes after a rate limit", async () => {
    const cid = await seedCampaign({});
    const id = await newDraw(cid, { include_replies: true });
    const meta = new MockMeta();
    meta.commentPages["reel_1"] = [
      [cm("c1", "A", { replies: { data: [cm("r1", "B", { parent_id: "c1" })], paging: { cursors: { after: "c1" }, next: "x" } } }), cm("c2", "B")],
      [cm("c2", "B"), cm("c3", "C")], // c2 repeated across pages → still one entry
      [cm("c4", "A")],
    ];
    meta.replyPages["c1"] = [[], [cm("r2", "D", { parent_id: "c1" })]];
    meta.pickerErrors = [];
    // rate limit after the first page
    const ctx = makeCtx(meta);
    let d = await fetchBatch(ctx, id);
    expect(d.fetch_status).toBe("complete");
    const rows = (await DB.prepare("SELECT comment_id, source FROM draw_entries WHERE draw_id = ? ORDER BY comment_id").bind(id).all<any>()).results;
    expect(rows.map((r) => r.comment_id)).toEqual(["c1", "c2", "c3", "c4", "r1", "r2"]);
    expect(rows.filter((r) => r.source === "reply").length).toBe(2);

    // restart + a rate limit in the middle: partial, error shown, then resume to complete
    meta.pickerErrors = [];
    d = await fetchBatch(ctx, id, { restart: true });
    expect(d.fetch_status).toBe("complete");
    const id2 = await newDraw(cid);
    meta.pickerErrors = [];
    const ctx2 = makeCtx(meta);
    // first page ok, second page rate-limited
    let n = 0;
    const orig = meta.listCommentsPage.bind(meta);
    meta.listCommentsPage = async (t, m, after) => (++n === 2 ? { ok: false, error: { kind: "rate_limited", httpStatus: 429, message: "rate" } } : orig(t, m, after));
    d = await fetchBatch(ctx2, id2);
    expect(d.fetch_status).toBe("partial");
    expect(d.fetch_error).toContain("حد طلبات");
    await expect(runDraw(DB, id2, "req_partial_1")).rejects.toMatchObject({ code: "incomplete_fetch" });
    d = await fetchBatch(ctx2, id2);
    expect(d.fetch_status).toBe("complete");
    expect(d.fetched_count).toBe(6); // 4 comments + 2 replies (replies are stored; the setting decides eligibility)
  });

  it("stories: only replies linked to that story, never mentions or other DMs", async () => {
    const cid = await seedCampaign({ type: "story_reply", match_all: true, keywords: [] });
    const meta = new MockMeta();
    await deliver(messagePayload({ from: "s1", text: "أنا", storyReply: { id: "story_A" } }), meta);
    await deliver(messagePayload({ from: "s2", text: "وأنا", storyReply: { id: "story_A" } }), meta);
    await deliver(messagePayload({ from: "s3", text: "ستوري ثانية", storyReply: { id: "story_B" } }), meta);
    await deliver(messagePayload({ from: "s4", storyMention: true }), meta);
    await deliver(messagePayload({ from: "s5", text: "رسالة عادية" }), meta);
    const id = await newDraw(cid, { source_type: "story", media_id: "story_A" });
    const d = await fetchBatch(makeCtx(meta), id);
    expect(d.fetch_status).toBe("complete");
    const rows = (await DB.prepare("SELECT author_id, source FROM draw_entries WHERE draw_id = ? ORDER BY author_id").bind(id).all<any>()).results;
    expect(rows).toEqual([
      { author_id: "s1", source: "story_reply" },
      { author_id: "s2", source: "story_reply" },
    ]);
  });
});

describe("running the draw, idempotency, replacement", () => {
  beforeEach(async () => {
    await resetDb();
    await seedAccount();
  });

  async function readyDraw(o: Record<string, unknown> = {}, comments?: CommentItem[]) {
    const cid = (o.campaign as number) ?? (await seedCampaign({}));
    const id = await newDraw(cid, o);
    const meta = new MockMeta();
    meta.commentPages[(o.media_id as string) ?? "reel_1"] = [comments ?? [cm("a1", "A"), cm("a2", "A"), cm("b1", "B"), cm("c1", "C"), cm("own", IG_ID)]];
    await fetchBatch(makeCtx(meta), id);
    return { id, cid };
  }

  it("runs once, freezes eligibility, and a resend returns the same result", async () => {
    const { id } = await readyDraw({ winners_count: 2 });
    await runDraw(DB, id, "req_abc_123");
    const w1 = await winnersOf(DB, id);
    expect(w1).toHaveLength(2);
    expect(new Set(w1.map((w) => w.author_id)).size).toBe(2);
    expect(w1.some((w) => w.author_id === IG_ID)).toBe(false); // own account excluded
    expect((await runDraw(DB, id, "req_abc_123")).replay).toBe(true);
    expect(await winnersOf(DB, id)).toEqual(w1);
    await expect(runDraw(DB, id, "req_other_99")).rejects.toMatchObject({ code: "already_drawn" });
    const frozen = await DB.prepare("SELECT COUNT(*) AS n FROM draw_entries WHERE draw_id = ? AND eligible IS NULL").bind(id).first<any>();
    expect(frozen.n).toBe(0);
    const d = await DB.prepare("SELECT status, eligible_count, unique_people FROM draws WHERE id = ?").bind(id).first<any>();
    expect(d).toMatchObject({ status: "drawn", eligible_count: 4, unique_people: 3 });
  });

  it("asks to change the count instead of silently adjusting it", async () => {
    const { id } = await readyDraw({ winners_count: 4 }); // only A, B, C are eligible people
    await expect(runDraw(DB, id, "req_toomany")).rejects.toMatchObject({ code: "not_enough", extra: { possible: 3 } });
    const d = await DB.prepare("SELECT status, winners_count FROM draws WHERE id = ?").bind(id).first<any>();
    expect(d).toMatchObject({ status: "draft", winners_count: 4 });
  });

  it("concurrent run requests: exactly one draw", async () => {
    const { id } = await readyDraw({ winners_count: 1 });
    const results = await Promise.allSettled([runDraw(DB, id, "req_p1_xxxx"), runDraw(DB, id, "req_p2_xxxx"), runDraw(DB, id, "req_p3_xxxx")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await winnersOf(DB, id)).toHaveLength(1);
  });

  it("replacing a winner keeps history, excludes the replaced person, respects repeat rules, and only once", async () => {
    const { id } = await readyDraw({ winners_count: 2 });
    await runDraw(DB, id, "req_rep_1");
    const [first] = await winnersOf(DB, id);
    await replaceWinner(DB, id, first.id, "لم يرد خلال 48 ساعة");
    const all = await winnersOf(DB, id);
    const old = all.find((w) => w.id === first.id)!;
    expect(old).toMatchObject({ status: "replaced", replaced_reason: "لم يرد خلال 48 ساعة" });
    const active = all.filter((w) => w.status === "active");
    expect(active).toHaveLength(2);
    expect(active.map((w) => w.author_id)).not.toContain(first.author_id);
    expect(new Set(active.map((w) => w.author_id)).size).toBe(2);
    expect(active.find((w) => w.position === first.position)).toBeTruthy();
    await expect(replaceWinner(DB, id, first.id, "مرة ثانية")).rejects.toMatchObject({ code: "already_replaced" });
    // A, B, C: two active + one replaced → nobody left
    const second = active[0];
    await expect(replaceWinner(DB, id, second.id, "سبب")).rejects.toMatchObject({ code: "no_substitute" });
  });

  it("can exclude people who already won an earlier draw of the same campaign", async () => {
    const cid = await seedCampaign({});
    const { id: d1 } = await readyDraw({ campaign: cid, winners_count: 2 });
    await runDraw(DB, d1, "req_prev_1");
    const firstWinners = new Set((await winnersOf(DB, d1)).map((w) => w.author_id));
    const { id: d2 } = await readyDraw({ campaign: cid, winners_count: 1, exclude_previous_winners: true });
    await runDraw(DB, d2, "req_prev_2");
    const [w] = await winnersOf(DB, d2);
    expect(firstWinners.has(w.author_id)).toBe(false);
  });
});

describe("draw API", () => {
  beforeEach(async () => {
    await resetDb();
    await seedAccount();
  });

  it("story draw end to end through the API (create, fetch, preview, run, replace, list)", async () => {
    await call("/api/auth/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ setup_token: "test_setup_token_123456", username: "admin", password: "a-very-strong-password" }) });
    const lr = await call("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "a-very-strong-password", client: "app" }) });
    const H = { Authorization: `Bearer ${((await lr.json()) as any).token}`, "Content-Type": "application/json" };
    const cid = await seedCampaign({ type: "story_reply", match_all: true, keywords: [] });
    const meta = new MockMeta();
    for (const u of ["p1", "p2", "p3"]) await deliver(messagePayload({ from: u, text: "مشاركة", storyReply: { id: "story_X" } }), meta);

    const bad = await call(`/api/campaigns/${cid}/draws`, { method: "POST", headers: H, body: JSON.stringify({ name: "س", source_type: "story", media_id: "unknown_story", winners_count: 1 }) });
    expect(bad.status).toBe(404);
    const cr = await call(`/api/campaigns/${cid}/draws`, { method: "POST", headers: H, body: JSON.stringify({ name: "سحب الستوري", source_type: "story", media_id: "story_X", winners_count: 2 }) });
    expect(cr.status).toBe(200);
    const { id } = (await cr.json()) as any;
    const early = await call(`/api/draws/${id}/run`, { method: "POST", headers: H, body: JSON.stringify({ request_id: "req_early_01" }) });
    expect(early.status).toBe(409);
    const f = (await (await call(`/api/draws/${id}/fetch`, { method: "POST", headers: H, body: "{}" })).json()) as any;
    expect(f).toMatchObject({ fetch_status: "complete", fetched_count: 3 });
    const g = (await (await call(`/api/draws/${id}`, { headers: H })).json()) as any;
    expect(g.preview).toMatchObject({ total: 3, eligible_count: 3, unique_people: 3, max_winners: 3 });
    const r = (await (await call(`/api/draws/${id}/run`, { method: "POST", headers: H, body: JSON.stringify({ request_id: "req_run_0001" }) })).json()) as any;
    expect(r.winners).toHaveLength(2);
    const again = (await (await call(`/api/draws/${id}/run`, { method: "POST", headers: H, body: JSON.stringify({ request_id: "req_run_0001" }) })).json()) as any;
    expect(again.replay).toBe(true);
    const rep = await call(`/api/draws/${id}/winners/${r.winners[0].id}/replace`, { method: "POST", headers: H, body: JSON.stringify({ reason: "تواصل ولم يرد" }) });
    expect(rep.status).toBe(200);
    const edit = await call(`/api/draws/${id}`, { method: "PUT", headers: H, body: JSON.stringify({ name: "x", source_type: "story", media_id: "story_X", winners_count: 1 }) });
    expect(edit.status).toBe(409); // settings frozen after the draw
    const list = (await (await call(`/api/campaigns/${cid}/draws`, { headers: H })).json()) as any[];
    expect(list[0]).toMatchObject({ id, status: "drawn", active_winners: 2 });
  });
});
