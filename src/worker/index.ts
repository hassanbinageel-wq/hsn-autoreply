import { createApp } from "./app";
import type { Env } from "./env";
import { getSetting, run } from "./lib/db";
import { runQueue } from "./engine/executor";
import { engineContext, refreshExpiringTokens } from "./services/account";
import { sanitize } from "./meta/client";

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
  const retention = await getSetting(db, "retention_days", 90);
  const dedup = await getSetting(db, "dedup_retention_days", 30);
  const scrubBefore = now - retention * 86_400_000;
  const deleteBefore = now - Math.max(retention, dedup) * 86_400_000;
  await db.batch([
    db.prepare("UPDATE webhook_events SET text = NULL, sender_username = NULL, payload = '{}' WHERE received_at < ? AND payload != '{}'").bind(scrubBefore),
    db.prepare("DELETE FROM webhook_events WHERE received_at < ?").bind(deleteBefore),
    db.prepare("DELETE FROM action_attempts WHERE started_at < ?").bind(scrubBefore),
    db.prepare("DELETE FROM action_jobs WHERE updated_at < ? AND status IN ('accepted','failed','cancelled','uncertain')").bind(deleteBefore),
    db.prepare("DELETE FROM follow_checks WHERE checked_at < ?").bind(scrubBefore),
    db
      .prepare("DELETE FROM conversation_flows WHERE updated_at < ? AND state IN ('content_sent','verification_unavailable','expired','failed','cancelled')")
      .bind(scrubBefore),
    db.prepare("DELETE FROM participants WHERE updated_at < ? AND id NOT IN (SELECT participant_id FROM conversation_flows)").bind(scrubBefore),
    db.prepare("DELETE FROM sessions WHERE expires_at < ? OR revoked_at < ?").bind(now, now - 86_400_000),
    db.prepare("DELETE FROM oauth_states WHERE expires_at < ?").bind(now),
    db.prepare("DELETE FROM rate_limits WHERE window_start < ?").bind(now - 86_400_000),
    db.prepare("DELETE FROM audit_logs WHERE at < ?").bind(now - 365 * 86_400_000),
    db.prepare("DELETE FROM media_cache WHERE kind = 'story' AND expires_at < ?").bind(now - 7 * 86_400_000),
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
          await cleanup(env.DB).catch((e) => console.error("cleanup", sanitize(String(e))));
        })(),
      );
      return;
    }
    // Every minute: durable queue processing.
    let used = 0;
    const ectx = engineContext(env, () => used++);
    await expireFlows(env.DB);
    await runQueue(ectx, {
      maxJobs: 25,
      includeDemo: false,
      deadlineMs: 25_000,
      budget: { used: () => used, limit: 45 }, // Workers Free: 50 external subrequests per invocation
    }).catch((e) => console.error("queue", sanitize(String(e))));
    await run(env.DB, "DELETE FROM rate_limits WHERE window_start < ?", Date.now() - 86_400_000).catch(() => undefined);
  },
} satisfies ExportedHandler<Env>;
