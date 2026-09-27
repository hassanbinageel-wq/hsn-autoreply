import type { Env } from "../env";
import type { AccountRow, EngineContext } from "../engine/context";
import { all, first, getSetting, setSetting } from "../lib/db";
import type { NormalizedEvent } from "../meta/webhook-parse";
import { storeEvents } from "./webhook";

/** Private replies are only allowed for 7 days after the comment, so older comments are never recovered. */
const RECOVER_WINDOW_MS = 7 * 24 * 3_600_000;

export interface RecoverResult {
  media: number;
  fetched: number;
  recovered: number;
  skipped_reason?: string;
}

/**
 * Safety net for comments whose webhook never reached us (daily quota reached, outage, Meta gave up retrying):
 * reads the latest comments of the posts/reels that active comment campaigns cover and stores any comment we
 * have never seen as a normal event. It then goes through the exact same pipeline (matching, cooldowns, flows),
 * and the shared dedup key (comment:<id>) guarantees a comment is never answered twice.
 */
export async function recoverMissedComments(ctx: EngineContext, opts: { maxMedia?: number } = {}): Promise<RecoverResult> {
  const now = ctx.now();
  const account = await first<AccountRow>(ctx.db, "SELECT * FROM instagram_accounts WHERE is_demo = 0 AND status = 'active' ORDER BY id LIMIT 1");
  if (!account) return { media: 0, fetched: 0, recovered: 0, skipped_reason: "no_account" };
  if (!(await getSetting(ctx.db, "automation_enabled", true))) return { media: 0, fetched: 0, recovered: 0, skipped_reason: "automation_paused" };
  const campaigns = await all<{ id: number; scope: string; auto_new_media: number; activated_at: number | null; process_old_events: number }>(
    ctx.db,
    "SELECT id, scope, auto_new_media, activated_at, process_old_events FROM campaigns WHERE type = 'comment' AND status = 'active' AND deleted_at IS NULL",
  );
  if (!campaigns.length) return { media: 0, fetched: 0, recovered: 0, skipped_reason: "no_active_comment_campaign" };
  const since = now - RECOVER_WINDOW_MS;

  // Which posts to look at: those explicitly selected, plus (for "all posts"/auto-new campaigns) the posts with
  // recent comment activity and the ones published in the last 7 days. Most recent first, bounded.
  const ids: string[] = [];
  const add = (m: string | null | undefined) => m && !ids.includes(m) && ids.push(m);
  const broad = campaigns.some((c) => c.scope === "all" || c.auto_new_media);
  const recent = broad
    ? await all<{ media_id: string }>(
        ctx.db,
        `SELECT media_id FROM (
           SELECT media_id, MAX(received_at) AS t FROM webhook_events WHERE event_type = 'comment' AND is_demo = 0 AND received_at > ? AND media_id IS NOT NULL GROUP BY media_id
           UNION ALL
           SELECT media_id, posted_at AS t FROM media_cache WHERE account_id = ? AND kind = 'media' AND posted_at > ?
         ) GROUP BY media_id ORDER BY MAX(t) DESC LIMIT 30`,
        since,
        account.id,
        since,
      )
    : [];
  const selected = await all<{ media_id: string }>(
    ctx.db,
    `SELECT cm.media_id FROM campaign_media cm JOIN campaigns c ON c.id = cm.campaign_id
      LEFT JOIN media_cache m ON m.media_id = cm.media_id AND m.account_id = ?
      WHERE c.type = 'comment' AND c.status = 'active' AND c.deleted_at IS NULL
      ORDER BY COALESCE(m.posted_at, 0) DESC LIMIT 30`,
    account.id,
  );
  for (const r of recent) add(r.media_id);
  for (const r of selected) add(r.media_id);
  const media = ids.slice(0, opts.maxMedia ?? 10);
  if (!media.length) return { media: 0, fetched: 0, recovered: 0, skipped_reason: "no_media" };

  const client = ctx.meta(false);
  const token = await ctx.getAccessToken(account);
  if (!token || !client.listComments) return { media: 0, fetched: 0, recovered: 0, skipped_reason: "no_token" };

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
  if (!found.length) return { media: media.length, fetched, recovered: 0 };

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
  return { media: media.length, fetched, recovered: fresh.length };
}

/** Hourly automatic recovery (setting "auto_recover_comments", on by default). Records the last run. */
export async function autoRecover(env: Env, ctx: EngineContext): Promise<void> {
  if (!(await getSetting(env.DB, "auto_recover_comments", true))) return;
  const r = await recoverMissedComments(ctx, { maxMedia: 10 });
  await setSetting(env.DB, "recover_last", { at: Date.now(), ...r, auto: true });
}
