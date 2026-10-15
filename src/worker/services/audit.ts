import type { AccountRow, EngineContext } from "../engine/context";
import { all, first } from "../lib/db";
import type { CommentItem } from "../meta/types";
import type { NormalizedEvent } from "../meta/webhook-parse";
import { storeEvents } from "./webhook";

/** Private replies are only allowed for 7 days after the comment (Meta Private Replies). */
const REPLY_WINDOW_MS = 7 * 24 * 3_600_000;
/** Meta calls per audit: stays well inside the Workers free plan's 50 subrequests per request. */
const MAX_CALLS = 25;
const MAX_MEDIA = 8;

export type AuditStatus = "replied" | "in_progress" | "not_replied" | "missing" | "missing_old";

export interface AuditItem {
  comment_id: string;
  media_id: string;
  username: string | null;
  text: string;
  time: number;
  is_reply: boolean;
  status: AuditStatus;
  /** Why we did not answer (engine reason, or the flow state). */
  reason: string | null;
}

export interface AuditResult {
  media: number;
  checked: number;
  /** True when a post has more comments than one audit reads (run it again later / per post). */
  truncated: boolean;
  counts: Record<AuditStatus, number>;
  items: AuditItem[];
  imported: number;
  error?: string;
}

/**
 * Compares the comments Instagram actually has on a comment campaign's posts (official Graph API,
 * GET /{media-id}/comments) with what this system recorded and answered. Optionally stores the comments we never
 * received as normal (recovered) events, so they go through the same pipeline — matching, cooldowns, the one
 * private reply — and the shared dedup key (comment:<id>) guarantees nobody is answered twice. Only comments still
 * inside the 7-day private-reply window are imported. Everything is scoped to the tenant's own account and campaign.
 */
export async function auditCampaignComments(
  ctx: EngineContext,
  tenantId: number,
  campaignId: number,
  opts: { importMissing?: boolean } = {},
): Promise<AuditResult | null> {
  const counts: Record<AuditStatus, number> = { replied: 0, in_progress: 0, not_replied: 0, missing: 0, missing_old: 0 };
  const empty = (error?: string): AuditResult => ({ media: 0, checked: 0, truncated: false, counts, items: [], imported: 0, error });
  const campaign = await first<{ id: number; type: string; scope: string; auto_new_media: number }>(
    ctx.db,
    "SELECT id, type, scope, auto_new_media FROM campaigns WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL",
    campaignId,
    tenantId,
  );
  if (!campaign) return null;
  if (campaign.type !== "comment") return empty("not_comment");
  const account = await first<AccountRow>(ctx.db, "SELECT * FROM instagram_accounts WHERE tenant_id = ? AND is_demo = 0 AND status = 'active' ORDER BY id LIMIT 1", tenantId);
  if (!account) return empty("no_account");

  // The posts: the ones the campaign selected, plus the posts its matched comments came from (campaigns on "all posts").
  const ids: string[] = [];
  const add = (m: string | null | undefined) => m && !ids.includes(m) && ids.push(m);
  for (const r of await all<{ media_id: string }>(
    ctx.db,
    `SELECT cm.media_id FROM campaign_media cm JOIN campaigns c ON c.id = cm.campaign_id
      LEFT JOIN media_cache m ON m.media_id = cm.media_id AND m.account_id = ?
      WHERE c.id = ? AND c.tenant_id = ? ORDER BY COALESCE(m.posted_at, 0) DESC LIMIT 20`,
    account.id,
    campaignId,
    tenantId,
  ))
    add(r.media_id);
  for (const r of await all<{ media_id: string }>(
    ctx.db,
    `SELECT media_id FROM webhook_events
      WHERE account_ig_id IN (SELECT ig_user_id FROM instagram_accounts WHERE tenant_id = ?)
        AND campaign_id = ? AND event_type = 'comment' AND is_demo = 0 AND media_id IS NOT NULL
      GROUP BY media_id ORDER BY MAX(received_at) DESC LIMIT 20`,
    tenantId,
    campaignId,
  ))
    add(r.media_id);
  const media = ids.slice(0, MAX_MEDIA);
  if (!media.length) return empty("no_media");

  const client = ctx.meta(false);
  const token = await ctx.getAccessToken(account);
  if (!token || !client.listCommentsPage) return empty("no_token");

  // 1) Read the comments (top level, with the first page of replies expanded).
  const found: Array<CommentItem & { media_id: string; is_reply: boolean }> = [];
  let calls = 0;
  let truncated = false;
  let error: string | undefined;
  outer: for (const mediaId of media) {
    let after: string | undefined;
    for (;;) {
      if (calls >= MAX_CALLS) {
        truncated = true;
        break outer;
      }
      calls++;
      const r = await client.listCommentsPage(token, mediaId, after);
      if (!r.ok) {
        if (r.error.kind === "auth") {
          await ctx.onAuthError?.(account, r.error.message);
          error = "auth";
          break outer;
        }
        if (r.error.kind === "rate_limited") {
          error = "rate_limited";
          truncated = true;
          break outer;
        }
        break; // this post only (e.g. deleted)
      }
      for (const c of r.data.data ?? []) {
        found.push({ ...c, media_id: mediaId, is_reply: false });
        for (const rep of c.replies?.data ?? []) found.push({ ...rep, parent_id: rep.parent_id ?? c.id, media_id: mediaId, is_reply: true });
        if (c.replies?.paging?.next) truncated = true;
      }
      const next = r.data.paging?.next ? r.data.paging?.cursors?.after : undefined;
      if (!next) break;
      after = next;
    }
  }

  // Our own comments (public replies) are not participants.
  const own = new Set([account.ig_user_id, account.app_scoped_id].filter(Boolean) as string[]);
  const ownName = account.username?.toLowerCase();
  const comments = found.filter((c) => c.id && !own.has(c.from?.id ?? "") && !(ownName && (c.from?.username ?? c.username ?? "").toLowerCase() === ownName));

  // 2) What we recorded for each comment, and the flow it started.
  const events = new Map<string, { status: string; reason: string | null; flow_id: number | null; campaign_id: number | null }>();
  for (let i = 0; i < comments.length; i += 50) {
    const chunk = comments.slice(i, i + 50);
    const rows = await all<{ dedup_key: string; status: string; reason: string | null; flow_id: number | null; campaign_id: number | null }>(
      ctx.db,
      `SELECT dedup_key, status, reason, flow_id, campaign_id FROM webhook_events
        WHERE account_ig_id = ? AND dedup_key IN (${chunk.map(() => "?").join(",")})`,
      account.ig_user_id,
      ...chunk.map((c) => `comment:${c.id}`),
    );
    for (const r of rows) events.set(r.dedup_key.slice("comment:".length), r);
  }
  const flows = new Map<string, { state: string; private_reply_status: string | null; public_reply_status: string | null; state_reason: string | null }>();
  for (let i = 0; i < comments.length; i += 50) {
    const chunk = comments.slice(i, i + 50);
    const rows = await all<{ source_comment_id: string; state: string; private_reply_status: string | null; public_reply_status: string | null; state_reason: string | null }>(
      ctx.db,
      `SELECT source_comment_id, state, private_reply_status, public_reply_status, state_reason FROM conversation_flows
        WHERE account_id = ? AND is_demo = 0 AND source_comment_id IN (${chunk.map(() => "?").join(",")})`,
      account.id,
      ...chunk.map((c) => c.id),
    );
    for (const r of rows) flows.set(r.source_comment_id, r);
  }

  const now = ctx.now();
  const items: AuditItem[] = [];
  const toImport: NormalizedEvent[] = [];
  for (const c of comments) {
    const t = c.timestamp ? Date.parse(c.timestamp) : NaN;
    const time = Number.isFinite(t) ? t : 0;
    const ev = events.get(c.id);
    const flow = flows.get(c.id);
    let status: AuditStatus;
    let reason: string | null = null;
    if (flow) {
      const answered = flow.private_reply_status === "accepted" || flow.public_reply_status === "accepted" || flow.state === "content_sent";
      const open = !["content_sent", "verification_unavailable", "expired", "failed", "cancelled"].includes(flow.state);
      status = answered ? "replied" : open ? "in_progress" : "not_replied";
      if (!answered) reason = flow.state_reason ?? flow.state;
    } else if (ev) {
      status = ev.status === "pending" ? "in_progress" : "not_replied";
      reason = ev.reason ?? (ev.status === "pending" ? "pending" : null);
    } else if (time && now - time <= REPLY_WINDOW_MS) {
      status = "missing";
      if (c.from?.id)
        toImport.push({
          kind: "comment",
          dedupKey: `comment:${c.id}`,
          accountIgId: account.ig_user_id,
          senderId: c.from.id,
          senderUsername: c.from.username ?? c.username,
          text: c.text ?? "",
          mediaId: c.media_id,
          commentId: c.id,
          parentId: c.parent_id,
          time,
        });
    } else {
      status = "missing_old";
    }
    counts[status]++;
    items.push({ comment_id: c.id, media_id: c.media_id, username: c.from?.username ?? c.username ?? null, text: (c.text ?? "").slice(0, 300), time, is_reply: c.is_reply, status, reason });
  }

  let imported = 0;
  if (opts.importMissing && toImport.length) imported = await storeEvents(ctx.db, toImport, { now, touchAccount: false, recovered: true });
  items.sort((a, b) => b.time - a.time);
  return { media: media.length, checked: comments.length, truncated, counts, items: items.slice(0, 1000), imported, error };
}
