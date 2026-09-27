/**
 * Random Comment Picker — pure eligibility and selection logic (shared by the server and the tests).
 * Selection always runs on the server with a cryptographically secure, unbiased RNG; the UI only animates.
 */
import { normalizeText } from "./normalize";

export type EntryMode = "per_person" | "per_comment";

export interface DrawEntry {
  id: number;
  comment_id: string;
  author_id: string | null; // Instagram-scoped id (stable) when Meta provides it
  author_username: string | null; // display only — never used as the identity when an id exists
  text: string | null;
  created_time: number | null; // ms
  source: "comment" | "reply" | "story_reply";
}

export interface DrawSettings {
  starts_at: number | null;
  ends_at: number | null;
  include_replies: boolean;
  keyword: string | null;
  exclude_own: boolean;
  excluded_accounts: string[]; // "@username" / "username" or "id:<igsid>"
  entry_mode: EntryMode;
  allow_repeat_winner: boolean;
}

export interface EligibilityContext {
  own_ids: string[]; // the connected account's ids (IG user id, app-scoped id)
  own_username: string | null;
  previous_winner_keys: Set<string>; // identity keys of earlier winners in the same campaign (if that option is on)
}

export type ExcludeReason =
  | "reply_excluded"
  | "before_start"
  | "after_end"
  | "missing_keyword"
  | "own_account"
  | "excluded_manually"
  | "previous_winner"
  | "unknown_author";

export const EXCLUDE_LABELS: Record<ExcludeReason, string> = {
  reply_excluded: "رد على تعليق (الردود مستبعدة)",
  before_start: "قبل بداية الفترة",
  after_end: "بعد نهاية الفترة",
  missing_keyword: "لا يحتوي الكلمة المطلوبة",
  own_account: "حسابك",
  excluded_manually: "حساب مستبعد يدويًا",
  previous_winner: "فاز في سحب سابق بنفس الحملة",
  unknown_author: "هوية الكاتب غير متاحة",
};

/** Keyword comparison: normalized text + common spelling variants (ة/ه، ى/ي) treated as equal. */
function fold(t: string): string {
  return normalizeText(t, { unifyAlef: true }).replace(/ة/g, "ه").replace(/ى/g, "ي");
}

/** The identity used for "one chance per person" and repeat rules: the stable id when available. */
export function identityKey(e: Pick<DrawEntry, "author_id" | "author_username">): string | null {
  if (e.author_id) return `id:${e.author_id}`;
  if (e.author_username) return `u:${e.author_username.toLowerCase()}`;
  return null;
}

function normalizeExcluded(list: string[]): { ids: Set<string>; usernames: Set<string> } {
  const ids = new Set<string>();
  const usernames = new Set<string>();
  for (const raw of list) {
    const v = raw.trim();
    if (!v) continue;
    if (v.startsWith("id:")) ids.add(v.slice(3));
    else usernames.add(v.replace(/^@/, "").toLowerCase());
  }
  return { ids, usernames };
}

export function exclusionReason(e: DrawEntry, s: DrawSettings, ctx: EligibilityContext): ExcludeReason | null {
  if (e.source === "reply" && !s.include_replies) return "reply_excluded";
  if (s.starts_at && (e.created_time == null || e.created_time < s.starts_at)) return "before_start";
  if (s.ends_at && (e.created_time == null || e.created_time > s.ends_at)) return "after_end";
  if (s.keyword && s.keyword.trim()) {
    const k = fold(s.keyword);
    if (k && !fold(e.text ?? "").includes(k)) return "missing_keyword";
  }
  const key = identityKey(e);
  if (!key) return "unknown_author";
  if (s.exclude_own) {
    if ((e.author_id && ctx.own_ids.includes(e.author_id)) || (ctx.own_username && e.author_username?.toLowerCase() === ctx.own_username.toLowerCase())) {
      return "own_account";
    }
  }
  const ex = normalizeExcluded(s.excluded_accounts);
  if ((e.author_id && ex.ids.has(e.author_id)) || (e.author_username && ex.usernames.has(e.author_username.toLowerCase()))) return "excluded_manually";
  if (ctx.previous_winner_keys.has(key)) return "previous_winner";
  return null;
}

export interface EligibilitySummary {
  total: number;
  eligible: DrawEntry[];
  excluded: Array<{ entry: DrawEntry; reason: ExcludeReason }>;
  reasons: Partial<Record<ExcludeReason, number>>;
  unique_people: number; // among eligible entries
  identity_reliable: boolean; // false if some eligible entries are identified only by username
  max_winners: number; // what the settings allow with these entries
}

export function effectiveAllowRepeat(s: Pick<DrawSettings, "entry_mode" | "allow_repeat_winner">): boolean {
  // One chance per person means one win per person.
  return s.entry_mode === "per_comment" && s.allow_repeat_winner;
}

export function summarize(entries: DrawEntry[], s: DrawSettings, ctx: EligibilityContext): EligibilitySummary {
  const eligible: DrawEntry[] = [];
  const excluded: Array<{ entry: DrawEntry; reason: ExcludeReason }> = [];
  const reasons: Partial<Record<ExcludeReason, number>> = {};
  for (const e of entries) {
    const r = exclusionReason(e, s, ctx);
    if (r) {
      excluded.push({ entry: e, reason: r });
      reasons[r] = (reasons[r] ?? 0) + 1;
    } else eligible.push(e);
  }
  const people = new Set(eligible.map((e) => identityKey(e)!));
  return {
    total: entries.length,
    eligible,
    excluded,
    reasons,
    unique_people: people.size,
    identity_reliable: eligible.every((e) => !!e.author_id),
    max_winners: effectiveAllowRepeat(s) ? eligible.length : people.size,
  };
}

/** Uniform integer in [0, n) without modulo bias (rejection sampling over 32-bit values). */
export function secureRandomInt(n: number, rand32: () => number = defaultRand32): number {
  if (!Number.isInteger(n) || n <= 0) throw new Error("secureRandomInt: n must be a positive integer");
  const limit = Math.floor(0x1_0000_0000 / n) * n;
  for (;;) {
    const x = rand32();
    if (x < limit) return x % n;
  }
}

function defaultRand32(): number {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0];
}

/**
 * Picks `count` winners from the eligible entries.
 *  - per_person: every person has the same chance (one draw per person), then one of their eligible comments is shown.
 *  - per_comment: every eligible comment is one chance; the same comment is never picked twice; without repeat winners,
 *    all of a winner's other comments leave the pool.
 * `blocked` holds identity keys / comment ids that must not win (current winners, replaced winners).
 */
export function pickWinners(
  eligible: DrawEntry[],
  s: Pick_<DrawSettings, "entry_mode" | "allow_repeat_winner">,
  count: number,
  opts: { blockedKeys?: Set<string>; blockedComments?: Set<string>; rand32?: () => number } = {},
): DrawEntry[] {
  const repeat = effectiveAllowRepeat(s);
  const blockedKeys = new Set(opts.blockedKeys ?? []);
  const blockedComments = new Set(opts.blockedComments ?? []);
  const out: DrawEntry[] = [];
  if (s.entry_mode === "per_person") {
    const byPerson = new Map<string, DrawEntry[]>();
    for (const e of eligible) {
      const k = identityKey(e)!;
      if (blockedKeys.has(k) || blockedComments.has(e.comment_id)) continue;
      byPerson.set(k, [...(byPerson.get(k) ?? []), e]);
    }
    const people = [...byPerson.keys()];
    if (count > people.length) throw new DrawError("not_enough", people.length);
    for (let i = 0; i < count; i++) {
      const idx = secureRandomInt(people.length, opts.rand32);
      const key = people.splice(idx, 1)[0];
      const own = byPerson.get(key)!;
      out.push(own[secureRandomInt(own.length, opts.rand32)]);
    }
    return out;
  }
  let pool = eligible.filter((e) => !blockedComments.has(e.comment_id) && (repeat || !blockedKeys.has(identityKey(e)!)));
  const possible = repeat ? pool.length : new Set(pool.map((e) => identityKey(e)!)).size;
  if (count > possible) throw new DrawError("not_enough", possible);
  for (let i = 0; i < count; i++) {
    const idx = secureRandomInt(pool.length, opts.rand32);
    const w = pool[idx];
    out.push(w);
    pool.splice(idx, 1); // never the same comment twice
    if (!repeat) {
      const k = identityKey(w)!;
      pool = pool.filter((e) => identityKey(e) !== k);
    }
  }
  return out;
}

type Pick_<T, K extends keyof T> = { [P in K]: T[P] };

export class DrawError extends Error {
  constructor(
    public code: "not_enough",
    public possible: number,
  ) {
    super(`not enough eligible entries (possible: ${possible})`);
  }
}

/** Extracts the shortcode from an Instagram post / reel URL (or returns null). */
export function instagramShortcode(url: string): string | null {
  const m = url.trim().match(/^https?:\/\/(?:www\.)?instagram\.com\/(?:[A-Za-z0-9._]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]{5,40})/i);
  return m ? m[1] : null;
}
