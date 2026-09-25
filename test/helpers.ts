import { env } from "cloudflare:workers";
import type { EngineContext } from "../src/worker/engine/context";
import type { FollowCheckOutcome, MetaClient, MetaResult, OutgoingMessage } from "../src/worker/meta/types";
import { runQueue } from "../src/worker/engine/executor";
import { storeEvents } from "../src/worker/services/webhook";
import { parseWebhook } from "../src/worker/meta/webhook-parse";

export const TEST_ENV = env as any;
export const DB: D1Database = TEST_ENV.DB;
export const IG_ID = "17841400000000001";

export interface SentCall {
  kind: "private_reply" | "dm" | "public_reply" | "follow_check";
  target: string;
  text?: string;
  msg?: OutgoingMessage;
}

type SendMode = "ok" | "fail" | "uncertain" | "window_closed" | "rate_limited";

/** Scriptable Meta mock that records every call. No network access. */
export class MockMeta implements MetaClient {
  calls: SentCall[] = [];
  follow: FollowCheckOutcome[] = [];
  privateReply: SendMode = "ok";
  dm: SendMode = "ok";
  publicReply: SendMode = "ok";

  private res(mode: SendMode): MetaResult<{ message_id?: string; id?: string }> {
    switch (mode) {
      case "ok":
        return { ok: true, httpStatus: 200, data: { message_id: "mid_" + this.calls.length, id: "c_" + this.calls.length } };
      case "fail":
        return { ok: false, error: { kind: "permanent", httpStatus: 400, code: 100, message: "mock failure" } };
      case "uncertain":
        return { ok: false, error: { kind: "uncertain", message: "network: AbortError" } };
      case "window_closed":
        return { ok: false, error: { kind: "window_closed", httpStatus: 400, code: 10, subcode: 2534022, message: "outside of allowed window" } };
      case "rate_limited":
        return { ok: false, error: { kind: "rate_limited", httpStatus: 429, code: 4, message: "rate", retryAfterMs: 1000 } };
    }
  }
  async sendPrivateReply(_t: string, _ig: string, commentId: string, msg: OutgoingMessage) {
    this.calls.push({ kind: "private_reply", target: commentId, text: msg.text, msg });
    return this.res(this.privateReply);
  }
  async sendMessage(_t: string, _ig: string, recipientId: string, msg: OutgoingMessage) {
    this.calls.push({ kind: "dm", target: recipientId, text: msg.text, msg });
    return this.res(this.dm);
  }
  async replyToComment(_t: string, commentId: string, text: string) {
    this.calls.push({ kind: "public_reply", target: commentId, text });
    return this.res(this.publicReply);
  }
  async checkFollow(_t: string, igsid: string): Promise<FollowCheckOutcome> {
    this.calls.push({ kind: "follow_check", target: igsid });
    return this.follow.length > 1 ? this.follow.shift()! : (this.follow[0] ?? { result: "unknown", fieldPresent: false });
  }
  sends() {
    return this.calls.filter((c) => c.kind !== "follow_check");
  }
}

export function makeCtx(meta: MockMeta, clock?: { t: number }): EngineContext {
  return {
    db: DB,
    now: () => (clock ? clock.t : Date.now()),
    meta: () => meta,
    getAccessToken: async () => "test-token",
    onAuthError: async (a, m) => {
      await DB.prepare("UPDATE instagram_accounts SET status = 'needs_reauth', last_error = ? WHERE id = ?").bind(m, a.id).run();
    },
  };
}

const TABLES = [
  "action_attempts",
  "action_jobs",
  "follow_checks",
  "conversation_flows",
  "participants",
  "webhook_events",
  "campaign_keywords",
  "campaign_media",
  "campaigns",
  "media_cache",
  "instagram_accounts",
  "sessions",
  "oauth_states",
  "rate_limits",
  "admin_users",
  "audit_logs",
];

export async function resetDb() {
  await DB.batch(TABLES.map((t) => DB.prepare(`DELETE FROM ${t}`)));
  await DB.prepare("UPDATE app_settings SET value = 'true' WHERE key IN ('automation_enabled','any_reply_counts_as_start')").run();
  await DB.prepare("UPDATE app_settings SET value = '10' WHERE key = 'global_user_hourly_limit'").run();
}

export async function seedAccount(opts: { username?: string } = {}) {
  const now = Date.now();
  await DB.prepare(
    `INSERT INTO instagram_accounts (ig_user_id, app_scoped_id, username, status, token_ciphertext, token_iv, created_at, updated_at)
     VALUES (?, 'app_scoped_1', ?, 'active', 'x', 'y', ?, ?)`,
  )
    .bind(IG_ID, opts.username ?? "hsn_shop", now, now)
    .run();
  return (await DB.prepare("SELECT id FROM instagram_accounts WHERE ig_user_id = ?").bind(IG_ID).first<{ id: number }>())!.id;
}

export interface CampaignSeed {
  name?: string;
  type?: "comment" | "story_reply" | "story_mention";
  priority?: number;
  require_follow?: boolean;
  match_all?: boolean;
  keywords?: Array<{ keyword: string; kind?: "include" | "exclude"; match_type?: "exact" | "word" | "contains" }>;
  final_text?: string;
  final_url?: string | null;
  opening_text?: string | null;
  public_reply_enabled?: boolean;
  public_reply_text?: string | null;
  public_reply_on_dm_fail?: "none" | "fallback";
  public_reply_fallback_text?: string | null;
  scope?: "all" | "selected";
  media_ids?: string[];
  include_replies?: boolean;
  activated_at?: number;
  per_user_cooldown_hours?: number;
  max_deliveries_per_user?: number;
  max_verify_attempts?: number;
  verify_cooldown_seconds?: number;
  status?: string;
}

export async function seedCampaign(c: CampaignSeed = {}) {
  const now = Date.now();
  const r = await DB.prepare(
    `INSERT INTO campaigns (name, type, status, priority, scope, match_all, include_replies, require_follow, opening_text, final_text, final_url,
       public_reply_enabled, public_reply_text, public_reply_on_dm_fail, public_reply_fallback_text, per_user_cooldown_hours, max_deliveries_per_user,
       max_verify_attempts, verify_cooldown_seconds, activated_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  )
    .bind(
      c.name ?? "حملة",
      c.type ?? "comment",
      c.status ?? "active",
      c.priority ?? 100,
      c.scope ?? "all",
      c.match_all ? 1 : 0,
      c.include_replies ? 1 : 0,
      c.require_follow ? 1 : 0,
      c.opening_text ?? null,
      c.final_text ?? "تفضل الكورس 🎁 {{content_url}}",
      c.final_url === undefined ? "https://example.com/secret-course" : c.final_url,
      c.public_reply_enabled ? 1 : 0,
      c.public_reply_text ?? null,
      c.public_reply_on_dm_fail ?? "none",
      c.public_reply_fallback_text ?? null,
      c.per_user_cooldown_hours ?? 0,
      c.max_deliveries_per_user ?? 1,
      c.max_verify_attempts ?? 5,
      c.verify_cooldown_seconds ?? 5,
      c.activated_at ?? now - 60_000,
      now,
      now,
    )
    .first<{ id: number }>();
  const id = r!.id;
  for (const k of c.keywords ?? [{ keyword: "كورس" }]) {
    await DB.prepare("INSERT INTO campaign_keywords (campaign_id, keyword, kind, match_type) VALUES (?, ?, ?, ?)")
      .bind(id, k.keyword, k.kind ?? "include", k.match_type ?? "contains")
      .run();
  }
  for (const m of c.media_ids ?? []) await DB.prepare("INSERT INTO campaign_media (campaign_id, media_id) VALUES (?, ?)").bind(id, m).run();
  return id;
}

let seq = 0;
export const uid = (p: string) => `${p}${Date.now()}${++seq}`;

// ---- Webhook payload builders following Meta's documented Instagram webhook shapes ----
export function commentPayload(o: { text: string; from?: string; username?: string; commentId?: string; mediaId?: string; parentId?: string; time?: number }) {
  return {
    object: "instagram",
    entry: [
      {
        id: IG_ID,
        time: Math.floor((o.time ?? Date.now()) / 1000),
        changes: [
          {
            field: "comments",
            value: {
              from: { id: o.from ?? "igsid_user_1", username: o.username ?? "user_one" },
              media: { id: o.mediaId ?? "media_1", media_product_type: "REELS" },
              id: o.commentId ?? uid("comment_"),
              ...(o.parentId ? { parent_id: o.parentId } : {}),
              text: o.text,
            },
          },
        ],
      },
    ],
  };
}

export function messagePayload(o: { from?: string; text?: string; mid?: string; storyReply?: { id: string; url?: string }; storyMention?: boolean; quickReply?: string; postback?: string; echo?: boolean; time?: number }) {
  const t = o.time ?? Date.now();
  const message: Record<string, unknown> = { mid: o.mid ?? uid("mid_") };
  if (o.text !== undefined) message.text = o.text;
  if (o.echo) message.is_echo = true;
  if (o.storyReply) message.reply_to = { story: { url: o.storyReply.url ?? "https://lookaside.fbsbx.com/story", id: o.storyReply.id } };
  if (o.storyMention) message.attachments = [{ type: "story_mention", payload: { url: "https://lookaside.fbsbx.com/mention" } }];
  if (o.quickReply) message.quick_reply = { payload: o.quickReply };
  const messaging: Record<string, unknown> = {
    sender: { id: o.echo ? IG_ID : (o.from ?? "igsid_user_1") },
    recipient: { id: o.echo ? (o.from ?? "igsid_user_1") : IG_ID },
    timestamp: t,
  };
  if (o.postback) messaging.postback = { mid: o.mid ?? uid("pb_"), title: "تحقّق من المتابعة", payload: o.postback };
  else messaging.message = message;
  return { object: "instagram", entry: [{ id: IG_ID, time: t, messaging: [messaging] }] };
}

/** Stores a webhook payload exactly like the POST handler and drains the queue with the mock client. */
export async function deliver(payload: unknown, meta: MockMeta, clock?: { t: number }) {
  const events = await parseWebhook(payload, clock?.t);
  await storeEvents(DB, events, { now: clock?.t });
  await drain(meta, clock);
  return events;
}

export async function drain(meta: MockMeta, clock?: { t: number }) {
  for (let i = 0; i < 10; i++) {
    const r = await runQueue(makeCtx(meta, clock), { maxJobs: 50 });
    if (r.processed === 0) break;
  }
}

export async function flowsOf(igsid = "igsid_user_1") {
  return (
    await DB.prepare("SELECT f.* FROM conversation_flows f JOIN participants p ON p.id = f.participant_id WHERE p.igsid = ? ORDER BY f.id").bind(igsid).all<any>()
  ).results;
}

export async function lastEvent() {
  return DB.prepare("SELECT * FROM webhook_events ORDER BY id DESC LIMIT 1").first<any>();
}

export const following = (): FollowCheckOutcome => ({ result: "following", fieldPresent: true, httpStatus: 200 });
export const notFollowing = (): FollowCheckOutcome => ({ result: "not_following", fieldPresent: true, httpStatus: 200 });
export const unknownField = (): FollowCheckOutcome => ({ result: "unknown", fieldPresent: false, httpStatus: 200 });
export const needsInteraction = (): FollowCheckOutcome => ({ result: "needs_interaction", fieldPresent: false, httpStatus: 400, errorCode: "230" });
export const apiError = (): FollowCheckOutcome => ({ result: "temporary_error", fieldPresent: false, httpStatus: 500, errorCode: "2", error: { kind: "permanent", message: "boom" } });
export const unsupported = (): FollowCheckOutcome => ({ result: "unsupported", fieldPresent: false, httpStatus: 400, errorCode: "10", error: { kind: "permission", message: "no permission" } });
