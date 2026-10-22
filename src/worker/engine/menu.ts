import { findNode, MENU_PAYLOAD, menuPayload, type DmMenu, type MenuNode } from "../../shared/menu";
import { first, getSetting, run } from "../lib/db";
import type { OutgoingMessage } from "../meta/types";
import { getEntitlement, monthlyMessages } from "../services/plans";
import type { AccountRow, EngineContext, ParticipantRow } from "./context";
import { enqueue } from "./jobs";
import type { EventRow, ProcessOutcome } from "./events";

/**
 * «القائمة التلقائية»: someone who writes to the account (outside a campaign conversation) gets the customer's menu;
 * tapping an option gets that option's reply. Only people who wrote first are answered (inside the 24-hour window),
 * every message sent counts against the plan, and the menu stays quiet for a while after the account replies by hand.
 */

const H = 3_600_000;

export async function loadMenu(db: D1Database, tenantId: number): Promise<DmMenu | null> {
  return getSetting<DmMenu | null>(db, tenantId, "dm_menu", null);
}

/** Why the menu may not answer this person now (null = it may). */
async function blocked(ctx: EngineContext, account: AccountRow, participant: ParticipantRow, menu: DmMenu | null): Promise<string | null> {
  if (!menu?.enabled) return "menu_off";
  const ent = await getEntitlement(ctx.db, account.tenant_id, ctx.now());
  if (!ent.owner && !(ent.active && ent.limits.dm_menu)) return "menu_not_in_plan";
  if (!account.is_demo && ent.limits.monthly_messages !== null && (await monthlyMessages(ctx.db, account.tenant_id, ctx.now())) >= ent.limits.monthly_messages) return "monthly_limit_reached";
  if (menu.pause_hours > 0) {
    const manual = await first<{ at: number }>(
      ctx.db,
      "SELECT MAX(created_at) AS at FROM messages WHERE participant_id = ? AND direction = 'out' AND source IN ('manual','app')",
      participant.id,
    );
    if (manual?.at && ctx.now() - manual.at < menu.pause_hours * H) return "menu_paused_after_manual_reply";
  }
  return null;
}

/** A plain message (no campaign conversation open): send the menu if its trigger rule allows. */
export async function menuForMessage(ctx: EngineContext, row: EventRow, account: AccountRow, participant: ParticipantRow): Promise<ProcessOutcome> {
  const menu = await loadMenu(ctx.db, account.tenant_id);
  const why = await blocked(ctx, account, participant, menu);
  if (why) return { status: "ignored", reason: why === "menu_off" ? "plain_message_no_trigger" : why };
  const last = (participant as ParticipantRow & { menu_sent_at?: number | null }).menu_sent_at ?? null;
  if (menu!.trigger === "first" && last) return { status: "ignored", reason: "menu_already_sent" };
  if (menu!.trigger === "daily" && last && ctx.now() - last < 24 * H) return { status: "ignored", reason: "menu_sent_today" };
  await enqueue(
    ctx.db,
    { kind: "menu_send", accountId: account.id, isDemo: account.is_demo === 1, payload: { participant_id: participant.id, node: menu!.root.key, root: true }, dedupKey: `menu:ev${row.id}` },
    ctx.now(),
  );
  return { status: "processed", reason: "menu_sent" };
}

export const isMenuPayload = (p?: string) => !!p && MENU_PAYLOAD.test(p);

/** A tap on a menu option: send that option's reply (and its own options). */
export async function menuTap(ctx: EngineContext, row: EventRow, payload: string, account: AccountRow, participant: ParticipantRow): Promise<ProcessOutcome> {
  const key = MENU_PAYLOAD.exec(payload)![1];
  const menu = await loadMenu(ctx.db, account.tenant_id);
  const why = await blocked(ctx, account, participant, menu);
  if (why) return { status: "ignored", reason: why === "menu_off" ? "menu_off" : why };
  if (!findNode(menu!.root, key)) return { status: "ignored", reason: "menu_option_removed" };
  await run(
    ctx.db,
    "INSERT INTO dm_menu_taps (tenant_id, node_key, taps, last_at) VALUES (?, ?, 1, ?) ON CONFLICT(tenant_id, node_key) DO UPDATE SET taps = taps + 1, last_at = excluded.last_at",
    account.tenant_id, key, ctx.now(),
  );
  await enqueue(
    ctx.db,
    { kind: "menu_send", accountId: account.id, isDemo: account.is_demo === 1, payload: { participant_id: participant.id, node: key }, dedupKey: `menutap:ev${row.id}` },
    ctx.now(),
  );
  return { status: "processed", reason: "menu_option" };
}

/** The message for one node: its text, its link and its options. */
export function menuMessage(n: MenuNode): OutgoingMessage {
  return {
    text: n.text,
    menu: { style: n.style, options: n.children.map((c) => ({ title: c.label, payload: menuPayload(c.key) })), link: n.link ?? null },
  };
}
