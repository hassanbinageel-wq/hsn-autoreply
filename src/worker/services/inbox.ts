import type { AccountRow, EngineContext } from "../engine/context";
import { all, first, run } from "../lib/db";

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

export const AVATAR_TTL_MS = 2 * 86_400_000; // Instagram CDN URLs expire; refresh every 2 days
const AVATAR_HOST = /^https:\/\/[A-Za-z0-9.-]+\.(cdninstagram\.com|fbcdn\.net)\//;

/**
 * Fills / refreshes the profile pictures of the most recent inbox conversations through the official
 * User Profile API (the person messaged the account, so consent exists). Bounded per call (subrequest limit).
 * A failed or refused lookup is remembered for the same TTL, so it is not retried on every page load.
 */
export async function refreshAvatars(ctx: EngineContext, limit = 15): Promise<{ checked: number; updated: number }> {
  const now = ctx.now();
  const rows = await all<{ id: number; igsid: string; account_id: number }>(
    ctx.db,
    `SELECT p.id, p.igsid, p.account_id FROM participants p
      WHERE p.is_demo = 0 AND p.last_message_at IS NOT NULL AND (p.profile_pic_at IS NULL OR p.profile_pic_at < ?)
      ORDER BY p.last_message_at DESC LIMIT ?`,
    now - AVATAR_TTL_MS,
    limit,
  );
  if (!rows.length) return { checked: 0, updated: 0 };
  const accounts = new Map<number, { account: AccountRow; token: string | null }>();
  const meta = ctx.meta(false);
  if (!meta.getUserProfile) return { checked: 0, updated: 0 };
  let updated = 0;
  for (const r of rows) {
    if (!accounts.has(r.account_id)) {
      const account = await first<AccountRow>(ctx.db, "SELECT * FROM instagram_accounts WHERE id = ? AND status = 'active'", r.account_id);
      accounts.set(r.account_id, { account: account!, token: account ? await ctx.getAccessToken(account) : null });
    }
    const a = accounts.get(r.account_id)!;
    if (!a.token) continue;
    const res = await meta.getUserProfile(a.token, r.igsid);
    if (!res.ok && (res.error.kind === "rate_limited" || res.error.kind === "auth")) {
      if (res.error.kind === "auth") await ctx.onAuthError?.(a.account, res.error.message);
      break; // stop now, try again later
    }
    const pic = res.ok && typeof res.data.profile_pic === "string" && AVATAR_HOST.test(res.data.profile_pic) ? res.data.profile_pic : null;
    const username = res.ok && typeof res.data.username === "string" && /^[A-Za-z0-9._]{1,30}$/.test(res.data.username) ? res.data.username : null;
    await run(
      ctx.db,
      "UPDATE participants SET profile_pic_url = CASE WHEN ? THEN ? ELSE profile_pic_url END, profile_pic_at = ?, username = COALESCE(username, ?) WHERE id = ?",
      res.ok ? 1 : 0,
      pic,
      now,
      username,
      r.id,
    );
    if (pic) updated++;
  }
  return { checked: rows.length, updated };
}
