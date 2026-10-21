import type { Env } from "../env";
import { all, first, getSetting, OWNER_TENANT, run } from "../lib/db";
import { notify } from "./notify";
import { ATTACH_IMAGE, ATTACH_IMAGE_BYTES, ATTACH_VIDEO, ATTACH_VIDEO_BYTES, STATES, ticketNo, type TicketState } from "../../shared/support";

/**
 * Support center: tickets (type, state, priority, one optional file per message in R2), the FAQ with video
 * links, canned replies and the owner's notices (expected response time, a service-wide incident banner).
 */

export { CATEGORIES, PRIORITIES, STATES, ticketNo, type TicketState } from "../../shared/support";
/** Files on a ticket: an image up to 5 MB or a video up to 25 MB. */
export const ATTACH = {
  image: ATTACH_IMAGE,
  video: ATTACH_VIDEO,
  imageBytes: ATTACH_IMAGE_BYTES,
  videoBytes: ATTACH_VIDEO_BYTES,
  /** Files are removed this long after the ticket is resolved. */
  keepAfterCloseMs: 30 * 86_400_000,
};
export const attachLimit = (mime: string) => (ATTACH.image.includes(mime) ? ATTACH.imageBytes : ATTACH.video.includes(mime) ? ATTACH.videoBytes : 0);
const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "video/mp4": "mp4", "video/quicktime": "mov" };
export const attachKey = (tenantId: number, ticketId: number, messageId: number, token: string, mime: string) => `sup-t${tenantId}-k${ticketId}-m${messageId}-${token}.${EXT[mime] ?? "bin"}`;

/** Moves a ticket to a state; keeps the old open/closed column and the close time in step. */
export async function setState(db: D1Database, ticketId: number, state: TicketState, now = Date.now()): Promise<void> {
  await run(
    db,
    `UPDATE support_threads SET state = ?, status = ?, closed_at = CASE WHEN ? = 'resolved' THEN COALESCE(closed_at, ?) ELSE NULL END, updated_at = ? WHERE id = ?`,
    state, state === "resolved" ? "closed" : "open", state, now, now, ticketId,
  );
}

/** A customer's message reopens a resolved ticket and puts a waiting one back with the team. */
export const stateAfterCustomer = (cur: string): TicketState => (cur === "new" ? "new" : "in_progress");

/** Tells the customer about a new state of their ticket (bell + Telegram when set up). */
export async function notifyState(env: Env, t: { id: number; tenant_id: number; subject: string }, state: TicketState): Promise<void> {
  const line = state === "resolved" ? "✅ تم حل طلبك" : state === "waiting" ? "⏳ طلبك بانتظار ردك" : state === "in_progress" ? "🛠️ طلبك قيد المعالجة" : "📥 استلمنا طلبك";
  await notify(env, t.tenant_id, "support_reply", `${line} رقم ${ticketNo(t.id)}: ${t.subject}`, undefined, { link: `/support?thread=${t.id}` });
}

export interface Incident {
  active: boolean;
  text: string;
  tone: "info" | "warn" | "bad";
}
export const DEFAULT_RESPONSE_TIME = "نرد عادةً خلال 24 ساعة في أيام العمل.";

/** What the help widget needs: the FAQ, the expected response time and the incident banner. */
export async function supportCenter(db: D1Database) {
  const [sections, faq, responseTime, incident] = await Promise.all([
    all<{ id: number; title: string }>(db, "SELECT id, title FROM support_faq_sections ORDER BY sort, id LIMIT 50"),
    all<{ id: number; question: string; answer: string; video_url: string | null; section_id: number | null }>(db, "SELECT id, question, answer, video_url, section_id FROM support_faq WHERE active = 1 ORDER BY sort, id LIMIT 300"),
    getSetting<string>(db, OWNER_TENANT, "support_response_time", ""),
    getSetting<Incident | null>(db, OWNER_TENANT, "support_incident", null),
  ]);
  return { sections, faq, response_time: responseTime || DEFAULT_RESPONSE_TIME, incident: incident?.active && incident.text ? incident : null };
}

/** Removes the files of tickets resolved more than 30 days ago (daily). Returns how many were removed. */
export async function cleanupSupportFiles(env: Env, now = Date.now()): Promise<number> {
  const rows = await all<{ id: number; att_key: string }>(
    env.DB,
    `SELECT m.id, m.att_key FROM support_messages m JOIN support_threads t ON t.id = m.thread_id
      WHERE m.att_key IS NOT NULL AND m.att_deleted_at IS NULL AND t.state = 'resolved' AND t.closed_at IS NOT NULL AND t.closed_at < ? LIMIT 200`,
    now - ATTACH.keepAfterCloseMs,
  );
  for (const r of rows) {
    await env.MEDIA?.delete(r.att_key).catch(() => undefined);
    await run(env.DB, "UPDATE support_messages SET att_deleted_at = ? WHERE id = ?", now, r.id);
  }
  return rows.length;
}

/** Removes every support file of a customer (before their data is deleted). */
export async function deleteTenantSupportFiles(env: Env, tenantId: number): Promise<void> {
  const rows = await all<{ att_key: string }>(
    env.DB,
    "SELECT m.att_key FROM support_messages m JOIN support_threads t ON t.id = m.thread_id WHERE t.tenant_id = ? AND m.att_key IS NOT NULL AND m.att_deleted_at IS NULL",
    tenantId,
  );
  for (const r of rows) await env.MEDIA?.delete(r.att_key).catch(() => undefined);
}

/** The ticket a message belongs to, only when it is the caller's (customer side) — null otherwise. */
export async function ownMessage(db: D1Database, tenantId: number, ticketId: number, messageId: number) {
  return first<{ id: number; sender: string; att_key: string | null; created_at: number }>(
    db,
    "SELECT m.id, m.sender, m.att_key, m.created_at FROM support_messages m JOIN support_threads t ON t.id = m.thread_id WHERE m.id = ? AND t.id = ? AND t.tenant_id = ?",
    messageId, ticketId, tenantId,
  );
}
