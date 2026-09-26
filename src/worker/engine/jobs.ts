import { all, first, run } from "../lib/db";

export type JobKind = "process_event" | "send_message" | "public_reply" | "follow_check";

/** follow_check purposes: a check the person asked for, and the one quiet automatic re-check that may follow it. */
export const VERIFY_CHECK = "verify";
export const AUTO_RECHECK = "auto_recheck";
export const AUTO_RECHECK_DELAY_MS = 15_000;

/** Jobs whose Meta call has side effects: an interrupted call means an uncertain outcome. */
export const SIDE_EFFECT_KINDS: readonly JobKind[] = ["send_message", "public_reply"];

export interface JobRow {
  id: number;
  account_id: number | null;
  kind: JobKind;
  purpose: string | null;
  flow_id: number | null;
  campaign_id: number | null;
  event_id: number | null;
  dedup_key: string;
  payload: string;
  is_demo: number;
  status: string;
  attempts: number;
  max_attempts: number;
  run_at: number;
  lease_owner: string | null;
  lease_expires_at: number | null;
  external_call_started_at: number | null;
  result: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export interface NewJob {
  kind: JobKind;
  dedupKey: string;
  accountId?: number | null;
  purpose?: string | null;
  flowId?: number | null;
  campaignId?: number | null;
  eventId?: number | null;
  payload?: Record<string, unknown>;
  isDemo?: boolean;
  runAt?: number;
  maxAttempts?: number;
}

export function insertJobStmt(db: D1Database, j: NewJob, now: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO action_jobs
        (account_id, kind, purpose, flow_id, campaign_id, event_id, dedup_key, payload, is_demo, status, attempts, max_attempts, run_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)`,
    )
    .bind(
      j.accountId ?? null,
      j.kind,
      j.purpose ?? null,
      j.flowId ?? null,
      j.campaignId ?? null,
      j.eventId ?? null,
      j.dedupKey,
      JSON.stringify(j.payload ?? {}),
      j.isDemo ? 1 : 0,
      j.maxAttempts ?? 5,
      j.runAt ?? now,
      now,
      now,
    );
}

/** Returns true if the job was created, false if an identical job (same dedup key) already existed. */
export async function enqueue(db: D1Database, j: NewJob, now: number): Promise<boolean> {
  const r = await insertJobStmt(db, j, now).run();
  return (r.meta?.changes ?? 0) > 0;
}

/**
 * Recover jobs whose lease expired (worker crashed / exceeded limits).
 * - If the Meta call never started → reschedule.
 * - If a side-effect call may have been sent → mark "uncertain" (never resend blindly).
 * - Idempotent reads (follow_check, process_event) → reschedule.
 */
export async function recoverStaleLeases(db: D1Database, now: number): Promise<number> {
  const r1 = await run(
    db,
    `UPDATE action_jobs SET status = 'uncertain', lease_owner = NULL, lease_expires_at = NULL,
        last_error = 'lease expired after the Meta request started; outcome unknown', updated_at = ?
     WHERE status = 'processing' AND lease_expires_at < ? AND external_call_started_at IS NOT NULL
       AND kind IN ('send_message','public_reply')`,
    now,
    now,
  );
  const r2 = await run(
    db,
    `UPDATE action_jobs SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'retry_scheduled' END,
        lease_owner = NULL, lease_expires_at = NULL, external_call_started_at = NULL, run_at = ?,
        last_error = 'lease expired; rescheduled', updated_at = ?
     WHERE status = 'processing' AND lease_expires_at < ?`,
    now,
    now,
    now,
  );
  return (r1.meta?.changes ?? 0) + (r2.meta?.changes ?? 0);
}

/**
 * Atomically claims the next due job. A single UPDATE ... WHERE id = (subquery) AND status IN (...)
 * statement is atomic in SQLite/D1, so two concurrent workers can never claim the same job.
 */
export async function claimNextJob(
  db: D1Database,
  owner: string,
  now: number,
  leaseMs: number,
  opts: { demoOnly?: boolean; includeDemo?: boolean } = {},
): Promise<JobRow | null> {
  const demoFilter = opts.demoOnly ? "AND is_demo = 1" : opts.includeDemo === false ? "AND is_demo = 0" : "";
  return first<JobRow>(
    db,
    `UPDATE action_jobs
        SET status = 'processing', lease_owner = ?, lease_expires_at = ?, attempts = attempts + 1, updated_at = ?
      WHERE id = (SELECT id FROM action_jobs
                   WHERE status IN ('pending','retry_scheduled') AND run_at <= ? ${demoFilter}
                   ORDER BY run_at ASC, id ASC LIMIT 1)
        AND status IN ('pending','retry_scheduled')
      RETURNING *`,
    owner,
    now + leaseMs,
    now,
    now,
  );
}

/** Marks the start of an external side-effect call (used to detect uncertain outcomes). */
export async function markExternalStart(db: D1Database, job: JobRow, owner: string, now: number): Promise<boolean> {
  const r = await run(
    db,
    "UPDATE action_jobs SET external_call_started_at = ?, updated_at = ? WHERE id = ? AND lease_owner = ? AND status = 'processing'",
    now,
    now,
    job.id,
    owner,
  );
  return (r.meta?.changes ?? 0) > 0;
}

export async function finishJob(
  db: D1Database,
  job: JobRow,
  owner: string,
  status: "accepted" | "failed" | "cancelled" | "uncertain",
  now: number,
  info: { result?: unknown; error?: string } = {},
): Promise<void> {
  await run(
    db,
    `UPDATE action_jobs SET status = ?, result = COALESCE(?, result), last_error = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
     WHERE id = ? AND lease_owner = ?`,
    status,
    info.result === undefined ? null : JSON.stringify(info.result),
    info.error ?? null,
    now,
    job.id,
    owner,
  );
}

export function backoffMs(attempt: number, retryAfterMs?: number, rand = Math.random): number {
  const base = Math.min(60 * 60_000, 30_000 * 2 ** Math.max(0, attempt - 1));
  const jitter = base * (0.8 + rand() * 0.4);
  const ra = retryAfterMs ? Math.min(retryAfterMs, 24 * 60 * 60_000) : 0;
  return Math.round(Math.max(jitter, ra));
}

export const RATE_LIMIT_MAX_ATTEMPTS = 50;

export async function scheduleRetry(
  db: D1Database,
  job: JobRow,
  owner: string,
  now: number,
  error: string,
  retryAfterMs?: number,
  opts: { rateLimited?: boolean } = {},
): Promise<"retry_scheduled" | "failed"> {
  // Instagram's messaging limits are hourly: a rate-limited send keeps waiting (backoff capped at 1h)
  // for up to ~2 days instead of failing after a few minutes. The flow TTL / reply windows still apply.
  const limit = opts.rateLimited ? Math.max(job.max_attempts, RATE_LIMIT_MAX_ATTEMPTS) : job.max_attempts;
  if (job.attempts >= limit) {
    await finishJob(db, job, owner, "failed", now, { error: `max attempts reached: ${error}` });
    return "failed";
  }
  await run(
    db,
    `UPDATE action_jobs SET status = 'retry_scheduled', run_at = ?, last_error = ?, lease_owner = NULL, lease_expires_at = NULL,
       external_call_started_at = NULL, updated_at = ? WHERE id = ? AND lease_owner = ?`,
    now + backoffMs(job.attempts, retryAfterMs),
    error,
    now,
    job.id,
    owner,
  );
  return "retry_scheduled";
}

export async function recordAttempt(
  db: D1Database,
  job: JobRow,
  startedAt: number,
  finishedAt: number,
  outcome: string,
  info: { httpStatus?: number; errorCode?: string; errorMessage?: string; retryAfterMs?: number } = {},
): Promise<void> {
  await run(
    db,
    `INSERT INTO action_attempts (job_id, attempt_no, started_at, finished_at, outcome, http_status, error_code, error_message, retry_after_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    job.id,
    job.attempts,
    startedAt,
    finishedAt,
    outcome,
    info.httpStatus ?? null,
    info.errorCode ?? null,
    info.errorMessage ?? null,
    info.retryAfterMs ?? null,
  );
}

export async function cancelJobsWhere(db: D1Database, where: string, now: number, ...params: unknown[]): Promise<number> {
  const r = await run(
    db,
    `UPDATE action_jobs SET status = 'cancelled', last_error = 'cancelled', updated_at = ?
     WHERE status IN ('pending','retry_scheduled') AND (${where})`,
    now,
    ...params,
  );
  return r.meta?.changes ?? 0;
}

export async function jobsForFlow(db: D1Database, flowId: number): Promise<JobRow[]> {
  return all<JobRow>(db, "SELECT * FROM action_jobs WHERE flow_id = ? ORDER BY id", flowId);
}
