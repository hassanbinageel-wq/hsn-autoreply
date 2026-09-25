import { normalizeText, tokens, type NormalizeOptions } from "./normalize";

export type MatchType = "exact" | "word" | "contains";

export interface KeywordRule {
  keyword: string;
  kind: "include" | "exclude";
  matchType: MatchType;
}

export interface MatchConfig {
  /** Explicit "all comments / all replies" mode. Exclusions still apply. */
  matchAll: boolean;
  keywords: KeywordRule[];
  normalize?: NormalizeOptions;
}

export interface MatchResult {
  matched: boolean;
  reason: string;
  keyword?: string;
}

function containsTokenSequence(hay: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > hay.length) return false;
  outer: for (let i = 0; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

/** Match a single keyword against already-normalized text. */
export function matchKeyword(normText: string, keyword: string, type: MatchType, opts?: NormalizeOptions): boolean {
  const k = normalizeText(keyword, opts);
  if (!k) return false;
  switch (type) {
    case "exact":
      return normText === k;
    case "word":
      return containsTokenSequence(tokens(normText), tokens(k));
    case "contains":
      return normText.includes(k);
  }
}

export function evaluateMatch(text: string, cfg: MatchConfig): MatchResult {
  const norm = normalizeText(text ?? "", cfg.normalize);
  for (const rule of cfg.keywords) {
    if (rule.kind === "exclude" && matchKeyword(norm, rule.keyword, rule.matchType, cfg.normalize)) {
      return { matched: false, reason: "excluded_keyword", keyword: rule.keyword };
    }
  }
  if (cfg.matchAll) return { matched: true, reason: "match_all" };
  for (const rule of cfg.keywords) {
    if (rule.kind === "include" && matchKeyword(norm, rule.keyword, rule.matchType, cfg.normalize)) {
      return { matched: true, reason: `keyword_${rule.matchType}`, keyword: rule.keyword };
    }
  }
  return { matched: false, reason: "no_keyword_match" };
}

/** Control words used inside an existing flow ("ابدأ" / "تحقق"). */
export const START_WORDS = ["ابدا", "ابدأ", "start", "بدء"];
export const VERIFY_WORDS = ["تحقق", "تحقّق", "verify", "check", "تم", "تابعت"];

export function isControlWord(text: string, words: string[]): boolean {
  const norm = normalizeText(text, { unifyAlef: true });
  return words.some((w) => normalizeText(w, { unifyAlef: true }) === norm);
}
