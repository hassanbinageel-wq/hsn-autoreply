import { createApp } from "./app";
import { runFollowRecheck } from "./services/retention";
import { runInsights } from "./services/insights";
import { cleanupScheduledFiles, runPublisher } from "./services/publish";
import { refreshStoreTokens } from "./services/salla";
import type { Env } from "./env";
import { all, getSetting, OWNER_TENANT, run } from "./lib/db";
import { runQueue } from "./engine/executor";
import { engineContext, refreshAccountProfiles, refreshExpiringTokens } from "./services/account";
import { sanitize } from "./meta/client";
import { remindExpiringSubscriptions, runNotifications } from "./services/notify";
import { autoRecover } from "./services/recover";

const app = createApp();

/** Marks stale flows as expired and cancels their pending jobs. */
export async function expireFlows(db: D1Database, now = Date.now()): Promise<void> {
  await db.batch([
    db
      .prepare(
        `UPDATE action_jobs SET status = 'cancelled', last_error = 'flow expired', updated_at = ?
         WHERE status IN ('pending','retry_scheduled') AND flow_id IN (
           SELECT id FROM conversation_flows WHERE expires_at < ? AND state NOT IN ('content_sent','verification_unavailable','expired','failed','cancelled'))`,
      )
      .bind(now, now),
    db
      .prepare(
        `UPDATE conversation_flows SET state = 'expired', state_reason = 'flow_ttl', updated_at = ?
         WHERE expires_at < ? AND state NOT IN ('content_sent','verification_unavailable','expired','failed','cancelled')`,
      )
      .bind(now, now),
  ]);
}

/**
 * Retention policy:
 *  - personal text is scrubbed after `retention_days`;
 *  - rows that carry dedup keys (events, jobs) are only deleted after max(retention, dedup_retention) days,
 *    so duplicate protection keeps working for the whole window in which Meta may redeliver.
 */
export async function cleanup(db: D1Database, now = Date.now()): Promise<void> {
  // Each customer's data follows that customer's retention settings.
  const tenants = await all<{ id: number }>(db, "SELECT id FROM tenants ORDER BY id");
  for (const t of tenants) await cleanupTenant(db, t.id, now);
  // Events of Instagram accounts that no customer has (never connected or removed): the owner's retention.
  const retention = await getSetting(db, OWNER_TENANT, "retention_days", 90);
  const dedup = await getSetting(db, OWNER_TENANT, "dedup_retention_days", 30);
  const orphan = "account_ig_id NOT IN (SELECT ig_user_id FROM instagram_accounts)";
  await db.batch([
    db.prepare(`UPDATE webhook_events SET text = NULL, sender_username = NULL, payload = '{}' WHERE ${orphan} AND received_at < ? AND payload != '{}'`).bind(now - retention * 86_400_000),
    db.prepare(`DELETE FROM webhook_events WHERE ${orphan} AND received_at < ?`).bind(now - Math.max(retention, dedup) * 86_400_000),
    db.prepare("DELETE FROM sessions WHERE expires_at < ? OR revoked_at < ?").bind(now, now - 86_400_000),
    db.prepare("DELETE FROM oauth_states WHERE expires_at < ?").bind(now),
    db.prepare("DELETE FROM rate_limits WHERE window_start < ?").bind(now - 86_400_000),
    db.prepare("DELETE FROM audit_logs WHERE at < ?").bind(now - 365 * 86_400_000),
    db.prepare("DELETE FROM media_cache WHERE kind = 'story' AND expires_at < ? AND media_id NOT IN (SELECT media_id FROM media_insights)").bind(now - 7 * 86_400_000),
    db.prepare("DELETE FROM media_insights WHERE captured_at < ?").bind(now - 400 * 86_400_000),
    db.prepare("DELETE FROM account_insights WHERE captured_at < ?").bind(now - 400 * 86_400_000),
  ]);
}

async function cleanupTenant(db: D1Database, tenantId: number, now: number): Promise<void> {
  const retention = await getSetting(db, tenantId, "retention_days", 90);
  const dedup = await getSetting(db, tenantId, "dedup_retention_days", 30);
  const scrubBefore = now - retention * 86_400_000;
  const deleteBefore = now - Math.max(retention, dedup) * 86_400_000;
  const ACC = "(SELECT id FROM instagram_accounts WHERE tenant_id = ?)";
  const IG = "(SELECT ig_user_id FROM instagram_accounts WHERE tenant_id = ?)";
  const PART = `(SELECT id FROM participants WHERE account_id IN ${ACC})`;
  await db.batch([
    db.prepare(`UPDATE webhook_events SET text = NULL, sender_username = NULL, payload = '{}' WHERE account_ig_id IN ${IG} AND received_at < ? AND payload != '{}'`).bind(tenantId, scrubBefore),
    db.prepare(`DELETE FROM webhook_events WHERE account_ig_id IN ${IG} AND received_at < ?`).bind(tenantId, deleteBefore),
    db.prepare(`DELETE FROM action_attempts WHERE job_id IN (SELECT id FROM action_jobs WHERE account_id IN ${ACC}) AND started_at < ?`).bind(tenantId, scrubBefore),
    db.prepare(`DELETE FROM action_jobs WHERE account_id IN ${ACC} AND updated_at < ? AND status IN ('accepted','failed','cancelled','uncertain')`).bind(tenantId, deleteBefore),
    db.prepare(`DELETE FROM follow_checks WHERE participant_id IN ${PART} AND checked_at < ?`).bind(tenantId, scrubBefore),
    db.prepare(`DELETE FROM messages WHERE participant_id IN ${PART} AND created_at < ?`).bind(tenantId, scrubBefore),
    db
      .prepare(`DELETE FROM conversation_flows WHERE account_id IN ${ACC} AND updated_at < ? AND state IN ('content_sent','verification_unavailable','expired','failed','cancelled')`)
      .bind(tenantId, scrubBefore),
    db.prepare(`DELETE FROM participants WHERE account_id IN ${ACC} AND updated_at < ? AND id NOT IN (SELECT participant_id FROM conversation_flows)`).bind(tenantId, scrubBefore),
  ]);
}

export default {
  fetch: app.fetch,

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (controller.cron === "17 3 * * *") {
      // Daily maintenance.
      ctx.waitUntil(
        (async () => {
          await refreshExpiringTokens(env).catch((e) => console.error("token refresh", sanitize(String(e))));
          await refreshAccountProfiles(env).catch((e) => console.error("profile refresh", sanitize(String(e))));
          await cleanup(env.DB).catch((e) => console.error("cleanup", sanitize(String(e))));
          await refreshStoreTokens(env).catch((e) => console.error("store tokens", sanitize(String(e))));
          await cleanupScheduledFiles(env).catch((e) => console.error("schedule files", sanitize(String(e))));
          await remindExpiringSubscriptions(env).catch((e) => console.error("expiry reminders", sanitize(String(e))));
        })(),
      );
      return;
    }
    // Every minute: durable queue processing.
    let used = 0;
    const ectx = engineContext(env, () => used++);
    await expireFlows(env.DB);
    // Once an hour: pick up comments whose webhook never arrived (quota reached, outage, Meta stopped retrying).
    // Each customer has its own minute in the hour (the owner keeps minute 7).
    await autoRecover(env, ectx, new Date(controller.scheduledTime).getUTCMinutes()).catch((e) => console.error("recover", sanitize(String(e))));
    // Optional follow re-check for retention analytics (off unless the customer enables it; few people per hour).
    await runFollowRecheck(env, ectx, new Date(controller.scheduledTime).getUTCMinutes()).catch((e) => console.error("follow recheck", sanitize(String(e))));
    // Scheduled publishing: one step per due post (containers, status checks, publish).
    await runPublisher(env, () => used++).catch((e) => console.error("publisher", sanitize(String(e))));
    // Instagram insights snapshots, hourly per customer (only accounts that granted the insights permission).
    await runInsights(env, new Date(controller.scheduledTime).getUTCMinutes(), () => used++).catch((e) => console.error("insights", sanitize(String(e))));
    await runQueue(ectx, {
      maxJobs: 25,
      includeDemo: false,
      deadlineMs: 25_000,
      budget: { used: () => used, limit: 44 }, // Workers Free: 50 external subrequests per invocation (shared with recovery/alerts)
    }).catch((e) => console.error("queue", sanitize(String(e))));
    await runNotifications(env).catch((e) => console.error("notifications", sanitize(String(e))));
    await run(env.DB, "DELETE FROM rate_limits WHERE window_start < ?", Date.now() - 86_400_000).catch(() => undefined);
  },
} satisfies ExportedHandler<Env>;
