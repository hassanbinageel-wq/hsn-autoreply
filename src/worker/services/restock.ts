import type { Env } from "../env";
import { MESSAGING_WINDOW_MS, type AccountRow } from "../engine/context";
import { all, first, run } from "../lib/db";
import { sanitize } from "../meta/client";
import type { OutgoingMessage } from "../meta/types";
import { contentLinkButton, renderTemplate } from "../../shared/template";
import { getAccessToken, metaClient } from "./account";
import { recordMessage } from "./inbox";

/**
 * "Tell me when it's back": a person who got the out-of-stock reply answers «بلغني» themselves; when the product
 * returns they get one message — only while Instagram's 24-hour window from their own last message is open
 * (Meta policy: no message outside the window, no first message to someone who did not write). Otherwise the
 * request is closed and the merchant sees it in the campaign's numbers.
 */

const ASK = /(^|\s)(بلغني|بلغوني|ابلغني|ابلغوني|نبهني|نبهوني|ذكرني|notify me)(\s|$|[.!،])/;
const norm = (t: string) => t.toLowerCase().replace(/[ًٌٍَُِّْـ]/g, "").replace(/[أإآ]/g, "ا").trim();

export const BACK_IN_STOCK_TEXT = "أبشرك {{username|يا غالي}} 🎉 المنتج اللي طلبته رجع متوفر! اطلبه من هنا قبل لا يخلص 👇";

/** Called for every incoming message: records a waitlist request when the person asks to be told. */
export async function joinWaitlist(db: D1Database, participantId: number, text: string | null | undefined, at: number): Promise<boolean> {
  if (!text || !ASK.test(norm(text))) return false;
  const flow = await first<{ campaign_id: number; tenant_id: number; account_id: number }>(
    db,
    `SELECT f.campaign_id, c.tenant_id, f.account_id FROM conversation_flows f JOIN campaigns c ON c.id = f.campaign_id
      WHERE f.participant_id = ? AND f.is_demo = 0 AND f.created_at >= ? AND c.stock_out_at IS NOT NULL AND c.stock_action = 'waitlist' AND c.deleted_at IS NULL
      ORDER BY f.id DESC LIMIT 1`,
    participantId,
    at - 7 * 86_400_000,
  );
  if (!flow) return false;
  await run(
    db,
    `INSERT INTO restock_waitlist (tenant_id, campaign_id, participant_id, account_id, status, requested_at) VALUES (?, ?, ?, ?, 'waiting', ?)
     ON CONFLICT(campaign_id, participant_id) DO UPDATE SET status = 'waiting', requested_at = excluded.requested_at, ready_at = NULL, done_at = NULL, error = NULL`,
    flow.tenant_id,
    flow.campaign_id,
    participantId,
    flow.account_id,
    at,
  );
  return true;
}

/** Minute cron: sends the back-in-stock messages that became ready, within the call budget. Returns calls made. */
type Send = (token: string, a: AccountRow, igsid: string, msg: OutgoingMessage) => ReturnType<ReturnType<typeof metaClient>["sendMessage"]>;

export async function runRestock(
  env: Env,
  budget: number,
  now = Date.now(),
  deps: { token?: (a: AccountRow) => Promise<string | null>; send?: Send } = {},
): Promise<number> {
  const tokenOf = deps.token ?? ((a: AccountRow) => getAccessToken(env, env.DB, a));
  const send: Send = deps.send ?? ((token, a, igsid, msg) => metaClient(env).sendMessage(token, a.ig_user_id, igsid, msg));
  if (budget < 2) return 0;
  const rows = await all<{ id: number; participant_id: number; account_id: number; campaign_id: number; igsid: string; username: string | null; last_user_message_at: number | null; final_url: string | null }>(
    env.DB,
    `SELECT w.id, w.participant_id, w.account_id, w.campaign_id, p.igsid, p.username, p.last_user_message_at, c.final_url
       FROM restock_waitlist w JOIN participants p ON p.id = w.participant_id JOIN campaigns c ON c.id = w.campaign_id
      WHERE w.status = 'waiting' AND w.ready_at IS NOT NULL AND c.stock_out_at IS NULL ORDER BY w.ready_at LIMIT ?`,
    Math.min(10, budget),
  );
  let calls = 0;
  const tokens = new Map<number, { a: AccountRow; token: string | null }>();
  for (const r of rows) {
    if (calls >= budget - 1) break;
    if (!r.last_user_message_at || now - r.last_user_message_at >= MESSAGING_WINDOW_MS) {
      await run(env.DB, "UPDATE restock_waitlist SET status = 'window_closed', done_at = ? WHERE id = ?", now, r.id);
      continue;
    }
    let t = tokens.get(r.account_id);
    if (!t) {
      const a = await first<AccountRow>(env.DB, "SELECT * FROM instagram_accounts WHERE id = ? AND status = 'active'", r.account_id);
      t = { a: a!, token: a ? await tokenOf(a) : null };
      tokens.set(r.account_id, t);
    }
    if (!t.a || !t.token) {
      await run(env.DB, "UPDATE restock_waitlist SET status = 'failed', error = 'account', done_at = ? WHERE id = ?", now, r.id);
      continue;
    }
    const text = renderTemplate(BACK_IN_STOCK_TEXT, { username: r.username, account_username: t.a.username, account_link: "", content_url: r.final_url ?? "", first_name: null });
    const full = r.final_url ? `${text}\n${r.final_url}` : text;
    calls++;
    const res = await send(t.token, t.a, r.igsid, { text: full, linkButton: contentLinkButton(full, r.final_url) });
    if (res.ok) {
      await run(env.DB, "UPDATE restock_waitlist SET status = 'sent', done_at = ? WHERE id = ?", now, r.id);
      await recordMessage(env.DB, { accountId: t.a.id, participantId: r.participant_id, direction: "out", source: "bot", kind: "restock", text: full, mid: res.data.message_id ?? null, at: now });
    } else {
      // An unclear result is not retried: a second "it's back" message would be a duplicate.
      const closed = res.error.kind === "window_closed";
      await run(env.DB, "UPDATE restock_waitlist SET status = ?, error = ?, done_at = ? WHERE id = ?", closed ? "window_closed" : "failed", sanitize(res.error.message).slice(0, 200), now, r.id);
    }
  }
  return calls;
}

/** Waitlist numbers of one campaign (for the store page). */
export async function waitlistStats(db: D1Database, tenantId: number, campaignId: number) {
  const rows = await all<{ status: string; n: number }>(db, "SELECT status, COUNT(*) AS n FROM restock_waitlist WHERE tenant_id = ? AND campaign_id = ? GROUP BY status", tenantId, campaignId);
  const get = (s: string) => rows.find((r) => r.status === s)?.n ?? 0;
  return { waiting: get("waiting"), sent: get("sent"), window_closed: get("window_closed"), failed: get("failed") };
}
