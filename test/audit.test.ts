import { beforeEach, describe, expect, it } from "vitest";
import { commentPayload, DB, deliver, drain, IG_ID, makeCtx, MockMeta, resetDb, seedAccount, seedCampaign } from "./helpers";
import { auditCampaignComments } from "../src/worker/services/audit";

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "+0000");

beforeEach(async () => {
  await resetDb();
  await seedAccount();
});

describe("campaign comment check", () => {
  it("finds who was answered, who was not and who never reached us, and imports the missed ones once", async () => {
    const id = await seedCampaign({ scope: "selected", media_ids: ["media_A"] });
    const meta = new MockMeta();
    await deliver(commentPayload({ text: "كورس", commentId: "seen_1", mediaId: "media_A", from: "u_seen" }), meta);
    await deliver(commentPayload({ text: "ماشاء الله", commentId: "nomatch_1", mediaId: "media_A", from: "u_nm" }), meta);
    const now = Date.now();
    meta.commentPages["media_A"] = [
      [
        { id: "seen_1", text: "كورس", timestamp: iso(now - 50_000), from: { id: "u_seen", username: "seen" } },
        { id: "nomatch_1", text: "ماشاء الله", timestamp: iso(now - 40_000), from: { id: "u_nm", username: "nm" } },
        {
          id: "missed_1",
          text: "أبغى الكورس",
          timestamp: iso(now - 30_000),
          from: { id: "u_missed", username: "missed" },
          // our own public reply under it is not a participant
          replies: { data: [{ id: "own_r", text: "أرسلنا لك", timestamp: iso(now - 20_000), from: { id: IG_ID, username: "hsn_shop" } }] },
        },
      ],
      [{ id: "old_1", text: "كورس", timestamp: iso(now - 8 * 86_400_000), from: { id: "u_old", username: "old" } }],
    ];
    const r = (await auditCampaignComments(makeCtx(meta), 1, id))!;
    expect(r.checked).toBe(4);
    expect(r.counts).toEqual({ replied: 1, in_progress: 0, not_replied: 1, missing: 1, missing_old: 1 });
    expect(r.items.find((i) => i.comment_id === "nomatch_1")!.reason).toBeTruthy();
    expect(r.imported).toBe(0);
    expect(meta.sends().filter((s) => s.kind === "private_reply")).toHaveLength(1);

    const r2 = (await auditCampaignComments(makeCtx(meta), 1, id, { importMissing: true }))!;
    expect(r2.imported).toBe(1); // only the one inside the 7-day window
    await drain(meta);
    expect(meta.sends().filter((s) => s.kind === "private_reply").map((s) => s.target)).toEqual(["seen_1", "missed_1"]);
    const r3 = (await auditCampaignComments(makeCtx(meta), 1, id, { importMissing: true }))!;
    expect(r3.imported).toBe(0);
    expect(r3.counts.replied).toBe(2);
    expect(r3.counts.missing).toBe(0);
  });

  it("leaves out your own replies and counts people already answered as answered; one post can be checked alone", async () => {
    const id = await seedCampaign({ scope: "selected", media_ids: ["media_A", "media_B"] });
    const meta = new MockMeta();
    await deliver(commentPayload({ text: "كورس", commentId: "c1", mediaId: "media_A", from: "u1", username: "one" }), meta);
    await deliver(commentPayload({ text: "كورس مرة ثانية", commentId: "c2", mediaId: "media_A", from: "u1", username: "one" }), meta);
    // your reply typed in the Instagram app: the webhook named your account, the comments list shows another id
    await deliver(commentPayload({ text: "تم ارسلنا لك", commentId: "mine", mediaId: "media_A", from: "other_form_of_my_id", username: "hsn_shop" }), meta);
    await drain(meta);
    const now = Date.now();
    meta.commentPages["media_A"] = [[
      { id: "c1", text: "كورس", timestamp: iso(now - 50_000), from: { id: "u1", username: "one" } },
      { id: "c2", text: "كورس مرة ثانية", timestamp: iso(now - 40_000), from: { id: "u1", username: "one" } },
      { id: "mine", text: "تم ارسلنا لك", timestamp: iso(now - 30_000), from: { id: "other_form_of_my_id" } },
    ]];
    meta.commentPages["media_B"] = [[{ id: "b1", text: "كورس", timestamp: iso(now - 10_000), from: { id: "u9", username: "nine" } }]];
    const r = (await auditCampaignComments(makeCtx(meta), 1, id))!;
    expect(r.checked).toBe(3);
    expect(r.counts).toMatchObject({ replied: 2, not_replied: 0, missing: 1 });
    expect(r.items.find((i) => i.comment_id === "c2")!.reason).toBe("already_replied");
    expect(r.posts.map((p) => [p.media_id, p.read, p.complete])).toEqual([["media_A", 3, true], ["media_B", 1, true]]);
    const one = (await auditCampaignComments(makeCtx(meta), 1, id, { mediaId: "media_B" }))!;
    expect(one.items.map((i) => i.comment_id)).toEqual(["b1"]);
    expect((await auditCampaignComments(makeCtx(meta), 1, id, { mediaId: "someone_elses" }))!.error).toBe("media_not_in_campaign");
  });

  it("is scoped to the customer: another tenant cannot check this campaign", async () => {
    const id = await seedCampaign({ scope: "selected", media_ids: ["media_A"] });
    const now = Date.now();
    await DB.prepare("INSERT INTO tenants (name, status, created_at, updated_at) VALUES ('ب', 'active', ?, ?)").bind(now, now).run().catch(() => undefined);
    const meta = new MockMeta();
    expect(await auditCampaignComments(makeCtx(meta), 999, id)).toBeNull();
    expect(meta.calls.filter((c) => c.kind === "list_comments")).toHaveLength(0);
  });
});
