import type { NormalizedEvent } from "../meta/webhook-parse";
/**
 * Durably stores events and their processing jobs in ONE D1 batch (a single transaction).
 * Duplicates (same dedup key) are ignored by UNIQUE constraints, so Meta retries are harmless.
 * Throws if the write fails — the caller must then answer non-2xx so Meta retries delivery.
 */
export async function storeEvents(
  db: D1Database,
  events: NormalizedEvent[],
  opts: { isDemo?: boolean; now?: number; forcedCampaignId?: number } = {},
): Promise<number> {
  if (!events.length) return 0;
  const now = opts.now ?? Date.now();
  const stmts: D1PreparedStatement[] = [];
  for (const ev of events) {
    const dedupKey = opts.isDemo ? `demo:${ev.dedupKey}` : ev.dedupKey;
    stmts.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO webhook_events
            (dedup_key, account_ig_id, event_type, sender_id, sender_username, media_id, text, payload, event_time, received_at, is_demo)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          dedupKey,
          ev.accountIgId,
          ev.kind,
          ev.senderId ?? null,
          ev.senderUsername ?? null,
          ev.mediaId ?? ev.storyId ?? null,
          ev.text ?? null,
          JSON.stringify(ev),
          ev.time,
          now,
          opts.isDemo ? 1 : 0,
        ),
    );
    // Echoes / reactions / unknown events are logged but need no processing job.
    if (ev.kind === "echo" || ev.kind === "other") {
      stmts.push(
        db
          .prepare("UPDATE webhook_events SET status = 'ignored', reason = ?, processed_at = ? WHERE dedup_key = ? AND status = 'pending'")
          .bind(ev.kind === "echo" ? "message_echo" : "unsupported_event", now, dedupKey),
      );
      continue;
    }
    stmts.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO action_jobs (account_id, kind, event_id, dedup_key, payload, is_demo, status, attempts, max_attempts, run_at, created_at, updated_at)
           SELECT NULL, 'process_event', id, ?, ?, ?, 'pending', 0, 5, ?, ?, ? FROM webhook_events WHERE dedup_key = ?`,
        )
        .bind(
          `evt:${dedupKey}`,
          JSON.stringify(opts.forcedCampaignId ? { forcedCampaignId: opts.forcedCampaignId } : {}),
          opts.isDemo ? 1 : 0,
          now,
          now,
          now,
          dedupKey,
        ),
    );
  }
  const ids = [...new Set(events.map((e) => e.accountIgId))];
  for (const id of ids) {
    stmts.push(db.prepare("UPDATE instagram_accounts SET last_webhook_at = ? WHERE ig_user_id = ?").bind(now, id));
  }
  await db.batch(stmts);
  return events.length;
}
