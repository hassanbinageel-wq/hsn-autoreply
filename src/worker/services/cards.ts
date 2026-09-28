import { cardDesignSchema, DEFAULT_CARD, fillCard, type CardDesign } from "../../shared/card";
import type { AccountRow, EngineContext } from "../engine/context";
import { MESSAGING_WINDOW_MS, PRIVATE_REPLY_WINDOW_MS } from "../engine/context";
import { randomToken } from "../lib/crypto";
import { first, run } from "../lib/db";
import { DrawFailure, loadDraw } from "./draws";
import { recordMessage } from "./inbox";

export const MAX_CARD_BYTES = 1_500_000;

export interface SendPlan {
  can: boolean;
  channel?: "dm" | "private_reply";
  reason: string;
  window_expires_at?: number | null;
  /** A public reply under the winner's comment has no time window (the only API route left after 7 days). */
  public_reply?: { can: boolean; reason: string; status?: string | null };
}

interface WinnerRow {
  id: number;
  draw_id: number;
  position: number;
  status: string;
  send_status: string | null;
  public_reply_status: string | null;
  comment_id: string;
  author_id: string | null;
  author_username: string | null;
  created_time: number | null;
  source: "comment" | "reply" | "story_reply";
}

async function loadWinner(db: D1Database, drawId: number, winnerId: number): Promise<WinnerRow | null> {
  return first<WinnerRow>(
    db,
    `SELECT w.id, w.draw_id, w.position, w.status, w.send_status, w.public_reply_status, e.comment_id, e.author_id, e.author_username, e.created_time, e.source
       FROM draw_winners w JOIN draw_entries e ON e.id = w.entry_id WHERE w.id = ? AND w.draw_id = ?`,
    winnerId,
    drawId,
  );
}

export async function designFor(db: D1Database, designId: number | null): Promise<CardDesign> {
  if (!designId) return DEFAULT_CARD;
  const row = await first<{ design: string }>(db, "SELECT design FROM card_designs WHERE id = ?", designId);
  if (!row) return DEFAULT_CARD;
  const parsed = cardDesignSchema.safeParse(JSON.parse(row.design));
  return parsed.success ? parsed.data : DEFAULT_CARD;
}

/**
 * What Instagram allows for this winner right now:
 *  1. a DM with the image, if the person messaged the account in the last 24 hours;
 *  2. otherwise, for a comment less than 7 days old that never received a private reply: ONE private reply
 *     (text + a button that opens the card image);
 *  3. otherwise nothing — explained, never attempted.
 */
export async function sendPlan(db: D1Database, w: WinnerRow, now = Date.now()): Promise<SendPlan> {
  if (w.status !== "active") return { can: false, reason: "هذا الفائز مستبدَل" };
  if (w.send_status === "sent") return { can: false, reason: "أُرسلت له البطاقة مسبقًا" };
  if (w.send_status === "sending") return { can: false, reason: "الإرسال قيد التنفيذ" };
  if (!w.author_id) return { can: false, reason: "معرّف الحساب غير متاح من Meta — لا يمكن مراسلته" };
  const p = await first<{ last_user_message_at: number | null }>(
    db,
    "SELECT p.last_user_message_at FROM participants p JOIN instagram_accounts a ON a.id = p.account_id WHERE a.is_demo = 0 AND p.igsid = ? ORDER BY p.last_user_message_at DESC LIMIT 1",
    w.author_id,
  );
  const last = p?.last_user_message_at ?? null;
  if (last && now - last < MESSAGING_WINDOW_MS) {
    return { can: true, channel: "dm", reason: "راسلك خلال آخر 24 ساعة — تُرسل الصورة في الخاص مع رسالة التهنئة", window_expires_at: last + MESSAGING_WINDOW_MS };
  }
  if (w.source === "comment" || w.source === "reply") {
    if (!w.created_time || now - w.created_time > PRIVATE_REPLY_WINDOW_MS) {
      return { can: false, reason: "مرّ أكثر من 7 أيام على تعليقه، ولم يراسلك خلال 24 ساعة — إنستقرام لا يسمح بمراسلته الآن" };
    }
    const used = await first(
      db,
      "SELECT 1 AS x FROM conversation_flows WHERE source_comment_id = ? AND private_reply_status = 'accepted' LIMIT 1",
      w.comment_id,
    );
    const usedByCard = await first(db, "SELECT 1 AS x FROM draw_winners dw JOIN draw_entries de ON de.id = dw.entry_id WHERE de.comment_id = ? AND dw.send_channel = 'private_reply' AND dw.send_status IN ('sent','uncertain') LIMIT 1", w.comment_id);
    if (used || usedByCard) {
      return { can: false, reason: "سبق إرسال رد خاص على تعليقه (إنستقرام يسمح برد خاص واحد لكل تعليق)، ولم يراسلك خلال 24 ساعة" };
    }
    return {
      can: true,
      channel: "private_reply",
      reason: "رد خاص واحد على تعليقه: نص التهنئة + زر «🎁 بطاقة الفوز» يفتح الصورة (إنستقرام لا يسمح بأكثر من رسالة واحدة هنا)",
      window_expires_at: w.created_time + PRIVATE_REPLY_WINDOW_MS,
    };
  }
  return { can: false, reason: "لم يراسلك خلال آخر 24 ساعة — إنستقرام لا يسمح بمراسلته حتى يراسلك مجددًا" };
}

export function publicReplyPlan(w: WinnerRow): NonNullable<SendPlan["public_reply"]> {
  const status = w.public_reply_status;
  if (w.status !== "active") return { can: false, reason: "هذا الفائز مستبدَل", status };
  if (w.source === "story_reply") return { can: false, reason: "ردود الستوري رسائل خاصة وليست تعليقات — لا يوجد تعليق عام للرد عليه", status };
  if (status === "sent") return { can: false, reason: "تم الرد على تعليقه مسبقًا", status };
  if (status === "sending" || status === "uncertain") return { can: false, reason: "الرد السابق غير مؤكد — تحقق من التعليق في إنستقرام", status };
  return { can: true, reason: "رد عام يظهر تحت تعليقه ويصله تنبيه به (بدون حد زمني)", status };
}

export async function planFor(db: D1Database, drawId: number, winnerId: number) {
  const w = await loadWinner(db, drawId, winnerId);
  if (!w) throw new DrawFailure(404, "not_found", "الفائز غير موجود");
  return { ...(await sendPlan(db, w)), public_reply: publicReplyPlan(w) };
}

/**
 * Posts ONE public reply under the winner's comment (manual, confirmed by the owner). Instagram allows replying to
 * comments on your own media without the 7-day private-reply window, so this is the way to reach an older winner:
 * e.g. «مبروك @name! راسلنا على الخاص لاستلام جائزتك» — once they message, the 24h window opens and the card can be sent.
 */
export async function publicReplyToWinner(ctx: EngineContext, drawId: number, winnerId: number, text: string): Promise<void> {
  const db = ctx.db;
  const w = await loadWinner(db, drawId, winnerId);
  if (!w) throw new DrawFailure(404, "not_found", "الفائز غير موجود");
  const plan = publicReplyPlan(w);
  if (!plan.can) throw new DrawFailure(409, "cannot_reply", plan.reason);
  const account = await first<AccountRow>(db, "SELECT * FROM instagram_accounts WHERE is_demo = 0 AND status = 'active' ORDER BY id LIMIT 1");
  if (!account) throw new DrawFailure(409, "no_account", "اربط حساب إنستقرام أولًا");
  const token = await ctx.getAccessToken(account);
  if (!token) throw new DrawFailure(409, "no_token", "التفويض غير متاح — أعد الربط");
  const lock = await run(db, "UPDATE draw_winners SET public_reply_status = 'sending', public_reply_error = NULL WHERE id = ? AND (public_reply_status IS NULL OR public_reply_status = 'failed')", winnerId);
  if (!(lock.meta?.changes ?? 0)) throw new DrawFailure(409, "already", "تم الرد أو هو قيد التنفيذ");
  const r = await ctx.meta(false).replyToComment(token, w.comment_id, text);
  if (!r.ok) {
    if (r.error.kind === "auth") await ctx.onAuthError?.(account, r.error.message);
    const uncertain = r.error.kind === "uncertain";
    await run(db, "UPDATE draw_winners SET public_reply_status = ?, public_reply_error = ? WHERE id = ?", uncertain ? "uncertain" : "failed", r.error.message, winnerId);
    throw new DrawFailure(502, "reply_failed", uncertain ? "انقطع الاتصال — قد يكون الرد نُشر، تحقق من التعليق قبل إعادة المحاولة" : `رفضت Meta الرد: ${r.error.message}`);
  }
  await run(db, "UPDATE draw_winners SET public_reply_status = 'sent', public_reply_at = ?, public_reply_error = NULL WHERE id = ?", ctx.now(), winnerId);
}

/** Stores a rendered card image (JPEG/PNG) for a winner and returns its public token. */
export async function storeCard(db: D1Database, drawId: number, winnerId: number, dataUrl: string, now = Date.now()): Promise<string> {
  const w = await loadWinner(db, drawId, winnerId);
  if (!w) throw new DrawFailure(404, "not_found", "الفائز غير موجود");
  const m = dataUrl.match(/^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=]+)$/);
  if (!m) throw new DrawFailure(422, "bad_image", "صيغة الصورة غير مدعومة");
  const bin = atob(m[2]);
  if (bin.length > MAX_CARD_BYTES) throw new DrawFailure(413, "too_large", "حجم الصورة كبير جدًا");
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const token = randomToken(18);
  await run(db, "INSERT INTO draw_cards (winner_id, token, mime, data, created_at) VALUES (?, ?, ?, ?, ?)", winnerId, token, m[1], bytes, now);
  return token;
}

export async function cardByToken(db: D1Database, token: string): Promise<{ mime: string; data: ArrayBuffer } | null> {
  const row = await first<{ mime: string; data: ArrayBuffer | number[] }>(db, "SELECT mime, data FROM draw_cards WHERE token = ?", token);
  if (!row) return null;
  const data = row.data instanceof ArrayBuffer ? row.data : new Uint8Array(row.data as number[]).buffer;
  return { mime: row.mime, data };
}

/**
 * Sends the latest card of a winner through the channel Instagram allows. One send per winner (atomic status),
 * an interrupted request is marked "uncertain" and never retried blindly.
 */
export async function sendCard(ctx: EngineContext, publicBaseUrl: string, drawId: number, winnerId: number): Promise<{ channel: string }> {
  const db = ctx.db;
  const d = await loadDraw(db, drawId);
  const w = await loadWinner(db, drawId, winnerId);
  if (!d || !w) throw new DrawFailure(404, "not_found", "الفائز غير موجود");
  const plan = await sendPlan(db, w, ctx.now());
  if (!plan.can) throw new DrawFailure(409, "cannot_send", plan.reason);
  const card = await first<{ token: string }>(db, "SELECT token FROM draw_cards WHERE winner_id = ? ORDER BY id DESC LIMIT 1", winnerId);
  if (!card) throw new DrawFailure(409, "no_card", "أنشئ بطاقة الفائز أولًا");
  const account = await first<AccountRow & { username: string | null }>(db, "SELECT * FROM instagram_accounts WHERE is_demo = 0 AND status = 'active' ORDER BY id LIMIT 1");
  if (!account) throw new DrawFailure(409, "no_account", "اربط حساب إنستقرام أولًا");
  const token = await ctx.getAccessToken(account);
  if (!token) throw new DrawFailure(409, "no_token", "التفويض غير متاح — أعد الربط");

  const lock = await run(db, "UPDATE draw_winners SET send_status = 'sending', send_error = NULL WHERE id = ? AND (send_status IS NULL OR send_status = 'failed')", winnerId);
  if (!(lock.meta?.changes ?? 0)) throw new DrawFailure(409, "already", "تم الإرسال أو هو قيد التنفيذ");

  const design = await designFor(db, d.card_design_id ?? null);
  const vars = { username: w.author_username, position: w.position, contest: design.title || d.name, account: account.username, drawnAt: d.drawn_at ?? ctx.now(), timezone: d.timezone };
  const text = fillCard(design.message_text, design, vars);
  const url = `${publicBaseUrl.replace(/\/+$/, "")}/c/${card.token}`;
  const meta = ctx.meta(false);
  let r;
  if (plan.channel === "dm") {
    r = meta.sendImage ? await meta.sendImage(token, account.ig_user_id, w.author_id!, url) : null;
    if (r?.ok && text) await meta.sendMessage(token, account.ig_user_id, w.author_id!, { text });
  } else {
    r = await meta.sendPrivateReply(token, account.ig_user_id, w.comment_id, {
      text: `${text}\n${url}`,
      linkButton: { title: "🎁 بطاقة الفوز", url, text: text || "مبروك الفوز 🎉" },
    });
  }
  const now = ctx.now();
  if (!r || !r.ok) {
    const kind = r && !r.ok ? r.error.kind : "permanent";
    const msg = r && !r.ok ? r.error.message : "الإرسال غير مدعوم";
    if (r && !r.ok && r.error.kind === "auth") await ctx.onAuthError?.(account, msg);
    await run(db, "UPDATE draw_winners SET send_status = ?, send_channel = ?, send_error = ? WHERE id = ?", kind === "uncertain" ? "uncertain" : "failed", plan.channel, msg, winnerId);
    throw new DrawFailure(502, "send_failed", kind === "uncertain" ? "انقطع الاتصال — قد تكون الرسالة وصلت، تحقق من المحادثة قبل إعادة المحاولة" : `رفضت Meta الإرسال: ${msg}`);
  }
  await run(db, "UPDATE draw_winners SET send_status = 'sent', send_channel = ?, sent_at = ?, send_error = NULL WHERE id = ?", plan.channel, now, winnerId);
  const p = await first<{ id: number }>(db, "SELECT id FROM participants WHERE account_id = ? AND igsid = ?", account.id, w.author_id);
  if (p) {
    await recordMessage(db, { accountId: account.id, participantId: p.id, direction: "out", source: "manual", kind: "draw_card", text: `🎁 بطاقة الفوز\n${text}`, mid: r.data.message_id ?? null, at: now });
  }
  return { channel: plan.channel! };
}
