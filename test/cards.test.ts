import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DB, IG_ID, makeCtx, MockMeta, resetDb, seedAccount, seedCampaign } from "./helpers";
import { fetchBatch, pickNext, winnersOf } from "../src/worker/services/draws";
import { planFor, publicReplyToWinner, sendCard, storeCard } from "../src/worker/services/cards";
import { DEFAULT_CARD, cardDateLine, fillCard, prizeFor } from "../src/shared/card";
import type { CommentItem } from "../src/worker/meta/types";

const BASE = "https://hsn.example.workers.dev";
const SELF = (exports as any).default as { fetch: (r: Request | string, init?: RequestInit) => Promise<Response> };
const PNG_1PX = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const cm = (id: string, from: string, ageMs = 60_000): CommentItem => ({
  id,
  text: "مشاركة",
  timestamp: new Date(Date.now() - ageMs).toISOString(),
  from: { id: from, username: `u_${from}` },
});

async function drawWith(comments: CommentItem[], winners = 1) {
  const cid = await seedCampaign({});
  const now = Date.now();
  const r = await DB.prepare(
    `INSERT INTO draws (campaign_id, name, source_type, media_id, winners_count, exclude_own, excluded_accounts, entry_mode, created_at, updated_at)
     VALUES (?, 'سحب البطاقات', 'media', 'reel_c', ?, 1, '[]', 'per_person', ?, ?) RETURNING id`,
  )
    .bind(cid, winners, now, now)
    .first<{ id: number }>();
  const meta = new MockMeta();
  meta.commentPages["reel_c"] = [comments];
  await fetchBatch(makeCtx(meta), r!.id);
  const p = await pickNext(DB, r!.id, `req_card_${r!.id}`);
  return { drawId: r!.id, winnerId: p.winner_id, meta };
}

beforeEach(async () => {
  await resetDb();
  await seedAccount();
});

describe("card text", () => {
  it("fills variables, prize per position, date line", () => {
    const d = { ...DEFAULT_CARD, prizes: ["آيفون", "سماعة"], message_text: "مبروك {{username}} المركز {{position}}: {{prize}} — {{contest}}" };
    const v = { username: "sara", position: 2, contest: "مسابقة الصيف", account: "hsn.pmt", drawnAt: Date.UTC(2026, 8, 28, 12), timezone: "Asia/Riyadh" };
    expect(fillCard(d.message_text, d, v)).toBe("مبروك @sara المركز الثاني: سماعة — مسابقة الصيف");
    expect(prizeFor(d, 5)).toBe("سماعة"); // positions beyond the list reuse the last prize
    expect(cardDateLine(d, v)).toContain("2026");
    expect(cardDateLine({ ...d, date_mode: "custom", custom_date: "نهاية الشهر", show_day: false }, v)).toBe("نهاية الشهر");
    expect(cardDateLine({ ...d, date_mode: "none" }, v)).toBeNull();
  });
});

describe("what Instagram allows for each winner", () => {
  it("comment < 7 days, no private reply yet → one private reply with a button to the card", async () => {
    const { drawId, winnerId, meta } = await drawWith([cm("c1", "W1")]);
    expect(await planFor(DB, drawId, winnerId)).toMatchObject({ can: true, channel: "private_reply" });
    await expect(sendCard(makeCtx(meta), BASE, drawId, winnerId)).rejects.toMatchObject({ code: "no_card" });
    const token = await storeCard(DB, drawId, winnerId, PNG_1PX);
    const r = await sendCard(makeCtx(meta), BASE, drawId, winnerId);
    expect(r.channel).toBe("private_reply");
    const sent = meta.sends()[0];
    expect(sent).toMatchObject({ kind: "private_reply", target: "c1" });
    expect(sent.msg!.linkButton).toMatchObject({ title: "🎁 بطاقة الفوز", url: `${BASE}/c/${token}` });
    const [w] = await winnersOf(DB, drawId);
    expect(w).toMatchObject({ send_status: "sent", send_channel: "private_reply" });
    // never twice
    expect(await planFor(DB, drawId, winnerId)).toMatchObject({ can: false });
    await expect(sendCard(makeCtx(meta), BASE, drawId, winnerId)).rejects.toMatchObject({ code: "cannot_send" });
    expect(meta.sends()).toHaveLength(1);
  });

  it("messaged in the last 24h → DM with the image + the congratulation text", async () => {
    const { drawId, winnerId, meta } = await drawWith([cm("c2", "W2")]);
    const acc = await DB.prepare("SELECT id FROM instagram_accounts").first<any>();
    await DB.prepare("INSERT INTO participants (account_id, igsid, username, last_user_message_at, created_at, updated_at) VALUES (?, 'W2', 'u_W2', ?, ?, ?)")
      .bind(acc.id, Date.now() - 3_600_000, Date.now(), Date.now())
      .run();
    expect(await planFor(DB, drawId, winnerId)).toMatchObject({ can: true, channel: "dm" });
    await storeCard(DB, drawId, winnerId, PNG_1PX);
    await sendCard(makeCtx(meta), BASE, drawId, winnerId);
    const dms = meta.sends().filter((s) => s.kind === "dm");
    expect(dms[0].text).toMatch(/^\[image\] https:\/\/hsn\.example\.workers\.dev\/c\//);
    expect(dms[1].text).toContain("مبروك");
    const inbox = await DB.prepare("SELECT kind FROM messages").first<any>();
    expect(inbox.kind).toBe("draw_card");
  });

  it("comment older than 7 days, or the comment already got a private reply → not possible, explained", async () => {
    const old = await drawWith([cm("c3", "W3", 8 * 86_400_000)]);
    expect(await planFor(DB, old.drawId, old.winnerId)).toMatchObject({ can: false });
    expect((await planFor(DB, old.drawId, old.winnerId)).reason).toContain("7 أيام");

    await resetDb();
    await seedAccount();
    const x = await drawWith([cm("c4", "W4")]);
    const acc = await DB.prepare("SELECT id FROM instagram_accounts").first<any>();
    const p = await DB.prepare("INSERT INTO participants (account_id, igsid, created_at, updated_at) VALUES (?, 'W4', ?, ?) RETURNING id").bind(acc.id, Date.now(), Date.now()).first<any>();
    const camp = await DB.prepare("SELECT id FROM campaigns").first<any>();
    await DB.prepare(
      `INSERT INTO conversation_flows (account_id, campaign_id, participant_id, trigger_type, source_comment_id, state, start_token, verify_token, private_reply_status, created_at, updated_at)
       VALUES (?, ?, ?, 'comment', 'c4', 'content_sent', 'st_aaaaaaaaaaaaaaaa', 'vt_aaaaaaaaaaaaaaaa', 'accepted', ?, ?)`,
    )
      .bind(acc.id, camp.id, p.id, Date.now(), Date.now())
      .run();
    const plan = await planFor(DB, x.drawId, x.winnerId);
    expect(plan.can).toBe(false);
    expect(plan.reason).toContain("رد خاص واحد");
  });

  it("a rejected send is marked failed (retry allowed); an interrupted one is 'uncertain' and not retried", async () => {
    const { drawId, winnerId, meta } = await drawWith([cm("c5", "W5")]);
    await storeCard(DB, drawId, winnerId, PNG_1PX);
    meta.privateReply = "fail";
    await expect(sendCard(makeCtx(meta), BASE, drawId, winnerId)).rejects.toMatchObject({ code: "send_failed" });
    expect((await winnersOf(DB, drawId))[0].send_status).toBe("failed");
    meta.privateReply = "uncertain";
    await expect(sendCard(makeCtx(meta), BASE, drawId, winnerId)).rejects.toMatchObject({ code: "send_failed" });
    expect((await winnersOf(DB, drawId))[0].send_status).toBe("uncertain");
    await expect(sendCard(makeCtx(meta), BASE, drawId, winnerId)).rejects.toMatchObject({ code: "cannot_send" });
  });

  it("serves the stored card image at its public token URL (and nothing for unknown tokens)", async () => {
    const { drawId, winnerId } = await drawWith([cm("c6", "W6")]);
    const token = await storeCard(DB, drawId, winnerId, PNG_1PX);
    const r = await SELF.fetch(new Request(`${BASE}/c/${token}`));
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Type")).toBe("image/png");
    const bytes = new Uint8Array(await r.arrayBuffer());
    expect([...bytes.slice(1, 4)].map((b) => String.fromCharCode(b)).join("")).toBe("PNG");
    expect((await SELF.fetch(new Request(`${BASE}/c/unknown_token_1234567890`))).status).toBe(404);
    await expect(storeCard(DB, drawId, winnerId, "data:text/html;base64,PGgxPg==")).rejects.toMatchObject({ code: "bad_image" });
  });

  it("stores and serves a realistic ~1.2MB card; rejects anything over the limit", async () => {
    const { drawId, winnerId } = await drawWith([cm("c7", "W7")]);
    const big = new Uint8Array(1_200_000);
    big.set([0xff, 0xd8, 0xff]);
    for (let i = 3; i < big.length; i++) big[i] = (i * 31) & 0xff;
    let bin = "";
    for (let i = 0; i < big.length; i += 0x8000) bin += String.fromCharCode(...big.subarray(i, i + 0x8000));
    const token = await storeCard(DB, drawId, winnerId, `data:image/jpeg;base64,${btoa(bin)}`);
    const r = await SELF.fetch(new Request(`${BASE}/c/${token}`));
    expect(r.status).toBe(200);
    expect((await r.arrayBuffer()).byteLength).toBe(1_200_000);
    const huge = "A".repeat(Math.ceil((1_600_000 * 4) / 3));
    await expect(storeCard(DB, drawId, winnerId, `data:image/jpeg;base64,${huge}`)).rejects.toMatchObject({ code: "too_large" });
  });

  it("after 7 days: no private message, but ONE public reply under the comment is allowed", async () => {
    const { drawId, winnerId, meta } = await drawWith([cm("c8", "W8", 20 * 86_400_000)]);
    const plan = await planFor(DB, drawId, winnerId);
    expect(plan.can).toBe(false);
    expect(plan.public_reply).toMatchObject({ can: true });
    await publicReplyToWinner(makeCtx(meta), drawId, winnerId, "مبروك @u_W8 راسلنا على الخاص");
    expect(meta.sends()).toEqual([{ kind: "public_reply", target: "c8", text: "مبروك @u_W8 راسلنا على الخاص" }]);
    expect((await winnersOf(DB, drawId))[0]).toMatchObject({ public_reply_status: "sent" });
    expect((await planFor(DB, drawId, winnerId)).public_reply).toMatchObject({ can: false });
    await expect(publicReplyToWinner(makeCtx(meta), drawId, winnerId, "مرة ثانية")).rejects.toMatchObject({ code: "cannot_reply" });
    expect(meta.sends()).toHaveLength(1);
  });

  it("a rejected public reply can be retried; an interrupted one is not", async () => {
    const { drawId, winnerId, meta } = await drawWith([cm("c9", "W9")]);
    meta.publicReply = "fail";
    await expect(publicReplyToWinner(makeCtx(meta), drawId, winnerId, "مبروك")).rejects.toMatchObject({ code: "reply_failed" });
    meta.publicReply = "uncertain";
    await expect(publicReplyToWinner(makeCtx(meta), drawId, winnerId, "مبروك")).rejects.toMatchObject({ code: "reply_failed" });
    await expect(publicReplyToWinner(makeCtx(meta), drawId, winnerId, "مبروك")).rejects.toMatchObject({ code: "cannot_reply" });
    expect(meta.sends()).toHaveLength(2);
  });
});
