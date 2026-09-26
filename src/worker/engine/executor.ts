import { renderTemplate, claimsDelivery, contentLinkButton, pickVariant, publicReplyVariants, SAFE_PUBLIC_REPLIES } from "../../shared/template";
import { TERMINAL_FLOW_STATES } from "../../shared/states";
import { first, getSetting, run } from "../lib/db";
import type { MetaError, OutgoingMessage, QuickReply } from "../meta/types";
import {
  loadAccount,
  loadCampaign,
  loadFlow,
  loadParticipant,
  PRIVATE_REPLY_WINDOW_MS,
  transitionFlow,
  windowOpen,
  type AccountRow,
  type CampaignRow,
  type EngineContext,
  type FlowRow,
  type ParticipantRow,
} from "./context";
import { buttonPayload, processEvent, type EventRow } from "./events";
import {
  AUTO_RECHECK,
  AUTO_RECHECK_DELAY_MS,
  claimNextJob,
  enqueue,
  finishJob,
  markExternalStart,
  recordAttempt,
  recoverStaleLeases,
  scheduleRetry,
  VERIFY_CHECK,
  type JobRow,
} from "./jobs";

export const FOLLOW_FRESHNESS_MS = 10 * 60_000;
const DEFAULTS = {
  opening: "حياك الله 🙌 رد بكلمة ابدأ عشان أتحقق من المتابعة وأرسل لك المحتوى.",
  follow_request:
    "باقي خطوة بسيطة 🔥 تابع حسابنا {{account_link}} ثم ارجع هنا واضغط «تحقّق من المتابعة» عشان أوصلك المحتوى.",
  reminder: "لسا ما ظهرت لنا متابعتك 🙏 تأكد إنك تابعت {{account_link}} ثم جرّب «تحقق» بعد دقيقة.",
  verify_error: "ما قدرنا نتحقق من المتابعة الآن ⏳ ما راح نرسل المحتوى قبل التحقق. جرّب تكتب «تحقق» بعد شوي.",
  verify_unavailable: "نعتذر 🙏 التحقق من المتابعة غير متاح حاليًا، ولن نتمكن من إرسال المحتوى تلقائيًا.",
  verify_limit: "وصلت للحد الأعلى من محاولات التحقق حاليًا 🙏 جرّب مرة ثانية لاحقًا بكتابة «تحقق».",
  start_prompt: "للمتابعة اضغط «ابدأ» أو اكتب: ابدأ",
};

interface Loaded {
  flow: FlowRow;
  campaign: CampaignRow;
  participant: ParticipantRow;
  account: AccountRow;
}

async function loadAll(ctx: EngineContext, job: JobRow): Promise<Loaded | null> {
  if (!job.flow_id) return null;
  const flow = await loadFlow(ctx.db, job.flow_id);
  if (!flow) return null;
  const [campaign, participant, account] = await Promise.all([
    loadCampaign(ctx.db, flow.campaign_id),
    loadParticipant(ctx.db, flow.participant_id),
    loadAccount(ctx.db, flow.account_id),
  ]);
  if (!campaign || !participant || !account) return null;
  return { flow, campaign, participant, account };
}

/** Common guards before any Meta call. Returns a cancellation reason or null. */
async function guard(ctx: EngineContext, l: Loaded): Promise<string | null> {
  if (l.account.status !== "active") return "account_not_active";
  if (l.flow.is_demo) return null; // demo flows ignore production switches
  if (!(await getSetting(ctx.db, "automation_enabled", true))) return "automation_paused";
  if (l.campaign.deleted_at) return "campaign_deleted";
  if (l.campaign.status !== "active") return "campaign_not_active";
  return null;
}

function accountLink(a: AccountRow): string {
  return a.username ? `https://www.instagram.com/${a.username}` : "";
}

/** Removes the protected content URL from any non-content message (defence against template mistakes). */
function stripContent(text: string, url: string | null): string {
  if (!url) return text;
  return text.split(url).join("").trim();
}

export { contentLinkButton, LINK_BUTTON_TITLE } from "../../shared/template";

export function buildMessage(
  purpose: string,
  l: Loaded,
  channel: "private_reply" | "dm",
): OutgoingMessage {
  const c = l.campaign;
  const vars = {
    username: l.participant.username,
    account_username: l.account.username,
    account_link: accountLink(l.account),
    content_url: "",
    first_name: null,
  };
  // DMs get quick replies; the private reply gets a postback button (with automatic text-only fallback).
  const verifyQR: QuickReply[] = [{ title: "تحقّق من المتابعة", payload: buttonPayload("verify", l.flow.verify_token) }];
  const startQR: QuickReply[] = [{ title: "ابدأ", payload: buttonPayload("start", l.flow.start_token) }];
  const verifyFallback = (t: string) => (/تحقق|تحقّق/.test(t) ? t : `${t}\n(أو اكتب: تحقق)`);
  let text: string;
  let quickReplies: QuickReply[] = [];

  switch (purpose) {
    case "content": {
      const body = c.final_text?.trim() ? c.final_text : "تفضل 🎁 {{content_url}}";
      text = renderTemplate(body, { ...vars, content_url: c.final_url ?? "" });
      if (c.final_url && !text.includes(c.final_url)) text = `${text}\n${c.final_url}`.trim();
      return { text, linkButton: contentLinkButton(text, c.final_url) };
    }
    case "opening":
      text = renderTemplate(c.opening_text || DEFAULTS.opening, vars);
      if (!/ابدأ|ابدا/.test(text)) text = `${text}\n(رد بكلمة: ابدأ)`;
      quickReplies = startQR;
      break;
    case "follow_request":
      text = verifyFallback(renderTemplate(c.follow_request_text || DEFAULTS.follow_request, vars));
      quickReplies = verifyQR;
      break;
    case "reminder":
      text = verifyFallback(renderTemplate(c.follow_reminder_text || DEFAULTS.reminder, vars));
      quickReplies = verifyQR;
      break;
    case "verify_error":
      text = verifyFallback(renderTemplate(c.verify_error_text || DEFAULTS.verify_error, vars));
      quickReplies = verifyQR;
      break;
    case "verify_unavailable":
      text = DEFAULTS.verify_unavailable;
      break;
    case "verify_limit":
      text = DEFAULTS.verify_limit;
      break;
    case "start_prompt":
      text = DEFAULTS.start_prompt;
      quickReplies = startQR;
      break;
    default:
      throw new Error(`unknown purpose ${purpose}`);
  }
  // The protected content never leaves the server before eligibility.
  text = stripContent(text, c.final_url);
  return { text, quickReplies: quickReplies.length ? quickReplies : undefined };
}

/** First message of a comment flow goes out as the (single) private reply; later ones as DMs. */
function channelFor(flow: FlowRow): "private_reply" | "dm" {
  return flow.source_comment_id && !flow.private_reply_status ? "private_reply" : "dm";
}

async function eventTime(db: D1Database, eventId: number | null, fallback: number): Promise<number> {
  if (!eventId) return fallback;
  const r = await first<{ event_time: number }>(db, "SELECT event_time FROM webhook_events WHERE id = ?", eventId);
  return r?.event_time ?? fallback;
}

type ExecResult = { outcome: string; error?: MetaError };

export async function executeJob(ctx: EngineContext, job: JobRow, owner: string): Promise<ExecResult> {
  switch (job.kind) {
    case "process_event":
      return execProcessEvent(ctx, job, owner);
    case "follow_check":
      return execFollowCheck(ctx, job, owner);
    case "send_message":
      return execSendMessage(ctx, job, owner);
    case "public_reply":
      return execPublicReply(ctx, job, owner);
  }
  await finishJob(ctx.db, job, owner, "failed", ctx.now(), { error: "unknown job kind" });
  return { outcome: "failed" };
}

async function execProcessEvent(ctx: EngineContext, job: JobRow, owner: string): Promise<ExecResult> {
  const row = await first<EventRow>(ctx.db, "SELECT * FROM webhook_events WHERE id = ?", job.event_id);
  if (!row) {
    await finishJob(ctx.db, job, owner, "failed", ctx.now(), { error: "event missing" });
    return { outcome: "failed" };
  }
  const payload = JSON.parse(job.payload || "{}") as { forcedCampaignId?: number };
  const out = await processEvent(ctx, row, { forcedCampaignId: payload.forcedCampaignId });
  const now = ctx.now();
  await run(
    ctx.db,
    "UPDATE webhook_events SET status = ?, reason = ?, campaign_id = ?, flow_id = ?, processed_at = ? WHERE id = ?",
    out.status,
    out.details?.length ? `${out.reason} (${out.details.join(", ")})` : out.reason,
    out.campaignId ?? null,
    out.flowId ?? null,
    now,
    row.id,
  );
  await finishJob(ctx.db, job, owner, "accepted", now, { result: out });
  return { outcome: out.status };
}

async function cancelFlowAndJob(ctx: EngineContext, job: JobRow, owner: string, l: Loaded | null, reason: string): Promise<ExecResult> {
  if (l && !TERMINAL_FLOW_STATES.includes(l.flow.state)) await transitionFlow(ctx, l.flow, "cancelled", {}, reason);
  await finishJob(ctx.db, job, owner, "cancelled", ctx.now(), { error: reason });
  return { outcome: "cancelled" };
}

async function execFollowCheck(ctx: EngineContext, job: JobRow, owner: string): Promise<ExecResult> {
  const l = await loadAll(ctx, job);
  if (!l) return cancelFlowAndJob(ctx, job, owner, null, "flow_missing");
  // A silent automatic re-check only runs while the flow is still waiting for the follow (no other check in flight).
  const silent = job.purpose === AUTO_RECHECK;
  if (silent && l.flow.state !== "awaiting_follow") {
    await finishJob(ctx.db, job, owner, "cancelled", ctx.now(), { error: `flow state is ${l.flow.state}` });
    return { outcome: "cancelled" };
  }
  if (!silent && l.flow.state !== "checking_follow") {
    await finishJob(ctx.db, job, owner, "cancelled", ctx.now(), { error: `flow state is ${l.flow.state}` });
    return { outcome: "cancelled" };
  }
  const g = await guard(ctx, l);
  if (g) return cancelFlowAndJob(ctx, job, owner, l, g);
  if (silent && !(await transitionFlow(ctx, l.flow, "checking_follow", {}, "auto_recheck"))) {
    await finishJob(ctx.db, job, owner, "cancelled", ctx.now(), { error: "flow changed" });
    return { outcome: "cancelled" };
  }

  const token = await ctx.getAccessToken(l.account);
  const started = ctx.now();
  const outcome = token
    ? await ctx.meta(l.flow.is_demo === 1).checkFollow(token, l.participant.igsid)
    : { result: "temporary_error" as const, fieldPresent: false, errorCode: "no_token" };
  const now = ctx.now();
  await recordAttempt(ctx.db, job, started, now, outcome.result, {
    httpStatus: outcome.httpStatus,
    errorCode: outcome.errorCode,
    errorMessage: outcome.error?.message,
  });

  if (outcome.error?.kind === "auth") await ctx.onAuthError?.(l.account, outcome.error.message);
  // Short transient errors are retried silently a couple of times before telling the user.
  if (!silent && outcome.result === "temporary_error" && outcome.error && ["rate_limited", "retryable"].includes(outcome.error.kind) && job.attempts < 3) {
    await scheduleRetry(ctx.db, job, owner, now, outcome.error.message, outcome.error.retryAfterMs);
    return { outcome: "retry_scheduled", error: outcome.error };
  }

  await run(
    ctx.db,
    "INSERT INTO follow_checks (flow_id, participant_id, result, field_present, http_status, error_code, is_demo, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    l.flow.id,
    l.participant.id,
    outcome.result,
    outcome.fieldPresent ? 1 : 0,
    outcome.httpStatus ?? null,
    outcome.errorCode ?? null,
    l.flow.is_demo,
    now,
  );
  await run(
    ctx.db,
    "UPDATE participants SET last_follow_status = ?, last_follow_checked_at = ?, updated_at = ? WHERE id = ?",
    outcome.result,
    now,
    now,
    l.participant.id,
  );
  if (!l.flow.is_demo) {
    if (outcome.result === "unsupported") {
      await run(
        ctx.db,
        "UPDATE instagram_accounts SET follow_check_support = 'unsupported', follow_check_note = ?, updated_at = ? WHERE id = ?",
        `Meta: ${outcome.error?.message ?? "field not available"} (code ${outcome.errorCode ?? "?"})`,
        now,
        l.account.id,
      );
    } else if (outcome.fieldPresent) {
      await run(
        ctx.db,
        "UPDATE instagram_accounts SET follow_check_support = 'supported', follow_check_note = NULL, updated_at = ? WHERE id = ?",
        now,
        l.account.id,
      );
    }
  }

  const common = { accountId: l.account.id, flowId: l.flow.id, campaignId: l.campaign.id, isDemo: l.flow.is_demo === 1 };
  const prev = l.flow.last_follow_result;
  if (silent && outcome.result !== "following") {
    // Nothing changed yet: go back to waiting without messaging the person (they already got a reply to their tap).
    const extra = outcome.result === "not_following" ? { last_follow_result: "not_following" } : {};
    await transitionFlow(ctx, l.flow, "awaiting_follow", extra, `auto_recheck_${outcome.result}`);
    await finishJob(ctx.db, job, owner, "accepted", now, { result: { follow: outcome.result, field_present: outcome.fieldPresent, silent: true } });
    return { outcome: outcome.result };
  }
  switch (outcome.result) {
    case "following":
      await transitionFlow(ctx, l.flow, "ready_to_deliver", { last_follow_result: "following" }, "follow_verified");
      await enqueue(ctx.db, { ...common, kind: "send_message", purpose: "content", dedupKey: `deliver:${l.flow.id}` }, now);
      break;
    case "not_following": {
      await transitionFlow(ctx, l.flow, "awaiting_follow", { last_follow_result: "not_following" }, "not_following");
      const purpose = prev === "not_following" ? "reminder" : "follow_request";
      await enqueue(ctx.db, { ...common, kind: "send_message", purpose, dedupKey: `msg:${l.flow.id}:${purpose}:${job.id}` }, now);
      // The person just said they followed, but Instagram can take a few seconds to reflect it:
      // re-check once, quietly, so the content arrives on its own if the follow lands shortly after.
      if (job.purpose === VERIFY_CHECK) {
        await enqueue(ctx.db, { ...common, kind: "follow_check", purpose: AUTO_RECHECK, runAt: now + AUTO_RECHECK_DELAY_MS, dedupKey: `recheck:${l.flow.id}:${job.id}` }, now);
      }
      break;
    }
    case "needs_interaction":
      await transitionFlow(ctx, l.flow, "awaiting_user_interaction", { last_follow_result: "needs_interaction" }, "needs_interaction");
      if (channelFor(l.flow) === "private_reply") {
        await enqueue(ctx.db, { ...common, kind: "send_message", purpose: "opening", dedupKey: `opening:${l.flow.id}` }, now);
      } else if (windowOpen(l.participant, now)) {
        await enqueue(ctx.db, { ...common, kind: "send_message", purpose: "start_prompt", dedupKey: `msg:${l.flow.id}:start_prompt:${job.id}` }, now);
      }
      break;
    case "unsupported":
      await transitionFlow(ctx, l.flow, "verification_unavailable", { last_follow_result: "unsupported" }, outcome.errorCode ?? "unsupported");
      await enqueue(ctx.db, { ...common, kind: "send_message", purpose: "verify_unavailable", dedupKey: `msg:${l.flow.id}:verify_unavailable` }, now);
      break;
    default: // unknown | temporary_error — never treated as "not following", never delivers
      await transitionFlow(ctx, l.flow, "awaiting_follow", { last_follow_result: outcome.result }, outcome.errorCode ?? outcome.result);
      await enqueue(ctx.db, { ...common, kind: "send_message", purpose: "verify_error", dedupKey: `msg:${l.flow.id}:verify_error:${job.id}` }, now);
  }
  await finishJob(ctx.db, job, owner, "accepted", now, { result: { follow: outcome.result, field_present: outcome.fieldPresent } });
  return { outcome: outcome.result };
}

async function execSendMessage(ctx: EngineContext, job: JobRow, owner: string): Promise<ExecResult> {
  const l = await loadAll(ctx, job);
  if (!l) return cancelFlowAndJob(ctx, job, owner, null, "flow_missing");
  if (TERMINAL_FLOW_STATES.includes(l.flow.state) && !(job.purpose === "verify_unavailable" && l.flow.state === "verification_unavailable")) {
    await finishJob(ctx.db, job, owner, "cancelled", ctx.now(), { error: `flow ${l.flow.state}` });
    return { outcome: "cancelled" };
  }
  const g = await guard(ctx, l);
  if (g) return cancelFlowAndJob(ctx, job, owner, l, g);

  const purpose = job.purpose ?? "";
  let now = ctx.now();
  const isContent = purpose === "content";

  if (isContent) {
    // Re-check delivery limits and follow eligibility right before sending the protected content.
    if (l.campaign.max_deliveries_per_user > 0) {
      const d = await first<{ n: number }>(
        ctx.db,
        "SELECT COUNT(*) AS n FROM conversation_flows WHERE campaign_id = ? AND participant_id = ? AND state = 'content_sent'",
        l.campaign.id,
        l.participant.id,
      );
      if ((d?.n ?? 0) >= l.campaign.max_deliveries_per_user) return cancelFlowAndJob(ctx, job, owner, l, "max_deliveries_reached");
    }
    if (l.campaign.require_follow) {
      const fresh = l.flow.last_follow_result === "following" && !!l.participant.last_follow_checked_at && now - l.participant.last_follow_checked_at < FOLLOW_FRESHNESS_MS;
      if (!fresh) {
        if (l.flow.state === "delivering") await transitionFlow(ctx, l.flow, "ready_to_deliver", {}, "recheck_before_delivery");
        if (l.flow.state === "ready_to_deliver") {
          await transitionFlow(ctx, l.flow, "checking_follow", {}, "recheck_before_delivery");
          await enqueue(ctx.db, { kind: "follow_check", accountId: l.account.id, flowId: l.flow.id, campaignId: l.campaign.id, isDemo: l.flow.is_demo === 1, dedupKey: `follow:${l.flow.id}:recheck:${job.id}` }, now);
        }
        await finishJob(ctx.db, job, owner, "cancelled", now, { error: "follow status stale; re-check scheduled" });
        return { outcome: "cancelled" };
      }
    }
    if (l.flow.state === "ready_to_deliver" && !(await transitionFlow(ctx, l.flow, "delivering"))) {
      await finishJob(ctx.db, job, owner, "cancelled", now, { error: "flow changed concurrently" });
      return { outcome: "cancelled" };
    }
    if (l.flow.state !== "delivering") {
      await finishJob(ctx.db, job, owner, "cancelled", now, { error: `unexpected flow state ${l.flow.state}` });
      return { outcome: "cancelled" };
    }
  }

  const channel = channelFor(l.flow);
  if (channel === "private_reply") {
    const t = await eventTime(ctx.db, l.flow.trigger_event_id, l.flow.created_at);
    if (now - t > PRIVATE_REPLY_WINDOW_MS) {
      await transitionFlow(ctx, l.flow, "expired", { private_reply_status: "failed" }, "private_reply_window_expired");
      await finishJob(ctx.db, job, owner, "failed", now, { error: "private reply window (7 days) expired" });
      return { outcome: "failed" };
    }
  } else if (!windowOpen(l.participant, now)) {
    await transitionFlow(ctx, l.flow, "expired", isContent ? { content_status: "failed" } : {}, "messaging_window_closed");
    await finishJob(ctx.db, job, owner, "failed", now, { error: "messaging window closed (24h since last user message)" });
    return { outcome: "failed" };
  }

  const msg = buildMessage(purpose, l, channel);
  const token = await ctx.getAccessToken(l.account);
  if (!token) {
    await finishJob(ctx.db, job, owner, "failed", now, { error: "no access token" });
    return { outcome: "failed" };
  }
  if (!(await markExternalStart(ctx.db, job, owner, now))) return { outcome: "lease_lost" };
  const meta = ctx.meta(l.flow.is_demo === 1);
  const started = now;
  const r =
    channel === "private_reply"
      ? await meta.sendPrivateReply(token, l.account.ig_user_id, l.flow.source_comment_id!, msg)
      : await meta.sendMessage(token, l.account.ig_user_id, l.participant.igsid, msg);
  now = ctx.now();

  if (r.ok) {
    await recordAttempt(ctx.db, job, started, now, "accepted", { httpStatus: r.httpStatus });
    await finishJob(ctx.db, job, owner, "accepted", now, { result: { message_id: r.data.message_id, channel, text: l.flow.is_demo ? msg.text : undefined, quick_replies: l.flow.is_demo ? msg.quickReplies : undefined, link_button: l.flow.is_demo ? msg.linkButton : undefined } });
    if (channel === "private_reply") {
      await run(ctx.db, "UPDATE conversation_flows SET private_reply_status = 'accepted', updated_at = ? WHERE id = ?", now, l.flow.id);
      l.flow.private_reply_status = "accepted";
    }
    if (isContent) {
      await transitionFlow(ctx, l.flow, "content_sent", { content_status: "accepted", content_delivered_at: now }, "content_accepted_by_meta");
    }
    if (channel === "private_reply" && l.campaign.public_reply_enabled && l.flow.source_comment_id) {
      await enqueue(ctx.db, { kind: "public_reply", purpose: "success", accountId: l.account.id, flowId: l.flow.id, campaignId: l.campaign.id, isDemo: l.flow.is_demo === 1, dedupKey: `public_reply:${l.flow.source_comment_id}` }, now);
    }
    return { outcome: "accepted" };
  }

  const e = r.error;
  await recordAttempt(ctx.db, job, started, now, e.kind, { httpStatus: e.httpStatus, errorCode: e.code !== undefined ? String(e.code) : e.kind, errorMessage: e.message, retryAfterMs: e.retryAfterMs });
  if (e.kind === "uncertain") {
    await finishJob(ctx.db, job, owner, "uncertain", now, { error: e.message });
    await run(
      ctx.db,
      `UPDATE conversation_flows SET ${channel === "private_reply" ? "private_reply_status = 'uncertain'," : ""} ${isContent ? "content_status = 'uncertain'," : ""} state_reason = 'uncertain_needs_review', updated_at = ? WHERE id = ?`,
      now,
      l.flow.id,
    );
    return { outcome: "uncertain", error: e };
  }
  if (e.kind === "rate_limited" || e.kind === "retryable") {
    const st = await scheduleRetry(ctx.db, job, owner, now, e.message, e.retryAfterMs, { rateLimited: e.kind === "rate_limited" });
    if (st === "failed") await failFlow(ctx, l, channel, isContent, e.message);
    else if (isContent && l.flow.state === "delivering") await transitionFlow(ctx, l.flow, "ready_to_deliver", {}, "retry_scheduled");
    return { outcome: st, error: e };
  }
  if (e.kind === "auth") await ctx.onAuthError?.(l.account, e.message);
  await finishJob(ctx.db, job, owner, "failed", now, { error: `${e.kind}: ${e.message}` });
  if (e.kind === "window_closed") {
    await transitionFlow(ctx, l.flow, "expired", channel === "private_reply" ? { private_reply_status: "failed" } : {}, "messaging_window_closed");
  } else {
    await failFlow(ctx, l, channel, isContent, `${e.kind}: ${e.message}`);
  }
  if (channel === "private_reply" && l.campaign.public_reply_enabled && l.campaign.public_reply_on_dm_fail === "fallback" && l.campaign.public_reply_fallback_text && l.flow.source_comment_id) {
    await enqueue(ctx.db, { kind: "public_reply", purpose: "fallback", accountId: l.account.id, flowId: l.flow.id, campaignId: l.campaign.id, isDemo: l.flow.is_demo === 1, dedupKey: `public_reply:${l.flow.source_comment_id}` }, now);
  }
  return { outcome: "failed", error: e };
}

async function failFlow(ctx: EngineContext, l: Loaded, channel: string, isContent: boolean, reason: string) {
  const extra: Record<string, unknown> = {};
  if (channel === "private_reply") extra.private_reply_status = "failed";
  if (isContent) extra.content_status = "failed";
  const fresh = await loadFlow(ctx.db, l.flow.id);
  if (fresh && !TERMINAL_FLOW_STATES.includes(fresh.state)) await transitionFlow(ctx, fresh, "failed", extra, reason.slice(0, 200));
}

async function execPublicReply(ctx: EngineContext, job: JobRow, owner: string): Promise<ExecResult> {
  const l = await loadAll(ctx, job);
  if (!l || !l.flow.source_comment_id) {
    await finishJob(ctx.db, job, owner, "cancelled", ctx.now(), { error: "no comment" });
    return { outcome: "cancelled" };
  }
  const g = await guard(ctx, l);
  if (g) {
    await finishJob(ctx.db, job, owner, "cancelled", ctx.now(), { error: g });
    return { outcome: "cancelled" };
  }
  const vars = { username: l.participant.username, account_username: l.account.username, account_link: accountLink(l.account) };
  let text: string;
  // Several phrasings (one per line) rotate between comments so the replies don't look like spam.
  if (job.purpose === "fallback") {
    const pool = publicReplyVariants(l.campaign.public_reply_fallback_text);
    text = pool.length ? renderTemplate(pickVariant(pool, l.flow.id), vars) : "";
  } else {
    // A follow-gated campaign must not publicly claim delivery before the content was actually sent.
    const mustNotClaim = !!l.campaign.require_follow && l.flow.state !== "content_sent";
    let pool = publicReplyVariants(l.campaign.public_reply_text);
    if (mustNotClaim) pool = pool.filter((v) => !claimsDelivery(v));
    if (!pool.length) pool = SAFE_PUBLIC_REPLIES;
    text = renderTemplate(pickVariant(pool, l.flow.id), vars);
    if (mustNotClaim && claimsDelivery(text)) text = pickVariant(SAFE_PUBLIC_REPLIES, l.flow.id);
  }
  text = stripContent(text, l.campaign.final_url);
  let now = ctx.now();
  if (!text) {
    await finishJob(ctx.db, job, owner, "cancelled", now, { error: "empty public reply" });
    return { outcome: "cancelled" };
  }
  const token = await ctx.getAccessToken(l.account);
  if (!token) {
    await finishJob(ctx.db, job, owner, "failed", now, { error: "no access token" });
    return { outcome: "failed" };
  }
  if (!(await markExternalStart(ctx.db, job, owner, now))) return { outcome: "lease_lost" };
  const started = now;
  const r = await ctx.meta(l.flow.is_demo === 1).replyToComment(token, l.flow.source_comment_id, text);
  now = ctx.now();
  if (r.ok) {
    await recordAttempt(ctx.db, job, started, now, "accepted", { httpStatus: r.httpStatus });
    await finishJob(ctx.db, job, owner, "accepted", now, { result: { id: r.data.id, text: l.flow.is_demo ? text : undefined } });
    await run(ctx.db, "UPDATE conversation_flows SET public_reply_status = 'accepted', updated_at = ? WHERE id = ?", now, l.flow.id);
    return { outcome: "accepted" };
  }
  const e = r.error;
  await recordAttempt(ctx.db, job, started, now, e.kind, { httpStatus: e.httpStatus, errorCode: e.code !== undefined ? String(e.code) : e.kind, errorMessage: e.message });
  let status: string;
  if (e.kind === "uncertain") {
    await finishJob(ctx.db, job, owner, "uncertain", now, { error: e.message });
    status = "uncertain";
  } else if (e.kind === "rate_limited" || e.kind === "retryable") {
    status = await scheduleRetry(ctx.db, job, owner, now, e.message, e.retryAfterMs, { rateLimited: e.kind === "rate_limited" });
  } else {
    if (e.kind === "auth") await ctx.onAuthError?.(l.account, e.message);
    await finishJob(ctx.db, job, owner, "failed", now, { error: `${e.kind}: ${e.message}` });
    status = "failed";
  }
  await run(ctx.db, "UPDATE conversation_flows SET public_reply_status = ?, updated_at = ? WHERE id = ?", status, now, l.flow.id);
  return { outcome: status, error: e };
}

export interface RunQueueOptions {
  owner?: string;
  maxJobs?: number;
  leaseMs?: number;
  deadlineMs?: number;
  demoOnly?: boolean;
  includeDemo?: boolean;
  /** Stop when the external subrequest budget is nearly used (Workers Free: 50 per invocation). */
  budget?: { used: () => number; limit: number };
  /**
   * When the queue is empty, wait for a job that becomes due within this many ms (e.g. a follow re-check a few
   * seconds out) instead of leaving it to the next cron tick. Bounded by `deadlineMs`; sleeping uses no CPU time.
   */
  waitForSoonMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runQueue(ctx: EngineContext, o: RunQueueOptions = {}): Promise<{ processed: number; recovered: number }> {
  const owner = o.owner ?? crypto.randomUUID();
  const started = Date.now();
  const recovered = await recoverStaleLeases(ctx.db, ctx.now());
  let processed = 0;
  const maxJobs = o.maxJobs ?? 20;
  while (processed < maxJobs) {
    if (o.deadlineMs && Date.now() - started > o.deadlineMs) break;
    if (o.budget && o.budget.used() >= o.budget.limit - 4) break;
    const job = await claimNextJob(ctx.db, owner, ctx.now(), o.leaseMs ?? 60_000, { demoOnly: o.demoOnly, includeDemo: o.includeDemo });
    if (!job) {
      if (!o.waitForSoonMs) break;
      const next = await first<{ run_at: number }>(
        ctx.db,
        `SELECT MIN(run_at) AS run_at FROM action_jobs WHERE status IN ('pending','retry_scheduled') AND kind = 'follow_check'
           AND is_demo = ${o.demoOnly ? 1 : 0}`,
      );
      const wait = next?.run_at != null ? next.run_at - ctx.now() : Infinity;
      const left = o.deadlineMs ? o.deadlineMs - (Date.now() - started) : o.waitForSoonMs;
      if (wait > o.waitForSoonMs || wait + 500 > left) break;
      await sleep(Math.max(0, wait) + 200);
      continue;
    }
    processed++;
    try {
      await executeJob(ctx, job, owner);
    } catch (err) {
      const msg = String((err as Error)?.message ?? err).slice(0, 300);
      const fresh = await first<JobRow>(ctx.db, "SELECT * FROM action_jobs WHERE id = ?", job.id);
      if (fresh && fresh.status === "processing" && fresh.lease_owner === owner) {
        if (fresh.external_call_started_at && (fresh.kind === "send_message" || fresh.kind === "public_reply")) {
          await finishJob(ctx.db, fresh, owner, "uncertain", ctx.now(), { error: `internal error after send: ${msg}` });
        } else {
          await scheduleRetry(ctx.db, fresh, owner, ctx.now(), `internal error: ${msg}`);
        }
      }
    }
  }
  return { processed, recovered };
}
