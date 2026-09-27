import { run } from "../lib/db";

export type MessageSource = "user" | "bot" | "manual" | "app";

export interface NewMessage {
  accountId: number;
  participantId: number;
  direction: "in" | "out";
  source: MessageSource;
  kind?: string | null;
  text?: string | null;
  /** Instagram message id: makes recording idempotent (webhook retries, and our own sends echoed back). */
  mid?: string | null;
  isDemo?: boolean;
  at: number;
}

/**
 * Stores one conversation message for the inbox. Best-effort: a storage error never breaks the automation.
 * A message we sent ourselves is echoed back by Instagram with the same mid; the unique mid keeps one row,
 * and a bot/manual send wins over the echo's "app" label.
 */
export async function recordMessage(db: D1Database, m: NewMessage): Promise<void> {
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO messages (account_id, participant_id, direction, source, kind, text, mid, is_demo, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(mid) WHERE mid IS NOT NULL DO UPDATE SET
             source = CASE WHEN excluded.source IN ('bot','manual') THEN excluded.source ELSE messages.source END,
             text = COALESCE(messages.text, excluded.text)`,
        )
        .bind(m.accountId, m.participantId, m.direction, m.source, m.kind ?? null, m.text?.slice(0, 2000) ?? null, m.mid ?? null, m.isDemo ? 1 : 0, m.at),
      db
        .prepare("UPDATE participants SET last_message_at = MAX(COALESCE(last_message_at, 0), ?) WHERE id = ?")
        .bind(m.at, m.participantId),
    ]);
  } catch (err) {
    console.error("inbox record failed", String((err as Error)?.message ?? err).slice(0, 200));
  }
}

export async function markRead(db: D1Database, participantId: number, at: number): Promise<void> {
  await run(db, "UPDATE participants SET inbox_read_at = ? WHERE id = ?", at, participantId);
}
