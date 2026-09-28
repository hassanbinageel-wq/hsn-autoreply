import {
  DrawError,
  effectiveAllowRepeat,
  EXCLUDE_LABELS,
  identityKey,
  pickWinners,
  summarize,
  type DrawEntry,
  type DrawSettings,
  type EligibilityContext,
} from "../../shared/draw";
import type { AccountRow, EngineContext } from "../engine/context";
import { all, first, run } from "../lib/db";
import type { CommentItem } from "../meta/types";

export interface DrawRow {
  id: number;
  campaign_id: number;
  name: string;
  source_type: "media" | "story";
  media_id: string;
  media_permalink: string | null;
  media_caption: string | null;
  media_thumb: string | null;
  media_comments_count: number | null;
  winners_count: number;
  starts_at: number | null;
  ends_at: number | null;
  timezone: string | null;
  include_replies: number;
  keyword: string | null;
  exclude_own: number;
  excluded_accounts: string;
  entry_mode: "per_person" | "per_comment";
  allow_repeat_winner: number;
  exclude_previous_winners: number;
  status: "draft" | "drawing" | "drawn";
  fetch_status: "idle" | "partial" | "complete" | "error";
  fetch_state: string | null;
  fetch_error: string | null;
  fetched_count: number;
  fetch_updated_at: number | null;
  eligible_count: number | null;
  unique_people: number | null;
  drawn_at: number | null;
  draw_request_id: string | null;
  created_at: number;
  updated_at: number;
  card_design_id?: number | null;
}

export class DrawFailure extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export function settingsOf(d: DrawRow): DrawSettings {
  let excluded: string[] = [];
  try {
    excluded = JSON.parse(d.excluded_accounts || "[]");
  } catch {
    excluded = [];
  }
  return {
    starts_at: d.starts_at,
    ends_at: d.ends_at,
    include_replies: !!d.include_replies,
    keyword: d.keyword,
    exclude_own: !!d.exclude_own,
    excluded_accounts: excluded,
    entry_mode: d.entry_mode,
    allow_repeat_winner: !!d.allow_repeat_winner,
  };
}

export async function loadDraw(db: D1Database, id: number): Promise<DrawRow | null> {
  return first<DrawRow>(db, "SELECT * FROM draws WHERE id = ?", id);
}

async function activeAccount(db: D1Database): Promise<AccountRow | null> {
  return first<AccountRow>(db, "SELECT * FROM instagram_accounts WHERE is_demo = 0 AND status = 'active' ORDER BY id LIMIT 1");
}

// ---------------------------------------------------------------------------------------------------------------
// Fetching participations (resumable, bounded per request to stay inside the Workers subrequest limit)
// ---------------------------------------------------------------------------------------------------------------

interface FetchState {
  phase: "comments" | "replies" | "done";
  after?: string | null;
  replyQueue: Array<{ commentId: string; after: string }>;
  pages: number;
}

const MAX_CALLS_PER_BATCH = 30;

interface NewEntry {
  comment_id: string;
  author_id: string | null;
  author_username: string | null;
  text: string | null;
  created_time: number | null;
  parent_id: string | null;
  source: "comment" | "reply" | "story_reply";
}

function toEntry(c: CommentItem, source: "comment" | "reply", parentId?: string | null): NewEntry {
  const t = c.timestamp ? Date.parse(c.timestamp) : NaN;
  return {
    comment_id: c.id,
    author_id: c.from?.id ?? null,
    author_username: c.from?.username ?? c.username ?? null,
    text: c.text ?? null,
    created_time: Number.isFinite(t) ? t : null,
    parent_id: parentId ?? c.parent_id ?? null,
    source,
  };
}

async function insertEntries(db: D1Database, drawId: number, rows: NewEntry[]): Promise<void> {
  if (!rows.length) return;
  const stmts = rows.map((r) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO draw_entries (draw_id, comment_id, author_id, author_username, text, created_time, parent_id, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(drawId, r.comment_id, r.author_id, r.author_username, r.text?.slice(0, 2200) ?? null, r.created_time, r.parent_id, r.source),
  );
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
}

/**
 * Fetches the next batch of pages for a draw. Returns the new fetch status. A draw can only be run once fetching is
 * "complete"; an error or rate limit leaves it "partial"/"error" with the reason, and the next call resumes from the
 * saved cursor. Duplicate comments are ignored by the (draw_id, comment_id) unique key.
 */
export async function fetchBatch(ctx: EngineContext, drawId: number, opts: { restart?: boolean } = {}): Promise<DrawRow> {
  const d = await loadDraw(ctx.db, drawId);
  if (!d) throw new DrawFailure(404, "not_found", "السحب غير موجود");
  if (d.status !== "draft") throw new DrawFailure(409, "locked", "تم تنفيذ السحب — المشاركات مجمّدة ولا يمكن إعادة جلبها");
  const now = ctx.now();
  if (opts.restart) {
    await ctx.db.batch([
      ctx.db.prepare("DELETE FROM draw_entries WHERE draw_id = ?").bind(drawId),
      ctx.db.prepare("UPDATE draws SET fetch_status = 'idle', fetch_state = NULL, fetch_error = NULL, fetched_count = 0, updated_at = ? WHERE id = ?").bind(now, drawId),
    ]);
    d.fetch_status = "idle";
    d.fetch_state = null;
  }
  if (d.fetch_status === "complete") return d;

  if (d.source_type === "story") return fetchStoryReplies(ctx, d);

  const account = await activeAccount(ctx.db);
  if (!account) throw new DrawFailure(409, "no_account", "اربط حساب إنستقرام أولًا");
  const token = await ctx.getAccessToken(account);
  const client = ctx.meta(false);
  if (!token || !client.listCommentsPage || !client.listReplies) throw new DrawFailure(409, "no_token", "التفويض غير متاح — أعد الربط");

  const state: FetchState = d.fetch_state ? JSON.parse(d.fetch_state) : { phase: "comments", after: null, replyQueue: [], pages: 0 };
  let calls = 0;
  let error: string | null = null;
  let status: DrawRow["fetch_status"] = "partial";

  while (calls < MAX_CALLS_PER_BATCH && state.phase !== "done") {
    let r;
    let attempt = 0;
    // One quiet retry for transient errors inside the batch; rate limits stop the batch (resume later).
    for (;;) {
      calls++;
      r =
        state.phase === "comments"
          ? await client.listCommentsPage(token, d.media_id, state.after ?? undefined)
          : await client.listReplies(token, state.replyQueue[0].commentId, state.replyQueue[0].after);
      if (r.ok || r.error.kind !== "retryable" || attempt >= 1) break;
      attempt++;
    }
    if (!r.ok) {
      if (r.error.kind === "auth") await ctx.onAuthError?.(account, r.error.message);
      error =
        r.error.kind === "rate_limited"
          ? "بلغت حد طلبات Meta مؤقتًا — انتظر قليلًا ثم اضغط «متابعة الجلب»"
          : r.error.kind === "permission"
            ? `لا توجد صلاحية لقراءة تعليقات هذا المنشور (${r.error.message})`
            : `تعذر الجلب: ${r.error.message}`;
      status = r.error.kind === "rate_limited" || r.error.kind === "retryable" ? "partial" : "error";
      break;
    }
    state.pages++;
    const page = r.data;
    const rows: NewEntry[] = [];
    if (state.phase === "comments") {
      for (const c of page.data ?? []) {
        rows.push(toEntry(c, "comment", null));
        for (const rep of c.replies?.data ?? []) rows.push(toEntry(rep, "reply", c.id));
        const more = c.replies?.paging?.next ? c.replies?.paging?.cursors?.after : null;
        if (more) state.replyQueue.push({ commentId: c.id, after: more });
      }
      const next = page.paging?.next ? page.paging?.cursors?.after : null;
      if (next) state.after = next;
      else state.phase = state.replyQueue.length ? "replies" : "done";
    } else {
      const head = state.replyQueue[0];
      for (const rep of page.data ?? []) rows.push(toEntry(rep, "reply", head.commentId));
      const next = page.paging?.next ? page.paging?.cursors?.after : null;
      if (next) head.after = next;
      else state.replyQueue.shift();
      if (!state.replyQueue.length) state.phase = "done";
    }
    await insertEntries(ctx.db, d.id, rows);
  }
  if (!error && state.phase === "done") status = "complete";

  const count = await first<{ n: number }>(ctx.db, "SELECT COUNT(*) AS n FROM draw_entries WHERE draw_id = ?", d.id);
  await run(
    ctx.db,
    "UPDATE draws SET fetch_status = ?, fetch_state = ?, fetch_error = ?, fetched_count = ?, fetch_updated_at = ?, updated_at = ? WHERE id = ?",
    status,
    status === "complete" ? null : JSON.stringify(state),
    error,
    count?.n ?? 0,
    ctx.now(),
    ctx.now(),
    d.id,
  );
  return (await loadDraw(ctx.db, d.id))!;
}

/**
 * Stories: Meta offers no endpoint to list replies to a story. The only replies we can use are the ones that reached
 * this system through the messaging webhook while it was connected, each linked to the story by reply_to.story.id.
 * Story mentions and unrelated DMs are never included.
 */
async function fetchStoryReplies(ctx: EngineContext, d: DrawRow): Promise<DrawRow> {
  const rows = await all<{ dedup_key: string; sender_id: string | null; text: string | null; event_time: number; username: string | null }>(
    ctx.db,
    `SELECT e.dedup_key, e.sender_id, e.text, e.event_time, p.username
       FROM webhook_events e
       LEFT JOIN instagram_accounts a ON a.ig_user_id = e.account_ig_id AND a.is_demo = 0
       LEFT JOIN participants p ON p.account_id = a.id AND p.igsid = e.sender_id
      WHERE e.event_type = 'story_reply' AND e.is_demo = 0 AND e.media_id = ?
      ORDER BY e.id`,
    d.media_id,
  );
  await insertEntries(
    ctx.db,
    d.id,
    rows.map((r) => ({
      comment_id: r.dedup_key,
      author_id: r.sender_id,
      author_username: r.username,
      text: r.text,
      created_time: r.event_time,
      parent_id: null,
      source: "story_reply" as const,
    })),
  );
  const count = await first<{ n: number }>(ctx.db, "SELECT COUNT(*) AS n FROM draw_entries WHERE draw_id = ?", d.id);
  await run(
    ctx.db,
    "UPDATE draws SET fetch_status = 'complete', fetch_state = NULL, fetch_error = NULL, fetched_count = ?, fetch_updated_at = ?, updated_at = ? WHERE id = ?",
    count?.n ?? 0,
    ctx.now(),
    ctx.now(),
    d.id,
  );
  return (await loadDraw(ctx.db, d.id))!;
}

// ---------------------------------------------------------------------------------------------------------------
// Eligibility / preview
// ---------------------------------------------------------------------------------------------------------------

export async function eligibilityContext(db: D1Database, d: DrawRow, excludeDrawId = true): Promise<EligibilityContext> {
  const acc = await first<{ ig_user_id: string; app_scoped_id: string | null; username: string | null }>(
    db,
    "SELECT ig_user_id, app_scoped_id, username FROM instagram_accounts WHERE is_demo = 0 ORDER BY status = 'active' DESC, id LIMIT 1",
  );
  const previous = new Set<string>();
  if (d.exclude_previous_winners) {
    const rows = await all<{ identity_key: string }>(
      db,
      `SELECT w.identity_key FROM draw_winners w JOIN draws x ON x.id = w.draw_id
        WHERE x.campaign_id = ? AND w.status = 'active' ${excludeDrawId ? "AND x.id != ?" : ""}`,
      ...(excludeDrawId ? [d.campaign_id, d.id] : [d.campaign_id]),
    );
    for (const r of rows) previous.add(r.identity_key);
  }
  return {
    own_ids: [acc?.ig_user_id, acc?.app_scoped_id].filter(Boolean) as string[],
    own_username: acc?.username ?? null,
    previous_winner_keys: previous,
  };
}

export async function loadEntries(db: D1Database, drawId: number): Promise<DrawEntry[]> {
  return all<DrawEntry>(
    db,
    "SELECT id, comment_id, author_id, author_username, text, created_time, source FROM draw_entries WHERE draw_id = ? ORDER BY created_time, id",
    drawId,
  );
}

export async function preview(db: D1Database, d: DrawRow) {
  const entries = await loadEntries(db, d.id);
  if (d.status === "drawn") {
    const frozen = await all<{ id: number; eligible: number; exclude_reason: string | null }>(db, "SELECT id, eligible, exclude_reason FROM draw_entries WHERE draw_id = ?", d.id);
    const byId = new Map(frozen.map((f) => [f.id, f]));
    const reasons: Record<string, number> = {};
    for (const f of frozen) if (!f.eligible && f.exclude_reason) reasons[f.exclude_reason] = (reasons[f.exclude_reason] ?? 0) + 1;
    return {
      total: entries.length,
      eligible_count: d.eligible_count ?? 0,
      unique_people: d.unique_people ?? 0,
      reasons,
      max_winners: null,
      identity_reliable: entries.every((e) => !!e.author_id),
      entries: entries.map((e) => ({ ...e, eligible: !!byId.get(e.id)?.eligible, reason: byId.get(e.id)?.exclude_reason ?? null })),
      frozen: true,
    };
  }
  const s = summarize(entries, settingsOf(d), await eligibilityContext(db, d));
  const reasonOf = new Map(s.excluded.map((x) => [x.entry.id, x.reason]));
  return {
    total: s.total,
    eligible_count: s.eligible.length,
    unique_people: s.unique_people,
    reasons: s.reasons,
    max_winners: s.max_winners,
    identity_reliable: s.identity_reliable,
    entries: entries.map((e) => ({ ...e, eligible: !reasonOf.has(e.id), reason: reasonOf.get(e.id) ?? null })),
    frozen: false,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Running the draw (once) and replacing a winner
// ---------------------------------------------------------------------------------------------------------------

export async function runDraw(db: D1Database, drawId: number, requestId: string, now = Date.now(), rand32?: () => number): Promise<{ replay: boolean }> {
  const d = await loadDraw(db, drawId);
  if (!d) throw new DrawFailure(404, "not_found", "السحب غير موجود");
  // Idempotent: the same request (double click / resend) returns the existing result.
  if (d.status === "drawn") {
    if (d.draw_request_id === requestId) return { replay: true };
    throw new DrawFailure(409, "already_drawn", "تم تنفيذ هذا السحب مسبقًا — النتيجة محفوظة ولا تتغير");
  }
  if (d.status === "drawing") throw new DrawFailure(409, "in_progress", "السحب قيد التنفيذ الآن");
  if (d.fetch_status !== "complete") {
    throw new DrawFailure(409, "incomplete_fetch", "جلب المشاركات لم يكتمل — أكمل الجلب أولًا حتى لا يُسحب من بيانات ناقصة");
  }
  const entries = await loadEntries(db, d.id);
  const settings = settingsOf(d);
  const s = summarize(entries, settings, await eligibilityContext(db, d));
  if (d.winners_count > s.max_winners) {
    throw new DrawFailure(422, "not_enough", `عدد الفائزين المطلوب (${d.winners_count}) أكبر من الممكن وفق إعداداتك (${s.max_winners}). عدّل العدد أو الإعدادات.`, {
      possible: s.max_winners,
    });
  }
  // Only one request can move the draw from draft to drawing.
  const lock = await run(db, "UPDATE draws SET status = 'drawing', draw_request_id = ?, updated_at = ? WHERE id = ? AND status = 'draft'", requestId, now, d.id);
  if (!(lock.meta?.changes ?? 0)) throw new DrawFailure(409, "in_progress", "السحب قيد التنفيذ أو نُفّذ للتو");
  try {
    const winners = pickWinners(s.eligible, settings, d.winners_count, { rand32 });
    const reasonOf = new Map(s.excluded.map((x) => [x.entry.id, x.reason]));
    const stmts: D1PreparedStatement[] = [];
    // Freeze eligibility so the result and the audit trail never change afterwards.
    for (const e of entries) {
      stmts.push(db.prepare("UPDATE draw_entries SET eligible = ?, exclude_reason = ? WHERE id = ?").bind(reasonOf.has(e.id) ? 0 : 1, reasonOf.get(e.id) ?? null, e.id));
    }
    winners.forEach((w, i) =>
      stmts.push(
        db
          .prepare("INSERT INTO draw_winners (draw_id, position, entry_id, identity_key, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)")
          .bind(d.id, i + 1, w.id, identityKey(w)!, now),
      ),
    );
    stmts.push(
      db
        .prepare("UPDATE draws SET status = 'drawn', drawn_at = ?, eligible_count = ?, unique_people = ?, updated_at = ? WHERE id = ? AND status = 'drawing'")
        .bind(now, s.eligible.length, s.unique_people, now, d.id),
    );
    for (let i = 0; i < stmts.length; i += 90) await db.batch(stmts.slice(i, i + 90));
    return { replay: false };
  } catch (err) {
    await run(db, "UPDATE draws SET status = 'draft', draw_request_id = NULL WHERE id = ? AND status = 'drawing'", d.id);
    if (err instanceof DrawError) throw new DrawFailure(422, "not_enough", `المشاركات المؤهلة لا تكفي (${err.possible})`, { possible: err.possible });
    throw err;
  }
}

/**
 * Replaces one winner: the old result stays in the history (status "replaced" + reason), the replaced person/comment
 * can never be picked again in this draw, and the same repeat rules apply to the substitute.
 */
export async function replaceWinner(db: D1Database, drawId: number, winnerId: number, reason: string, now = Date.now(), rand32?: () => number) {
  const d = await loadDraw(db, drawId);
  if (!d || d.status === "draft") throw new DrawFailure(409, "not_drawn", "لا يمكن الاستبدال قبل اختيار الفائز");
  const w = await first<{ id: number; position: number; status: string }>(db, "SELECT id, position, status FROM draw_winners WHERE id = ? AND draw_id = ?", winnerId, drawId);
  if (!w) throw new DrawFailure(404, "not_found", "الفائز غير موجود");
  if (w.status !== "active") throw new DrawFailure(409, "already_replaced", "تم استبدال هذا الفائز مسبقًا");

  const settings = settingsOf(d);
  const replacedKey = (await first<{ identity_key: string }>(db, "SELECT identity_key FROM draw_winners WHERE id = ?", winnerId))!.identity_key;
  const pool = await remainingPool(db, d, replacedKey); // the replaced person is out of this draw
  let pick: DrawEntry;
  try {
    [pick] = pickWinners(pool, settings, 1, { rand32 });
  } catch (err) {
    if (err instanceof DrawError) throw new DrawFailure(422, "no_substitute", "لا توجد مشاركة مؤهلة متبقية لاختيار بديل وفق قواعد السحب");
    throw err;
  }
  // Atomic: a double click can only replace once.
  const upd = await run(db, "UPDATE draw_winners SET status = 'replaced', replaced_reason = ?, replaced_at = ? WHERE id = ? AND status = 'active'", reason, now, winnerId);
  if (!(upd.meta?.changes ?? 0)) throw new DrawFailure(409, "already_replaced", "تم استبدال هذا الفائز مسبقًا");
  const ins = await first<{ id: number }>(
    db,
    "INSERT INTO draw_winners (draw_id, position, entry_id, identity_key, status, created_at) VALUES (?, ?, ?, ?, 'active', ?) RETURNING id",
    drawId,
    w.position,
    pick.id,
    identityKey(pick)!,
    now,
  );
  await run(db, "UPDATE draw_winners SET replaced_by = ? WHERE id = ?", ins!.id, winnerId);
  return { winner_id: ins!.id };
}

/** Arabic ordinal for a winner position (الأول، الثاني، …). */
export function ordinal(n: number): string {
  const o = ["الأول", "الثاني", "الثالث", "الرابع", "الخامس", "السادس", "السابع", "الثامن", "التاسع", "العاشر"];
  return o[n - 1] ?? `رقم ${n}`;
}

/**
 * Picks ONE winner (the next free position). The first pick validates the fetch and the feasibility, freezes the
 * eligibility of every entry and locks the settings; the draw becomes "drawn" once all positions are filled.
 * Idempotent per request id (a resend returns the same winner) and safe against concurrent clicks (one active winner
 * per position is enforced by a unique index).
 */
export async function pickNext(db: D1Database, drawId: number, requestId: string, now = Date.now(), rand32?: () => number): Promise<{ winner_id: number; position: number; replay: boolean; done: boolean }> {
  let d = await loadDraw(db, drawId);
  if (!d) throw new DrawFailure(404, "not_found", "السحب غير موجود");
  const replay = await first<{ id: number; position: number }>(db, "SELECT id, position FROM draw_winners WHERE draw_id = ? AND request_id = ?", drawId, requestId);
  if (replay) return { winner_id: replay.id, position: replay.position, replay: true, done: d.status === "drawn" };
  if (d.status === "drawn") throw new DrawFailure(409, "already_drawn", "اكتمل اختيار جميع الفائزين — النتيجة محفوظة ولا تتغير");

  if (d.status === "draft") {
    if (d.fetch_status !== "complete") {
      throw new DrawFailure(409, "incomplete_fetch", "جلب المشاركات لم يكتمل — أكمل الجلب أولًا حتى لا يُسحب من بيانات ناقصة");
    }
    const entries = await loadEntries(db, d.id);
    const s = summarize(entries, settingsOf(d), await eligibilityContext(db, d));
    if (d.winners_count > s.max_winners) {
      throw new DrawFailure(422, "not_enough", `عدد الفائزين المطلوب (${d.winners_count}) أكبر من الممكن وفق إعداداتك (${s.max_winners}). عدّل العدد أو الإعدادات.`, {
        possible: s.max_winners,
      });
    }
    // Freeze eligibility and lock the settings in one transaction (the status change is last and conditional).
    const reasonOf = new Map(s.excluded.map((x) => [x.entry.id, x.reason]));
    const stmts = entries.map((e) => db.prepare("UPDATE draw_entries SET eligible = ?, exclude_reason = ? WHERE id = ?").bind(reasonOf.has(e.id) ? 0 : 1, reasonOf.get(e.id) ?? null, e.id));
    stmts.push(
      db
        .prepare("UPDATE draws SET status = 'drawing', eligible_count = ?, unique_people = ?, draw_request_id = ?, updated_at = ? WHERE id = ? AND status = 'draft'")
        .bind(s.eligible.length, s.unique_people, requestId, now, d.id),
    );
    for (let i = 0; i < stmts.length; i += 90) await db.batch(stmts.slice(i, i + 90));
    d = (await loadDraw(db, d.id))!;
  }

  const active = await all<{ position: number }>(db, "SELECT position FROM draw_winners WHERE draw_id = ? AND status = 'active'", d.id);
  const taken = new Set(active.map((a) => a.position));
  let position = 1;
  while (taken.has(position)) position++;
  if (position > d.winners_count) {
    await run(db, "UPDATE draws SET status = 'drawn', drawn_at = COALESCE(drawn_at, ?), updated_at = ? WHERE id = ?", now, now, d.id);
    throw new DrawFailure(409, "already_drawn", "اكتمل اختيار جميع الفائزين");
  }

  const pool = await remainingPool(db, d);
  let pick: DrawEntry;
  try {
    [pick] = pickWinners(pool, settingsOf(d), 1, { rand32 });
  } catch (err) {
    if (err instanceof DrawError) throw new DrawFailure(422, "not_enough", "لا توجد مشاركات مؤهلة متبقية وفق قواعد السحب", { possible: 0 });
    throw err;
  }
  let ins: { id: number } | null;
  try {
    ins = await first<{ id: number }>(
      db,
      "INSERT INTO draw_winners (draw_id, position, entry_id, identity_key, status, request_id, created_at) VALUES (?, ?, ?, ?, 'active', ?, ?) RETURNING id",
      d.id,
      position,
      pick.id,
      identityKey(pick)!,
      requestId,
      now,
    );
  } catch {
    // Another click took this position (or the same request raced): report the current state instead.
    const again = await first<{ id: number; position: number }>(db, "SELECT id, position FROM draw_winners WHERE draw_id = ? AND request_id = ?", d.id, requestId);
    if (again) return { winner_id: again.id, position: again.position, replay: true, done: false };
    throw new DrawFailure(409, "in_progress", "يتم اختيار فائز الآن — انتظر لحظة");
  }
  const done = taken.size + 1 >= d.winners_count;
  if (done) await run(db, "UPDATE draws SET status = 'drawn', drawn_at = ?, updated_at = ? WHERE id = ?", now, now, d.id);
  return { winner_id: ins!.id, position, replay: false, done };
}

/** Eligible entries still able to win, applying the repeat rules against current and replaced winners. */
async function remainingPool(db: D1Database, d: DrawRow, extraBlockedKey?: string): Promise<DrawEntry[]> {
  const eligible = await all<DrawEntry>(
    db,
    "SELECT id, comment_id, author_id, author_username, text, created_time, source FROM draw_entries WHERE draw_id = ? AND eligible = 1",
    d.id,
  );
  const history = await all<{ identity_key: string; comment_id: string; status: string }>(
    db,
    "SELECT w.identity_key, e.comment_id, w.status FROM draw_winners w JOIN draw_entries e ON e.id = w.entry_id WHERE w.draw_id = ?",
    d.id,
  );
  const repeat = effectiveAllowRepeat(settingsOf(d));
  const blockedComments = new Set(history.map((h) => h.comment_id)); // no comment ever wins twice
  const blockedKeys = new Set<string>(extraBlockedKey ? [extraBlockedKey] : []);
  for (const h of history) if (h.status === "replaced" || !repeat) blockedKeys.add(h.identity_key);
  return eligible.filter((e) => !blockedKeys.has(identityKey(e)!) && !blockedComments.has(e.comment_id));
}

export async function winnersOf(db: D1Database, drawId: number) {
  return all<any>(
    db,
    `SELECT w.id, w.position, w.status, w.replaced_reason, w.replaced_at, w.replaced_by, w.created_at, w.identity_key,
            w.send_status, w.send_channel, w.sent_at, w.send_error, w.public_reply_status, w.public_reply_at, w.public_reply_error,
            e.comment_id, e.author_id, e.author_username, e.text, e.created_time, e.source
       FROM draw_winners w JOIN draw_entries e ON e.id = w.entry_id
      WHERE w.draw_id = ? ORDER BY w.position, w.id`,
    drawId,
  );
}

export { EXCLUDE_LABELS };

/** Deletes draws with everything that belongs to them (card images → winners → entries → draw), in FK order. */
export async function deleteDraws(db: D1Database, ids: number[]): Promise<void> {
  for (let i = 0; i < ids.length; i += 20) {
    const chunk = ids.slice(i, i + 20);
    const q = chunk.map(() => "?").join(",");
    await db.batch([
      db.prepare(`DELETE FROM draw_cards WHERE winner_id IN (SELECT id FROM draw_winners WHERE draw_id IN (${q}))`).bind(...chunk),
      db.prepare(`DELETE FROM draw_winners WHERE draw_id IN (${q})`).bind(...chunk),
      db.prepare(`DELETE FROM draw_entries WHERE draw_id IN (${q})`).bind(...chunk),
      db.prepare(`DELETE FROM draws WHERE id IN (${q})`).bind(...chunk),
    ]);
  }
}
