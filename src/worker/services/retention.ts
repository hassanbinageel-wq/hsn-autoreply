import type { Env } from "../env";
import type { AccountRow, EngineContext } from "../engine/context";
import { all, first, getSetting, run } from "../lib/db";

/**
 * Optional follow re-check (setting "follow_recheck_enabled", OFF by default — the owner turns it on knowingly).
 * Re-reads `is_user_follow_business` through the official User Profile API, only for people who already had a
 * successful check (so Instagram had accepted their consent) and who received the campaign content, at most once
 * every N days (setting "follow_recheck_days", default 7) and a few people per customer per hour.
 * A failed read is stored as what it is (unknown / needs interaction) and never as "not following".
 */
export const RECHECK_PER_RUN = 3;

export async function runFollowRecheck(env: Env, ctx: EngineContext, minute: number): Promise<number> {
  const tenants = await all<{ id: number }>(
    env.DB,
    `SELECT t.id FROM tenants t WHERE t.status = 'active' AND (t.id + 31) % 60 = ?
       AND EXISTS (SELECT 1 FROM instagram_accounts a WHERE a.tenant_id = t.id AND a.is_demo = 0 AND a.status = 'active')
     ORDER BY t.id LIMIT 2`,
    minute,
  );
  let done = 0;
  for (const t of tenants) done += await recheckTenant(env, ctx, t.id);
  return done;
}

export async function recheckTenant(env: Env, ctx: EngineContext, tenantId: number): Promise<number> {
  if (!(await getSetting(env.DB, tenantId, "follow_recheck_enabled", false))) return 0;
  const days = Math.min(90, Math.max(1, Number(await getSetting(env.DB, tenantId, "follow_recheck_days", 7)) || 7));
  const account = await first<AccountRow>(env.DB, "SELECT * FROM instagram_accounts WHERE tenant_id = ? AND is_demo = 0 AND status = 'active' ORDER BY id LIMIT 1", tenantId);
  if (!account) return 0;
  const now = ctx.now();
  const due = await all<{ participant_id: number; igsid: string; flow_id: number }>(
    env.DB,
    `SELECT p.id AS participant_id, p.igsid, MAX(f.id) AS flow_id
       FROM participants p JOIN conversation_flows f ON f.participant_id = p.id AND f.state = 'content_sent' AND f.is_demo = 0
      WHERE p.account_id = ? AND p.is_demo = 0
        AND EXISTS (SELECT 1 FROM follow_checks fc WHERE fc.participant_id = p.id AND fc.result IN ('following','not_following'))
        AND COALESCE((SELECT MAX(fc.checked_at) FROM follow_checks fc WHERE fc.participant_id = p.id), 0) < ?
      GROUP BY p.id ORDER BY MAX(f.content_delivered_at) DESC LIMIT ?`,
    account.id,
    now - days * 86_400_000,
    RECHECK_PER_RUN,
  );
  if (!due.length) return 0;
  const token = await ctx.getAccessToken(account);
  if (!token) return 0;
  let n = 0;
  for (const d of due) {
    const o = await ctx.meta(false).checkFollow(token, d.igsid);
    await run(
      env.DB,
      "INSERT INTO follow_checks (flow_id, participant_id, result, field_present, http_status, error_code, is_demo, checked_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)",
      d.flow_id,
      d.participant_id,
      o.result,
      o.fieldPresent ? 1 : 0,
      o.httpStatus ?? null,
      o.errorCode ?? null,
      now,
    );
    if (o.result === "following" || o.result === "not_following") {
      await run(env.DB, "UPDATE participants SET last_follow_status = ?, last_follow_checked_at = ? WHERE id = ?", o.result, now, d.participant_id);
    }
    n++;
    if (o.error?.kind === "auth" || o.error?.kind === "rate_limited") break;
  }
  return n;
}
