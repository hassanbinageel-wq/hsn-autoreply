import { first } from "../lib/db";

/** Cloudflare free plan daily limits (reset at 00:00 UTC). */
export const FREE_LIMITS = { requests: 100_000, writes: 100_000 } as const;

/**
 * Approximate rows written per stored row, including index maintenance and the later status updates of the
 * same row (D1 counts every written row and index entry). Deliberately on the high side.
 */
const WRITE_COST = { event: 6, job: 10, attempt: 2, flow: 20, follow_check: 4, message: 6, click: 2 } as const;

export interface UsageEstimate {
  day_start: number;
  reset_at: number;
  requests: { used: number; limit: number; pct: number };
  writes: { used: number; limit: number; pct: number };
  counts: Record<string, number>;
}

/**
 * Today's usage estimated from what the system stored today (Cloudflare does not expose live quota counters to
 * the Worker itself). Good enough to warn well before a limit; the exact figures are in the Cloudflare dashboard.
 */
export async function estimateUsage(db: D1Database, now = Date.now()): Promise<UsageEstimate> {
  const dayStart = Math.floor(now / 86_400_000) * 86_400_000;
  const n = async (sql: string) => (await first<{ n: number }>(db, sql, dayStart))?.n ?? 0;
  const [events, jobs, attempts, flows, followChecks, messages, clicks] = await Promise.all([
    n("SELECT COUNT(*) AS n FROM webhook_events WHERE received_at >= ?"),
    n("SELECT COUNT(*) AS n FROM action_jobs WHERE created_at >= ?"),
    n("SELECT COUNT(*) AS n FROM action_attempts WHERE started_at >= ?"),
    n("SELECT COUNT(*) AS n FROM conversation_flows WHERE created_at >= ?"),
    n("SELECT COUNT(*) AS n FROM follow_checks WHERE checked_at >= ?"),
    n("SELECT COUNT(*) AS n FROM messages WHERE created_at >= ?"),
    n("SELECT COALESCE(SUM(link_clicks), 0) AS n FROM conversation_flows WHERE link_last_click_at >= ?"),
  ]);
  const minutes = Math.floor((now - dayStart) / 60_000);
  // Requests: each webhook delivery, each link tap, each cron run, plus a margin for the app itself.
  const requests = Math.round((events + clicks + minutes) * 1.1);
  const writes = Math.round(
    events * WRITE_COST.event +
      jobs * WRITE_COST.job +
      attempts * WRITE_COST.attempt +
      flows * WRITE_COST.flow +
      followChecks * WRITE_COST.follow_check +
      messages * WRITE_COST.message +
      clicks * WRITE_COST.click,
  );
  const pct = (u: number, l: number) => Math.min(100, Math.round((u / l) * 1000) / 10);
  return {
    day_start: dayStart,
    reset_at: dayStart + 86_400_000,
    requests: { used: requests, limit: FREE_LIMITS.requests, pct: pct(requests, FREE_LIMITS.requests) },
    writes: { used: writes, limit: FREE_LIMITS.writes, pct: pct(writes, FREE_LIMITS.writes) },
    counts: { events, jobs, attempts, flows, follow_checks: followChecks, messages, clicks },
  };
}
