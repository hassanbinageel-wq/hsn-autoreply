import type { Env } from "../env";
import { all, getSetting, OWNER_TENANT, run } from "../lib/db";
import { DEFAULT_MESSAGE_TEMPLATES, type MessageTemplates } from "../../shared/messageTemplates";
import { sendOwnerMessage } from "./notify";

const MIN = 60_000;
export const WELCOME_DELAY_MS = 5 * MIN;

/**
 * A thank-you message on the bell of each new customer, about 5 minutes after signing up — using the owner's
 * «شكر» message template. A customer who signed up to pay by card gets it once the plan is active.
 */
export async function runWelcomeMessages(env: Env, now = Date.now()): Promise<number> {
  const due = await all<{ id: number }>(
    env.DB,
    `SELECT id FROM tenants WHERE is_owner = 0 AND welcome_sent_at IS NULL AND plan_id IS NOT NULL
        AND created_at <= ? AND created_at >= ? ORDER BY id LIMIT 20`,
    now - WELCOME_DELAY_MS, now - 3 * 86_400_000,
  );
  if (!due.length) return 0;
  const templates = await getSetting<MessageTemplates>(env.DB, OWNER_TENANT, "message_templates", DEFAULT_MESSAGE_TEMPLATES);
  const t = templates.private?.find((x) => x.label === "شكر") ?? DEFAULT_MESSAGE_TEMPLATES.private.find((x) => x.label === "شكر")!;
  let sent = 0;
  for (const { id } of due) {
    const claimed = await run(env.DB, "UPDATE tenants SET welcome_sent_at = ? WHERE id = ? AND welcome_sent_at IS NULL", now, id);
    if (!claimed.meta.changes) continue;
    await sendOwnerMessage(env, { tenantId: id, title: t.title, body: t.body, link: "/", days: 3 }, now);
    sent++;
  }
  return sent;
}
