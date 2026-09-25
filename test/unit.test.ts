import { describe, expect, it } from "vitest";
import { normalizeText } from "../src/shared/normalize";
import { evaluateMatch, isControlWord, START_WORDS, VERIFY_WORDS } from "../src/shared/match";
import { csvCell, toCsv } from "../src/shared/csv";
import { claimsDelivery, renderTemplate } from "../src/shared/template";
import { canTransition } from "../src/shared/states";
import { decryptSecret, encryptSecret, hashPassword, signMetaBody, verifyMetaSignature, verifyPassword } from "../src/worker/lib/crypto";
import { classifyError, interpretFollowResponse, sanitize } from "../src/worker/meta/client";
import { parseWebhook } from "../src/worker/meta/webhook-parse";
import { backoffMs } from "../src/worker/engine/jobs";
import { campaignInputSchema } from "../src/shared/schemas";
import { commentPayload, messagePayload, IG_ID } from "./helpers";

const enc = new TextEncoder();

describe("Arabic / English normalization", () => {
  it("removes tashkeel, tatweel, extra spaces and punctuation; lowercases English", () => {
    expect(normalizeText("  أبْغَـــى   الكُورْس!!  ")).toBe("أبغى الكورس");
    expect(normalizeText("I Want The COURSE.")).toBe("i want the course");
    expect(normalizeText("كورس،؟")).toBe("كورس");
    expect(normalizeText("٣ كورسات")).toBe("3 كورسات");
  });
  it("optionally unifies alef forms", () => {
    expect(normalizeText("إبدأ آخر", { unifyAlef: true })).toBe("ابدا اخر");
    expect(normalizeText("إبدأ", { unifyAlef: false })).toBe("إبدأ");
  });
  it("strips emoji and zero-width characters", () => {
    expect(normalizeText("كورس🔥‏")).toBe("كورس");
  });
});

describe("keyword matching", () => {
  const cfg = (keywords: any[], matchAll = false) => ({ matchAll, keywords, normalize: { unifyAlef: true } });
  it("contains / word / exact for Arabic without breaking on \\b", () => {
    expect(evaluateMatch("أبغى الكورس", cfg([{ keyword: "كورس", kind: "include", matchType: "contains" }])).matched).toBe(true);
    expect(evaluateMatch("أبغى الكورس", cfg([{ keyword: "كورس", kind: "include", matchType: "word" }])).matched).toBe(false);
    expect(evaluateMatch("أبغى كورس لو سمحت", cfg([{ keyword: "كورس", kind: "include", matchType: "word" }])).matched).toBe(true);
    expect(evaluateMatch("كورس", cfg([{ keyword: "كورس", kind: "include", matchType: "exact" }])).matched).toBe(true);
    expect(evaluateMatch("كورس؟", cfg([{ keyword: "كُورس", kind: "include", matchType: "exact" }])).matched).toBe(true);
    expect(evaluateMatch("كورس حلو", cfg([{ keyword: "كورس", kind: "include", matchType: "exact" }])).matched).toBe(false);
  });
  it("multi-word phrases and English case-insensitivity", () => {
    const c = cfg([{ keyword: "free course", kind: "include", matchType: "word" }]);
    expect(evaluateMatch("I want the FREE course please", c).matched).toBe(true);
    expect(evaluateMatch("free courses", c).matched).toBe(false);
    expect(evaluateMatch("coursework", cfg([{ keyword: "course", kind: "include", matchType: "word" }])).matched).toBe(false);
  });
  it("multiple keywords and exclusions (exclusions win, also in match-all mode)", () => {
    const c = cfg([
      { keyword: "كورس", kind: "include", matchType: "contains" },
      { keyword: "دورة", kind: "include", matchType: "contains" },
      { keyword: "سعر", kind: "exclude", matchType: "contains" },
    ]);
    expect(evaluateMatch("ابغى الدورة", c)).toMatchObject({ matched: true, keyword: "دورة" });
    expect(evaluateMatch("كم سعر الكورس", c)).toMatchObject({ matched: false, reason: "excluded_keyword" });
    expect(evaluateMatch("اي شي", cfg([{ keyword: "سبام", kind: "exclude", matchType: "contains" }], true)).matched).toBe(true);
    expect(evaluateMatch("سبام", cfg([{ keyword: "سبام", kind: "exclude", matchType: "contains" }], true)).matched).toBe(false);
    expect(evaluateMatch("مرحبا", c).reason).toBe("no_keyword_match");
  });
  it("control words", () => {
    expect(isControlWord("إبدأ", START_WORDS)).toBe(true);
    expect(isControlWord(" ابدا ", START_WORDS)).toBe(true);
    expect(isControlWord("تحقّق!", VERIFY_WORDS)).toBe(true);
    expect(isControlWord("ابدأ الكورس", START_WORDS)).toBe(false);
  });
});

describe("Meta webhook signature (X-Hub-Signature-256)", () => {
  const body = JSON.stringify({ object: "instagram", entry: [] });
  it("accepts a correct signature over the raw body", async () => {
    const sig = await signMetaBody(body, "secret");
    expect(await verifyMetaSignature(enc.encode(body), sig, "secret")).toBe(true);
  });
  it("rejects wrong secret, tampered body, missing or malformed header", async () => {
    const sig = await signMetaBody(body, "secret");
    expect(await verifyMetaSignature(enc.encode(body), sig, "other")).toBe(false);
    expect(await verifyMetaSignature(enc.encode(body + " "), sig, "secret")).toBe(false);
    expect(await verifyMetaSignature(enc.encode(body), null, "secret")).toBe(false);
    expect(await verifyMetaSignature(enc.encode(body), "sha1=abc", "secret")).toBe(false);
  });
});

describe("secrets", () => {
  it("hashes and verifies passwords with a pepper", async () => {
    const h = await hashPassword("correct horse battery", "pep", 1000);
    expect(h.startsWith("pbkdf2$1000$")).toBe(true);
    expect(await verifyPassword("correct horse battery", h, "pep")).toBe(true);
    expect(await verifyPassword("wrong", h, "pep")).toBe(false);
    expect(await verifyPassword("correct horse battery", h, "other-pepper")).toBe(false);
  });
  it("encrypts tokens with AES-GCM bound to the account id", async () => {
    const key = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY";
    const e = await encryptSecret("IGAAtoken", key, "ig-token:1");
    expect(e.ciphertext).not.toContain("IGAAtoken");
    expect(await decryptSecret(e.ciphertext, e.iv, key, "ig-token:1")).toBe("IGAAtoken");
    await expect(decryptSecret(e.ciphertext, e.iv, key, "ig-token:2")).rejects.toThrow();
  });
  it("sanitizes tokens out of error messages", () => {
    expect(sanitize("bad url ?access_token=IGQVJabc123&x=1")).not.toContain("IGQVJabc123");
  });
});

describe("CSV export", () => {
  it("neutralizes formula injection and escapes quotes", () => {
    expect(csvCell("=HYPERLINK(\"x\")")).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell("+1")).toBe(`"'+1"`);
    expect(csvCell("-2")).toBe(`"'-2"`);
    expect(csvCell("@cmd")).toBe(`"'@cmd"`);
    expect(csvCell("كورس")).toBe(`"كورس"`);
    expect(toCsv(["a"], [{ a: "=1+1" }])).toContain(`"'=1+1"`);
  });
});

describe("templates", () => {
  it("renders variables with fallbacks and detects delivery claims", () => {
    expect(renderTemplate("هلا {{username|يا غالي}}", {})).toBe("هلا يا غالي");
    expect(renderTemplate("هلا {{username|يا غالي}}", { username: "sara" })).toBe("هلا sara");
    expect(claimsDelivery("أرسلت لك المحتوى")).toBe(true);
    expect(claimsDelivery("شيّك الخاص لإكمال الخطوات 🙌")).toBe(false);
  });
});

describe("state machine", () => {
  it("allows only defined transitions", () => {
    expect(canTransition("awaiting_follow", "checking_follow")).toBe(true);
    expect(canTransition("awaiting_follow", "content_sent")).toBe(false);
    expect(canTransition("content_sent", "delivering")).toBe(false);
  });
});

describe("Meta error classification & follow interpretation", () => {
  it("classifies common Graph errors", () => {
    expect(classifyError(429, {}).kind).toBe("rate_limited");
    expect(classifyError(400, { error: { code: 4 } }).kind).toBe("rate_limited");
    expect(classifyError(400, { error: { code: 190 } }).kind).toBe("auth");
    expect(classifyError(400, { error: { code: 10, error_subcode: 2534022, message: "This message is sent outside of allowed window." } }).kind).toBe("window_closed");
    expect(classifyError(400, { error: { code: 230, message: "User consent is required" } }).kind).toBe("no_consent");
    expect(classifyError(500, { error: { code: 2 } }).kind).toBe("retryable");
    expect(classifyError(400, { error: { code: 100 } }).kind).toBe("permanent");
  });
  it("never maps a missing field or an error to not_following", () => {
    expect(interpretFollowResponse({ ok: true, httpStatus: 200, data: { is_user_follow_business: true } }).result).toBe("following");
    expect(interpretFollowResponse({ ok: true, httpStatus: 200, data: { is_user_follow_business: false } }).result).toBe("not_following");
    expect(interpretFollowResponse({ ok: true, httpStatus: 200, data: { username: "x" } }).result).toBe("unknown");
    expect(interpretFollowResponse({ ok: false, error: { kind: "no_consent", message: "" } }).result).toBe("needs_interaction");
    expect(interpretFollowResponse({ ok: false, error: { kind: "retryable", message: "" } }).result).toBe("temporary_error");
    expect(interpretFollowResponse({ ok: false, error: { kind: "permission", message: "" } }).result).toBe("unsupported");
    expect(interpretFollowResponse({ ok: false, error: { kind: "permanent", message: "" } }).result).toBe("unknown");
  });
});

describe("webhook parsing (official Instagram payload shapes)", () => {
  it("parses comments with parent ids", async () => {
    const [e] = await parseWebhook(commentPayload({ text: "كورس", commentId: "c1", parentId: "p1" }));
    expect(e).toMatchObject({ kind: "comment", dedupKey: "comment:c1", accountIgId: IG_ID, commentId: "c1", parentId: "p1", mediaId: "media_1" });
  });
  it("distinguishes story replies, story mentions, quick replies, postbacks, echoes and plain DMs", async () => {
    expect((await parseWebhook(messagePayload({ text: "واو", storyReply: { id: "st1" } })))[0]).toMatchObject({ kind: "story_reply", storyId: "st1" });
    expect((await parseWebhook(messagePayload({ storyMention: true })))[0].kind).toBe("story_mention");
    expect((await parseWebhook(messagePayload({ text: "x", quickReply: "hsn:v1:verify:abc" })))[0]).toMatchObject({ kind: "quick_reply", buttonPayload: "hsn:v1:verify:abc" });
    expect((await parseWebhook(messagePayload({ postback: "hsn:v1:verify:abc" })))[0].kind).toBe("postback");
    expect((await parseWebhook(messagePayload({ text: "x", echo: true })))[0].kind).toBe("echo");
    expect((await parseWebhook(messagePayload({ text: "مرحبا" })))[0].kind).toBe("message");
  });
  it("treats public mentions / tags (non-messaging changes) as unsupported, never as DM triggers", async () => {
    const [e] = await parseWebhook({ object: "instagram", entry: [{ id: IG_ID, time: 1, changes: [{ field: "mentions", value: { media_id: "m", comment_id: "c" } }] }] });
    expect(e.kind).toBe("other");
  });
  it("ignores non-instagram objects", async () => {
    expect(await parseWebhook({ object: "page", entry: [] })).toEqual([]);
  });
});

describe("backoff", () => {
  it("grows exponentially with jitter and respects Retry-After", () => {
    expect(backoffMs(1, undefined, () => 0.5)).toBe(30_000);
    expect(backoffMs(3, undefined, () => 0.5)).toBe(120_000);
    expect(backoffMs(20, undefined, () => 0.5)).toBe(3_600_000);
    expect(backoffMs(1, 600_000, () => 0.5)).toBe(600_000);
  });
});

describe("campaign validation", () => {
  const base = { name: "x", type: "comment", keywords: [{ keyword: "كورس", kind: "include", match_type: "contains" }], final_text: "hi" };
  it("rejects putting the final URL in the opening message", () => {
    const r = campaignInputSchema.safeParse({ ...base, final_url: "https://x.com/secret", opening_text: "خذ https://x.com/secret" });
    expect(r.success).toBe(false);
  });
  it("requires keywords unless match-all", () => {
    expect(campaignInputSchema.safeParse({ ...base, keywords: [] }).success).toBe(false);
    expect(campaignInputSchema.safeParse({ ...base, keywords: [], match_all: true }).success).toBe(true);
  });
});
