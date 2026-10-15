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
  /** True when a post has more comments than one audit reads (check that post on its own). */
  truncated: boolean;
  /** Per post: how many comments were read and whether the post was read to the end. */
  posts: Array<{ media_id: string; read: number; complete: boolean }>;
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
  opts: { importMissing?: boolean; mediaId?: string } = {},
): Promise<AuditResult | null> {
  const counts: Record<AuditStatus, number> = { replied: 0, in_progress: 0, not_replied: 0, missing: 0, missing_old: 0 };
  const empty = (error?: string): AuditResult => ({ media: 0, checked: 0, truncated: false, posts: [], counts, items: [], imported: 0, error });
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

  // The posts: the ones the campaign selected, the posts its matched comments came from and, for "all posts" /
  // auto-new campaigns, every post with comment activity or published in the last 30 days. Or one chosen post.
  const ids: string[] = [];
  const add = (m: string | null | undefined) => m && !ids.includes(m) && ids.push(m);
  const since = ctx.now() - 30 * 86_400_000;
  const selected = await all<{ media_id: string }>(
    ctx.db,
    `SELECT cm.media_id FROM campaign_media cm JOIN campaigns c ON c.id = cm.campaign_id
      LEFT JOIN media_cache m ON m.media_id = cm.media_id AND m.account_id = ?
      WHERE c.id = ? AND c.tenant_id = ? ORDER BY COALESCE(m.posted_at, 0) DESC LIMIT 30`,
    account.id,
    campaignId,
    tenantId,
  );
  const matched = await all<{ media_id: string }>(
    ctx.db,
    `SELECT media_id FROM webhook_events
      WHERE account_ig_id IN (SELECT ig_user_id FROM instagram_accounts WHERE tenant_id = ?)
        AND campaign_id = ? AND event_type = 'comment' AND is_demo = 0 AND media_id IS NOT NULL
      GROUP BY media_id ORDER BY MAX(received_at) DESC LIMIT 30`,
    tenantId,
    campaignId,
  );
  const broad =
    campaign.scope === "all" || campaign.auto_new_media
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
  for (const r of [...selected, ...matched, ...broad]) add(r.media_id);
  if (opts.mediaId && !ids.includes(opts.mediaId)) return empty("media_not_in_campaign");
  const media = opts.mediaId ? [opts.mediaId] : ids.slice(0, MAX_MEDIA);
  if (!media.length) return empty("no_media");

  const client = ctx.meta(false);
  const token = await ctx.getAccessToken(account);
  if (!token || !client.listCommentsPage) return empty("no_token");

  // 1) Read the comments (top level, with the first page of replies expanded).
  const found: Array<CommentItem & { media_id: string; is_reply: boolean }> = [];
  const posts: AuditResult["posts"] = [];
  let calls = 0;
  let truncated = false;
  let error: string | undefined;
  outer: for (let i = 0; i < media.length; i++) {
    const mediaId = media[i];
    // Each post gets a fair share of what is left, so a busy post cannot starve the others.
    const share = Math.max(1, Math.floor((MAX_CALLS - calls) / (media.length - i)));
    const post = { media_id: mediaId, read: 0, complete: false };
    posts.push(post);
    let after: string | undefined;
    for (let n = 0; ; n++) {
      if (n >= share || calls >= MAX_CALLS) {
        truncated = true;
        break;
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
        post.read++;
        for (const rep of c.replies?.data ?? []) {
          found.push({ ...rep, parent_id: rep.parent_id ?? c.id, media_id: mediaId, is_reply: true });
          post.read++;
        }
        if (c.replies?.paging?.next) truncated = true;
      }
      const next = r.data.paging?.next ? r.data.paging?.cursors?.after : undefined;
      if (!next) {
        post.complete = true;
        break;
      }
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

  // Comments the engine recognised as the account's own (e.g. your replies under people's comments) are not participants.
  const people = comments.filter((c) => events.get(c.id)?.reason !== "own_account");
  // People already answered on another comment in this campaign: their extra comments are not "missed".
  const answeredPeople = new Set<string>();
  for (const c of people) {
    const f = flows.get(c.id);
    if (f && (f.private_reply_status === "accepted" || f.public_reply_status === "accepted" || f.state === "content_sent") && c.from?.id) answeredPeople.add(c.from.id);
  }
  for (const r of await all<{ igsid: string }>(
    ctx.db,
    `SELECT DISTINCT p.igsid FROM conversation_flows f JOIN participants p ON p.id = f.participant_id
      WHERE f.campaign_id = ? AND f.account_id = ? AND f.is_demo = 0
        AND (f.private_reply_status = 'accepted' OR f.public_reply_status = 'accepted' OR f.state = 'content_sent')`,
    campaignId,
    account.id,
  ))
    answeredPeople.add(r.igsid);

  const now = ctx.now();
  const items: AuditItem[] = [];
  const toImport: NormalizedEvent[] = [];
  for (const c of people) {
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
    } else if (c.from?.id && answeredPeople.has(c.from.id) && ev?.status !== "pending") {
      status = "replied";
      reason = "already_replied";
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
  return { media: media.length, checked: people.length, truncated, posts, counts, items: items.slice(0, 1000), imported, error };
}
