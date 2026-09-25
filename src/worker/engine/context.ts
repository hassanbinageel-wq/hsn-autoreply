import type { MetaClient } from "../meta/types";
import { canTransition, type FlowState } from "../../shared/states";
import { first, run } from "../lib/db";

export interface EngineContext {
  db: D1Database;
  now: () => number;
  /** Real Meta client for production rows, simulator for demo rows. */
  meta: (isDemo: boolean) => MetaClient;
  /** Returns the decrypted access token for an account (or a placeholder for demo). */
  getAccessToken: (account: AccountRow) => Promise<string | null>;
  /** Called when Meta reports that the token is no longer valid. */
  onAuthError?: (account: AccountRow, message: string) => Promise<void>;
}

export interface AccountRow {
  id: number;
  ig_user_id: string;
  app_scoped_id: string | null;
  username: string | null;
  is_demo: number;
  status: string;
  follow_check_support: string;
}

export interface CampaignRow {
  id: number;
  name: string;
  type: "comment" | "story_reply" | "story_mention";
  status: string;
  priority: number;
  scope: "all" | "selected";
  match_all: number;
  unify_alef: number;
  include_replies: number;
  require_follow: number;
  opening_text: string | null;
  follow_request_text: string | null;
  follow_reminder_text: string | null;
  verify_error_text: string | null;
  final_text: string;
  final_url: string | null;
  public_reply_enabled: number;
  public_reply_text: string | null;
  public_reply_on_dm_fail: "none" | "fallback";
  public_reply_fallback_text: string | null;
  schedule_start: number | null;
  schedule_end: number | null;
  per_user_cooldown_hours: number;
  max_deliveries_per_user: number;
  max_verify_attempts: number;
  verify_cooldown_seconds: number;
  process_old_events: number;
  activated_at: number | null;
  deleted_at: number | null;
}

export interface ParticipantRow {
  id: number;
  account_id: number;
  igsid: string;
  username: string | null;
  is_demo: number;
  last_user_message_at: number | null;
  consent_at: number | null;
  last_follow_status: string | null;
  last_follow_checked_at: number | null;
  demo_follow_script: string | null;
}

export interface FlowRow {
  id: number;
  account_id: number;
  campaign_id: number;
  participant_id: number;
  trigger_event_id: number | null;
  trigger_type: string;
  source_comment_id: string | null;
  source_media_id: string | null;
  state: FlowState;
  is_demo: number;
  start_token: string;
  verify_token: string;
  private_reply_status: string | null;
  public_reply_status: string | null;
  content_status: string | null;
  verify_attempts: number;
  verify_window_start: number | null;
  last_verify_at: number | null;
  last_follow_result: string | null;
  content_delivered_at: number | null;
  state_reason: string | null;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
}

export const MESSAGING_WINDOW_MS = 24 * 60 * 60 * 1000;
export const PRIVATE_REPLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const FLOW_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function windowOpen(p: ParticipantRow, now: number): boolean {
  return !!p.last_user_message_at && now - p.last_user_message_at < MESSAGING_WINDOW_MS;
}

/**
 * Moves a flow to a new state using optimistic concurrency: the update only applies if the flow is
 * still in the expected state. Returns false if another worker changed it first or the transition is invalid.
 */
export async function transitionFlow(
  ctx: EngineContext,
  flow: FlowRow,
  to: FlowState,
  extra: Partial<Record<keyof FlowRow, unknown>> = {},
  reason?: string,
): Promise<boolean> {
  if (flow.state !== to && !canTransition(flow.state, to)) return false;
  const now = ctx.now();
  const sets = ["state = ?", "updated_at = ?", "state_reason = ?"];
  const vals: unknown[] = [to, now, reason ?? null];
  for (const [k, v] of Object.entries(extra)) {
    sets.push(`${k} = ?`);
    vals.push(v);
  }
  const r = await run(
    ctx.db,
    `UPDATE conversation_flows SET ${sets.join(", ")} WHERE id = ? AND state = ?`,
    ...vals,
    flow.id,
    flow.state,
  );
  if ((r.meta?.changes ?? 0) > 0) {
    Object.assign(flow, extra, { state: to, updated_at: now, state_reason: reason ?? null });
    return true;
  }
  return false;
}

export async function loadFlow(db: D1Database, id: number): Promise<FlowRow | null> {
  return first<FlowRow>(db, "SELECT * FROM conversation_flows WHERE id = ?", id);
}
export async function loadCampaign(db: D1Database, id: number): Promise<CampaignRow | null> {
  return first<CampaignRow>(db, "SELECT * FROM campaigns WHERE id = ?", id);
}
export async function loadParticipant(db: D1Database, id: number): Promise<ParticipantRow | null> {
  return first<ParticipantRow>(db, "SELECT * FROM participants WHERE id = ?", id);
}
export async function loadAccount(db: D1Database, id: number): Promise<AccountRow | null> {
  return first<AccountRow>(db, "SELECT * FROM instagram_accounts WHERE id = ?", id);
}
