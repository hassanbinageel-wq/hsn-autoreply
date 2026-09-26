import { containsControlWord, evaluateMatch, START_WORDS, VERIFY_WORDS, type KeywordRule } from "../../shared/match";
import { TERMINAL_FLOW_STATES } from "../../shared/states";
import { all, first, getSetting, isUniqueViolation, run } from "../lib/db";
import { randomToken } from "../lib/crypto";
import type { NormalizedEvent } from "../meta/webhook-parse";
import {
  FLOW_TTL_MS,
  loadFlow,
  transitionFlow,
  windowOpen,
  type AccountRow,
  type CampaignRow,
  type EngineContext,
  type FlowRow,
  type ParticipantRow,
} from "./context";
import { enqueue } from "./jobs";

export interface EventRow {
  id: number;
  dedup_key: string;
  account_ig_id: string;
  event_type: string;
  payload: string;
  is_demo: number;
  event_time: number;
}

export interface ProcessOutcome {
  status: "processed" | "ignored";
  reason: string;
  campaignId?: number;
  flowId?: number;
  details?: string[];
}

const TERMINAL_SQL = TERMINAL_FLOW_STATES.map((s) => `'${s}'`).join(",");
const BUTTON_RE = /^hsn:v1:(start|verify):([A-Za-z0-9_-]{16,64})$/;

export function buttonPayload(action: "start" | "verify", token: string): string {
  return `hsn:v1:${action}:${token}`;
}

export async function processEvent(ctx: EngineContext, row: EventRow, opts: { forcedCampaignId?: number } = {}): Promise<ProcessOutcome> {
  const ev = JSON.parse(row.payload) as NormalizedEvent;
  const isDemo = row.is_demo === 1;

  const account = await first<AccountRow>(
    ctx.db,
    "SELECT * FROM instagram_accounts WHERE ig_user_id = ? AND is_demo = ?",
    ev.accountIgId,
    isDemo ? 1 : 0,
  );
  if (!account) return { status: "ignored", reason: "unknown_account" };
  if (account.status !== "active") return { status: "ignored", reason: "account_not_active" };
  if (!isDemo && !(await getSetting(ctx.db, "automation_enabled", true))) {
    return { status: "ignored", reason: "automation_paused" };
  }

  switch (ev.kind) {
    case "echo":
      return { status: "ignored", reason: "message_echo" };
    case "reaction":
      return { status: "ignored", reason: "reaction_not_a_trigger" };
    case "other":
      return { status: "ignored", reason: "unsupported_event" };
  }
  if (!ev.senderId) return { status: "ignored", reason: "missing_sender" };
  if (
    ev.senderId === account.ig_user_id ||
    (account.app_scoped_id && ev.senderId === account.app_scoped_id) ||
    (ev.senderUsername && account.username && ev.senderUsername.toLowerCase() === account.username.toLowerCase())
  ) {
    return { status: "ignored", reason: "own_account" };
  }

  const isInbound = ev.kind !== "comment"; // DMs, story replies/mentions, quick replies, postbacks are user messages
  const participant = await upsertParticipant(ctx, account, ev, isInbound);

  switch (ev.kind) {
    case "comment":
    case "story_reply":
    case "story_mention":
      return triggerCampaign(ctx, row, ev, account, participant, opts.forcedCampaignId);
    case "quick_reply":
    case "postback":
      if (ev.buttonPayload && BUTTON_RE.test(ev.buttonPayload)) return routeButton(ctx, row, ev, participant);
      return routeControl(ctx, row, ev, participant);
    case "message":
      return routeControl(ctx, row, ev, participant);
  }
  return { status: "ignored", reason: "unsupported_event" };
}

async function upsertParticipant(ctx: EngineContext, account: AccountRow, ev: NormalizedEvent, inbound: boolean): Promise<ParticipantRow> {
  const now = ctx.now();
  const msgAt = inbound ? Math.min(ev.time, now) : null;
  await run(
    ctx.db,
    `INSERT INTO participants (account_id, igsid, username, is_demo, last_user_message_at, consent_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id, igsid) DO UPDATE SET
       username = COALESCE(excluded.username, participants.username),
       last_user_message_at = CASE WHEN excluded.last_user_message_at IS NOT NULL AND
            (participants.last_user_message_at IS NULL OR excluded.last_user_message_at > participants.last_user_message_at)
            THEN excluded.last_user_message_at ELSE participants.last_user_message_at END,
       consent_at = COALESCE(participants.consent_at, excluded.consent_at),
       updated_at = excluded.updated_at`,
    account.id,
    ev.senderId,
    ev.senderUsername ?? null,
    account.is_demo,
    msgAt,
    msgAt,
    now,
    now,
  );
  return (await first<ParticipantRow>(
    ctx.db,
    "SELECT * FROM participants WHERE account_id = ? AND igsid = ?",
    account.id,
    ev.senderId,
  ))!;
}

async function loadKeywords(db: D1Database, campaignId: number): Promise<KeywordRule[]> {
  const rows = await all<{ keyword: string; kind: "include" | "exclude"; match_type: KeywordRule["matchType"] }>(
    db,
    "SELECT keyword, kind, match_type FROM campaign_keywords WHERE campaign_id = ? ORDER BY id",
    campaignId,
  );
  return rows.map((r) => ({ keyword: r.keyword, kind: r.kind, matchType: r.match_type }));
}

async function inCampaignScope(db: D1Database, c: CampaignRow, mediaId?: string): Promise<boolean> {
  if (c.scope === "all") return true;
  if (!mediaId) return false;
  return !!(await first(db, "SELECT 1 AS ok FROM campaign_media WHERE campaign_id = ? AND media_id = ?", c.id, mediaId));
}

/** Evaluates one campaign for one event. Returns null on match, or the skip reason. */
async function evaluateCampaign(ctx: EngineContext, c: CampaignRow, ev: NormalizedEvent, forced: boolean): Promise<string | null> {
  if (!forced) {
    if (c.schedule_start && ev.time < c.schedule_start) return "outside_schedule";
    if (c.schedule_end && ev.time > c.schedule_end) return "outside_schedule";
    if (!c.process_old_events && c.activated_at && ev.time < c.activated_at) return "event_before_activation";
  }
  if (c.type === "comment") {
    if (ev.parentId && !c.include_replies) return "threaded_reply_excluded";
    if (!(await inCampaignScope(ctx.db, c, ev.mediaId))) return "media_not_in_scope";
  }
  if (c.type === "story_reply" && c.scope === "selected") {
    if (!ev.storyId) return "story_not_identifiable";
    if (!(await inCampaignScope(ctx.db, c, ev.storyId))) return "story_not_in_scope";
  }
  const keywords = await loadKeywords(ctx.db, c.id);
  // Story mentions usually carry no text: they match unless the campaign defines include keywords.
  const matchAll = !!c.match_all || (c.type === "story_mention" && !keywords.some((k) => k.kind === "include"));
  const m = evaluateMatch(ev.text ?? "", { matchAll, keywords, normalize: { unifyAlef: !!c.unify_alef } });
  return m.matched ? null : m.reason;
}

async function triggerCampaign(
  ctx: EngineContext,
  row: EventRow,
  ev: NormalizedEvent,
  account: AccountRow,
  participant: ParticipantRow,
  forcedCampaignId?: number,
): Promise<ProcessOutcome> {
  const type = ev.kind as CampaignRow["type"];
  const candidates = forcedCampaignId
    ? await all<CampaignRow>(ctx.db, "SELECT * FROM campaigns WHERE id = ? AND type = ? AND deleted_at IS NULL", forcedCampaignId, type)
    : await all<CampaignRow>(
        ctx.db,
        "SELECT * FROM campaigns WHERE type = ? AND status = 'active' AND deleted_at IS NULL ORDER BY priority DESC, id ASC",
        type,
      );
  if (!candidates.length) return { status: "ignored", reason: "no_active_campaign" };

  const details: string[] = [];
  let chosen: CampaignRow | null = null;
  for (const c of candidates) {
    const skip = await evaluateCampaign(ctx, c, ev, !!forcedCampaignId);
    if (skip === null) {
      chosen = c;
      break;
    }
    details.push(`${c.id}:${skip}`);
  }
  if (!chosen) return { status: "ignored", reason: details.length === 1 ? details[0].split(":")[1] : "no_matching_campaign", details };

  const now = ctx.now();
  // ---- repetition limits ----
  if (chosen.max_deliveries_per_user > 0) {
    const delivered = await first<{ n: number }>(
      ctx.db,
      "SELECT COUNT(*) AS n FROM conversation_flows WHERE campaign_id = ? AND participant_id = ? AND state = 'content_sent'",
      chosen.id,
      participant.id,
    );
    if ((delivered?.n ?? 0) >= chosen.max_deliveries_per_user) {
      return { status: "ignored", reason: "max_deliveries_reached", campaignId: chosen.id };
    }
  }
  if (chosen.per_user_cooldown_hours > 0) {
    const recent = await first(
      ctx.db,
      "SELECT id FROM conversation_flows WHERE campaign_id = ? AND participant_id = ? AND created_at > ? LIMIT 1",
      chosen.id,
      participant.id,
      now - chosen.per_user_cooldown_hours * 3_600_000,
    );
    if (recent) return { status: "ignored", reason: "user_cooldown", campaignId: chosen.id };
  }
  const hourlyLimit = await getSetting(ctx.db, "global_user_hourly_limit", 10);
  if (hourlyLimit > 0) {
    const n = await first<{ n: number }>(
      ctx.db,
      "SELECT COUNT(*) AS n FROM conversation_flows WHERE participant_id = ? AND created_at > ?",
      participant.id,
      now - 3_600_000,
    );
    if ((n?.n ?? 0) >= hourlyLimit) return { status: "ignored", reason: "user_hourly_limit", campaignId: chosen.id };
  }

  // ---- create the flow (unique partial index = at most one open flow per campaign+participant) ----
  let flowId: number;
  try {
    const r = await first<{ id: number }>(
      ctx.db,
      `INSERT INTO conversation_flows
        (account_id, campaign_id, participant_id, trigger_event_id, trigger_type, source_comment_id, source_media_id,
         state, is_demo, start_token, verify_token, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'trigger_received', ?, ?, ?, ?, ?, ?) RETURNING id`,
      account.id,
      chosen.id,
      participant.id,
      row.id,
      ev.kind,
      ev.commentId ?? null,
      ev.mediaId ?? ev.storyId ?? null,
      row.is_demo,
      randomToken(18),
      randomToken(18),
      now + FLOW_TTL_MS,
      now,
      now,
    );
    flowId = r!.id;
  } catch (err) {
    if (isUniqueViolation(err)) return { status: "ignored", reason: "flow_already_open", campaignId: chosen.id };
    throw err;
  }
  const flow = (await loadFlow(ctx.db, flowId))!;
  const common = { accountId: account.id, flowId, campaignId: chosen.id, isDemo: row.is_demo === 1 };

  if (!chosen.require_follow) {
    await transitionFlow(ctx, flow, "delivering");
    await enqueue(ctx.db, { ...common, kind: "send_message", purpose: "content", dedupKey: `deliver:${flowId}` }, now);
  } else if (ev.kind !== "comment" || (participant.consent_at && windowOpen(participant, now))) {
    // The user already messaged us (story reply / mention, or an earlier DM): check the follow status now.
    await transitionFlow(ctx, flow, "checking_follow");
    await enqueue(ctx.db, { ...common, kind: "follow_check", dedupKey: `follow:${flowId}:initial` }, now);
  } else {
    // A public comment alone does not grant User Profile consent → one private reply asking to reply "ابدأ".
    await transitionFlow(ctx, flow, "awaiting_user_interaction");
    await enqueue(ctx.db, { ...common, kind: "send_message", purpose: "opening", dedupKey: `opening:${flowId}` }, now);
  }
  return { status: "processed", reason: "campaign_matched", campaignId: chosen.id, flowId };
}

async function openFlows(db: D1Database, participantId: number): Promise<FlowRow[]> {
  return all<FlowRow>(
    db,
    `SELECT * FROM conversation_flows WHERE participant_id = ? AND state NOT IN (${TERMINAL_SQL}) ORDER BY updated_at DESC, id DESC`,
    participantId,
  );
}

async function routeButton(ctx: EngineContext, row: EventRow, ev: NormalizedEvent, participant: ParticipantRow): Promise<ProcessOutcome> {
  const [, action, token] = BUTTON_RE.exec(ev.buttonPayload!)!;
  const column = action === "start" ? "start_token" : "verify_token";
  const flow = await first<FlowRow>(ctx.db, `SELECT * FROM conversation_flows WHERE ${column} = ?`, token);
  // The opaque token must belong to this very participant — never trust the payload alone.
  if (!flow || flow.participant_id !== participant.id) return { status: "ignored", reason: "invalid_button_token" };
  if (TERMINAL_FLOW_STATES.includes(flow.state)) return { status: "ignored", reason: `flow_${flow.state}`, flowId: flow.id };
  if (action === "start" && flow.state === "awaiting_user_interaction") return handleStart(ctx, row, flow);
  return handleVerify(ctx, row, flow);
}

async function routeControl(ctx: EngineContext, row: EventRow, ev: NormalizedEvent, participant: ParticipantRow): Promise<ProcessOutcome> {
  const flows = await openFlows(ctx.db, participant.id);
  if (!flows.length) return { status: "ignored", reason: "plain_message_no_trigger" };
  const text = ev.text ?? "";
  const awaitingStart = flows.find((f) => f.state === "awaiting_user_interaction");
  const awaitingFollow = flows.find((f) => f.state === "awaiting_follow");

  if (containsControlWord(text, START_WORDS) || containsControlWord(text, VERIFY_WORDS)) {
    if (awaitingStart) return handleStart(ctx, row, awaitingStart);
    if (awaitingFollow) return handleVerify(ctx, row, awaitingFollow);
    return { status: "ignored", reason: "flow_busy", flowId: flows[0].id };
  }
  const anyReply = await getSetting(ctx.db, "any_reply_counts_as_start", true);
  if (awaitingStart && anyReply) return handleStart(ctx, row, awaitingStart);
  // A person waiting on the follow gate who writes anything (e.g. "تابعتك الحين") gets a FRESH check.
  // Cooldown + attempt limits still apply, and content is only sent if Meta returns following=true.
  if (awaitingFollow && anyReply) return handleVerify(ctx, row, awaitingFollow);
  return { status: "ignored", reason: "plain_message_no_trigger" };
}

async function handleStart(ctx: EngineContext, row: EventRow, flow: FlowRow): Promise<ProcessOutcome> {
  const ok = await transitionFlow(ctx, flow, "checking_follow", {}, "user_interaction");
  if (!ok) return { status: "ignored", reason: "flow_busy", flowId: flow.id };
  await enqueue(
    ctx.db,
    { kind: "follow_check", accountId: flow.account_id, flowId: flow.id, campaignId: flow.campaign_id, isDemo: flow.is_demo === 1, dedupKey: `follow:${flow.id}:ev${row.id}` },
    ctx.now(),
  );
  return { status: "processed", reason: "flow_start", campaignId: flow.campaign_id, flowId: flow.id };
}

async function handleVerify(ctx: EngineContext, row: EventRow, flow: FlowRow): Promise<ProcessOutcome> {
  const now = ctx.now();
  const campaign = await first<CampaignRow>(ctx.db, "SELECT * FROM campaigns WHERE id = ?", flow.campaign_id);
  if (!campaign) return { status: "ignored", reason: "campaign_missing", flowId: flow.id };
  if (flow.state !== "awaiting_follow") return { status: "ignored", reason: "flow_busy", flowId: flow.id };

  if (flow.last_verify_at && now - flow.last_verify_at < campaign.verify_cooldown_seconds * 1000) {
    return { status: "ignored", reason: "verify_cooldown", flowId: flow.id, campaignId: campaign.id };
  }
  let attempts = flow.verify_attempts;
  let windowStart = flow.verify_window_start;
  if (!windowStart || now - windowStart > 24 * 3_600_000) {
    attempts = 0;
    windowStart = now;
  }
  if (campaign.max_verify_attempts > 0 && attempts >= campaign.max_verify_attempts) {
    await enqueue(
      ctx.db,
      { kind: "send_message", purpose: "verify_limit", accountId: flow.account_id, flowId: flow.id, campaignId: flow.campaign_id, isDemo: flow.is_demo === 1, dedupKey: `verify_limit:${flow.id}:${windowStart}` },
      now,
    );
    return { status: "ignored", reason: "verify_attempts_exceeded", flowId: flow.id, campaignId: campaign.id };
  }
  const ok = await transitionFlow(
    ctx,
    flow,
    "checking_follow",
    { verify_attempts: attempts + 1, verify_window_start: windowStart, last_verify_at: now },
    "verify_requested",
  );
  if (!ok) return { status: "ignored", reason: "flow_busy", flowId: flow.id };
  await enqueue(
    ctx.db,
    { kind: "follow_check", accountId: flow.account_id, flowId: flow.id, campaignId: flow.campaign_id, isDemo: flow.is_demo === 1, dedupKey: `follow:${flow.id}:ev${row.id}` },
    now,
  );
  return { status: "processed", reason: "verify_requested", campaignId: campaign.id, flowId: flow.id };
}
