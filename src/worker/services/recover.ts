import type { Env } from "../env";
import type { AccountRow, EngineContext } from "../engine/context";
import { all, first, getSetting, setSetting } from "../lib/db";
import type { NormalizedEvent } from "../meta/webhook-parse";
import { storeEvents } from "./webhook";
import { getEntitlement, monthlyMessages } from "./plans";

/** Private replies are only allowed for 7 days after the comment, so older comments are never recovered. */
const RECOVER_WINDOW_MS = 7 * 24 * 3_600_000;

export interface RecoverResult {
  media: number;
  fetched: number;
  recovered: number;
  skipped_reason?: string;
  /** Of `recovered`: comments that arrived while the subscription had ended or the messages had run out. */
  held?: number;
}

/** Why a comment was set aside without a reply although nothing was wrong with it: no subscription or no messages left. */
const HELD_REASONS = ["subscription_inactive", "monthly_limit_reached"];

/**
 * Comments that reached us while the customer's subscription had ended or the cycle's messages had run out were
 * set aside unanswered. Once the customer renews or tops up, they go back through the pipeline — only those still
 * inside the 7-day private-reply window, never one that was answered, and only while messages are available now.
 * Each comment gets a fresh processing job (the first one is spent), keyed by when it was set aside.
 */
async function requeueHeld(ctx: EngineContext, tenantId: number, igUserId: string, since: number): Promise<number> {
  const ent = await getEntitlement(ctx.db, tenantId, ctx.now());
  if (!ent.active || !ent.limits.events.includes("comment")) return 0;
  const left = ent.limits.monthly_messages === null ? 100 : ent.limits.monthly_messages - (await monthlyMessages(ctx.db, tenantId, ctx.now()));
  if (left <= 0) return 0;
  const rows = await all<{ id: number; dedup_key: string; processed_at: number | null }>(
    ctx.db,
    `SELECT id, dedup_key, processed_at FROM webhook_events
      WHERE account_ig_id = ? AND event_type = 'comment' AND is_demo = 0 AND status = 'ignored' AND reason IN (${HELD_REASONS.map(() => "?").join(",")})
        AND event_time >= ? ORDER BY event_time DESC LIMIT ?`,
    igUserId, ...HELD_REASONS, since, Math.min(100, left),
  );
  if (!rows.length) return 0;
  const now = ctx.now();
  const stmts: D1PreparedStatement[] = [];
  for (const r of rows) {
    stmts.push(
      ctx.db.prepare("UPDATE webhook_events SET status = 'pending', reason = NULL, processed_at = NULL, recovered = 1 WHERE id = ? AND status = 'ignored'").bind(r.id),
      ctx.db
        .prepare(
          `INSERT OR IGNORE INTO action_jobs (account_id, kind, event_id, dedup_key, payload, is_demo, status, attempts, max_attempts, run_at, created_at, updated_at)
           VALUES (NULL, 'process_event', ?, ?, '{}', 0, 'pending', 0, 5, ?, ?, ?)`,
        )
        .bind(r.id, `evt:${r.dedup_key}:held:${r.processed_at ?? 0}`, now, now, now),
    );
  }
  await ctx.db.batch(stmts);
  return rows.length;
}

/**
 * Safety net for comments whose webhook never reached us (daily quota reached, outage, Meta gave up retrying):
 * reads the latest comments of the posts/reels that active comment campaigns cover and stores any comment we
 * have never seen as a normal event. It then goes through the exact same pipeline (matching, cooldowns, flows),
 * and the shared dedup key (comment:<id>) guarantees a comment is never answered twice.
 */
export async function recoverMissedComments(ctx: EngineContext, tenantId: number, opts: { maxMedia?: number } = {}): Promise<RecoverResult> {
  const r = await fetchMissed(ctx, tenantId, opts);
  return r.held ? { ...r, recovered: r.recovered + r.held, skipped_reason: undefined } : r;
}

async function fetchMissed(ctx: EngineContext, tenantId: number, opts: { maxMedia?: number }): Promise<RecoverResult> {
  const now = ctx.now();
  const account = await first<AccountRow>(ctx.db, "SELECT * FROM instagram_accounts WHERE tenant_id = ? AND is_demo = 0 AND status = 'active' ORDER BY id LIMIT 1", tenantId);
  if (!account) return { media: 0, fetched: 0, recovered: 0, skipped_reason: "no_account" };
  if (!(await getSetting(ctx.db, tenantId, "automation_enabled", true))) return { media: 0, fetched: 0, recovered: 0, skipped_reason: "automation_paused" };
  const campaigns = await all<{ id: number; scope: string; auto_new_media: number; activated_at: number | null; process_old_events: number }>(
    ctx.db,
    "SELECT id, scope, auto_new_media, activated_at, process_old_events FROM campaigns WHERE tenant_id = ? AND type = 'comment' AND status = 'active' AND deleted_at IS NULL",
    tenantId,
  );
  if (!campaigns.length) return { media: 0, fetched: 0, recovered: 0, skipped_reason: "no_active_comment_campaign" };
  const since = now - RECOVER_WINDOW_MS;
  const held = await requeueHeld(ctx, tenantId, account.ig_user_id, since);

  // Which posts to look at: those explicitly selected, plus (for "all posts"/auto-new campaigns) the posts with
  // recent comment activity and the ones published in the last 7 days. Most recent first, bounded.
  const ids: string[] = [];
  const add = (m: string | null | undefined) => m && !ids.includes(m) && ids.push(m);
  const broad = campaigns.some((c) => c.scope === "all" || c.auto_new_media);
  const recent = broad
    ? await all<{ media_id: string }>(
        ctx.db,
        `SELECT media_id FROM (
           SELECT media_id, MAX(received_at) AS t FROM webhook_events WHERE account_ig_id = ? AND event_type = 'comment' AND is_demo = 0 AND received_at > ? AND media_id IS NOT NULL GROUP BY media_id
           UNION ALL
           SELECT media_id, posted_at AS t FROM media_cache WHERE account_id = ? AND kind = 'media' AND posted_at > ?
         ) GROUP BY media_id ORDER BY MAX(t) DESC LIMIT 30`,
        account.ig_user_id,
        since,
        account.id,
        since,
      )
    : [];
  const selected = await all<{ media_id: string }>(
    ctx.db,
    `SELECT cm.media_id FROM campaign_media cm JOIN campaigns c ON c.id = cm.campaign_id
      LEFT JOIN media_cache m ON m.media_id = cm.media_id AND m.account_id = ?
      WHERE c.tenant_id = ? AND c.type = 'comment' AND c.status = 'active' AND c.deleted_at IS NULL
      ORDER BY COALESCE(m.posted_at, 0) DESC LIMIT 30`,
    account.id,
    tenantId,
  );
  for (const r of recent) add(r.media_id);
  for (const r of selected) add(r.media_id);
  const media = ids.slice(0, opts.maxMedia ?? 10);
  if (!media.length) return { media: 0, fetched: 0, recovered: 0, skipped_reason: "no_media", held };

  const client = ctx.meta(false);
  const token = await ctx.getAccessToken(account);
  if (!token || !client.listComments) return { media: 0, fetched: 0, recovered: 0, skipped_reason: "no_token", held };

  const found: NormalizedEvent[] = [];
  let fetched = 0;
  for (const mediaId of media) {
    const r = await client.listComments(token, mediaId);
    if (!r.ok) {
      if (r.error.kind === "auth") {
        await ctx.onAuthError?.(account, r.error.message);
        break;
      }
      if (r.error.kind === "rate_limited") break;
      continue;
    }
    for (const c of r.data.data ?? []) {
      fetched++;
      const t = c.timestamp ? Date.parse(c.timestamp) : NaN;
      const senderId = c.from?.id;
      if (!c.id || !senderId || !Number.isFinite(t) || t < since || t > now + 60_000) continue;
      found.push({
        kind: "comment",
        dedupKey: `comment:${c.id}`,
        accountIgId: account.ig_user_id,
        senderId,
        senderUsername: c.from?.username ?? c.username,
        text: c.text ?? "",
        mediaId,
        commentId: c.id,
        parentId: c.parent_id,
        time: t,
      });
    }
  }
  if (!found.length) return { media: media.length, fetched, recovered: 0, held };

  // Only comments we have never stored (the webhook may have delivered them already).
  const known = new Set<string>();
  for (let i = 0; i < found.length; i += 50) {
    const chunk = found.slice(i, i + 50);
    const rows = await all<{ dedup_key: string }>(
      ctx.db,
      `SELECT dedup_key FROM webhook_events WHERE dedup_key IN (${chunk.map(() => "?").join(",")})`,
      ...chunk.map((e) => e.dedupKey),
    );
    for (const r of rows) known.add(r.dedup_key);
  }
  const fresh = found.filter((e) => !known.has(e.dedupKey));
  if (fresh.length) await storeEvents(ctx.db, fresh, { now, touchAccount: false, recovered: true });
  return { media: media.length, fetched, recovered: fresh.length, held };
}

/**
 * Hourly automatic recovery (setting "auto_recover_comments", on by default), spread over the hour: each customer
 * has its own minute, so one cron run never exceeds the free plan's 50 subrequests (at most 2 customers per run).
 */
export async function autoRecover(env: Env, ctx: EngineContext, minute: number): Promise<void> {
  const tenants = await all<{ id: number }>(
    env.DB,
    `SELECT t.id FROM tenants t WHERE t.status = 'active' AND (t.id + 6) % 60 = ?
       AND EXISTS (SELECT 1 FROM instagram_accounts a WHERE a.tenant_id = t.id AND a.is_demo = 0 AND a.status = 'active')
     ORDER BY t.id LIMIT 2`,
    minute,
  );
  for (const t of tenants) {
    if (!(await getSetting(env.DB, t.id, "auto_recover_comments", true))) continue;
    if (!(await getEntitlement(env.DB, t.id)).limits.recover) continue; // not in the customer's plan
    const r = await recoverMissedComments(ctx, t.id, { maxMedia: 10 });
    await setSetting(env.DB, t.id, "recover_last", { at: Date.now(), ...r, auto: true });
  }
}
