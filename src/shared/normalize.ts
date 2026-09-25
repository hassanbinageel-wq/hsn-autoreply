/**
 * Text normalization for keyword matching (Arabic + English).
 *
 * The original text is never modified or stored in normalized form for display;
 * normalization is only used to compare comment / message text with keywords.
 */

export interface NormalizeOptions {
  /** Unify أ إ آ ٱ → ا (optional per campaign). */
  unifyAlef?: boolean;
}

// Arabic harakat / tanween / shadda / sukun and Quranic annotation marks.
const TASHKEEL = /[ؐ-ًؚ-ٰٟۖ-ۜ۟-۪ۨ-ۭ]/g;
const TATWEEL = /ـ/g;
const ALEF_VARIANTS = /[آأإٱ]/g; // آ أ إ ٱ
// Punctuation, symbols (incl. emoji) and zero-width / bidi control characters → space.
const PUNCT_OR_SYMBOL = /[\p{P}\p{S}]/gu;
const INVISIBLES = /[​-‏‪-‮⁦-⁩﻿]/g;
const WHITESPACE = /\s+/gu;

function arabicDigitsToAscii(s: string): string {
  return s.replace(/[٠-٩۰-۹]/g, (d) => {
    const code = d.charCodeAt(0);
    return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
  });
}

export function normalizeText(input: string, opts: NormalizeOptions = {}): string {
  if (!input) return "";
  let s = input.normalize("NFKC");
  s = s.replace(INVISIBLES, "");
  s = s.replace(TASHKEEL, "").replace(TATWEEL, "");
  if (opts.unifyAlef) s = s.replace(ALEF_VARIANTS, "ا");
  s = arabicDigitsToAscii(s);
  s = s.toLowerCase();
  s = s.replace(PUNCT_OR_SYMBOL, " ");
  s = s.replace(WHITESPACE, " ").trim();
  return s;
}

/** Tokenize a normalized string on whitespace (never uses \b, which breaks Arabic). */
export function tokens(normalized: string): string[] {
  return normalized ? normalized.split(" ") : [];
}
