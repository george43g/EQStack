/**
 * Lightweight fuzzy string scoring — a TS port of the "WRatio" approach used
 * by thefuzz / fuzzywuzzy. No external dep. Tuned for short, multi-token
 * message-body queries.
 *
 * Returns a normalized score in [0, 1]. Higher = better match.
 *
 * Two-pass:
 *   1. Cheap substring shortcut — if the cleaned query is a substring of the
 *      cleaned candidate, return 0.95 immediately (skip the expensive token
 *      scoring).
 *   2. Token-set scoring — split both strings into a token set, compute a
 *      Sørensen-Dice coefficient over the intersection, then blend with a
 *      Levenshtein-based ratio for short queries to catch typos.
 */

const EMOJI_REGEX = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}]/gu;
const WHITESPACE_REGEX = /\s+/g;

/** Lowercase, strip emoji, collapse whitespace, trim. */
export function cleanText(s: string): string {
  return s.toLowerCase().replace(EMOJI_REGEX, " ").replace(WHITESPACE_REGEX, " ").trim();
}

/** Tokenize a cleaned string into a Set of unique tokens. */
function tokenSet(s: string): Set<string> {
  if (!s) return new Set();
  return new Set(s.split(" ").filter(Boolean));
}

/**
 * Levenshtein distance with early-exit when the running min row exceeds
 * a threshold. We cap the candidate length at 200 chars because past that
 * the cost grows quadratically and the message bodies we care about are
 * typically short.
 */
function levenshtein(a: string, b: string, maxLen = 200): number {
  if (a === b) return 0;
  const aLen = Math.min(a.length, maxLen);
  const bLen = Math.min(b.length, maxLen);
  if (aLen === 0) return bLen;
  if (bLen === 0) return aLen;

  let prev = new Array<number>(bLen + 1);
  let curr = new Array<number>(bLen + 1);
  for (let j = 0; j <= bLen; j++) prev[j] = j;

  for (let i = 1; i <= aLen; i++) {
    curr[0] = i;
    for (let j = 1; j <= bLen; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const del = (prev[j] ?? 0) + 1;
      const ins = (curr[j - 1] ?? 0) + 1;
      const sub = (prev[j - 1] ?? 0) + cost;
      curr[j] = Math.min(del, ins, sub);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[bLen] ?? Math.max(aLen, bLen);
}

/** Levenshtein ratio in [0, 1]: 1 - (distance / max-len). */
function levenshteinRatio(a: string, b: string): number {
  if (a === b) return 1;
  const aLen = Math.min(a.length, 200);
  const bLen = Math.min(b.length, 200);
  const maxLen = Math.max(aLen, bLen);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

/**
 * Score query against candidate. Returns 0..1.
 *
 * Performance: O(n + m) substring, O(n*m) Levenshtein worst case (capped at
 * 200 chars). For 10,000-row search this is fine in a single sync sweep.
 */
export function fuzzyScore(query: string, candidate: string): number {
  // Raw-substring fast path runs BEFORE cleanText so emoji / punctuation
  // queries still match. `cleanText` strips emoji (good for tokenizing
  // English text, bad if the query *is* an emoji) — without this branch
  // a search for "🪦" against "i need a money 🪦" returned 0 because
  // cleanText("🪦") === "" → score 0 → filtered.
  if (query && candidate && candidate.toLowerCase().includes(query.toLowerCase())) {
    return 0.95;
  }

  const q = cleanText(query);
  const c = cleanText(candidate);
  if (!q || !c) return 0;

  // 1. Substring shortcut.
  if (c.includes(q)) return 0.95;
  if (q.includes(c)) return 0.9;

  // 2. Token-set Dice coefficient.
  const qTokens = tokenSet(q);
  const cTokens = tokenSet(c);
  let intersection = 0;
  for (const tok of qTokens) {
    if (cTokens.has(tok)) intersection++;
  }
  const dice = (2 * intersection) / (qTokens.size + cTokens.size || 1);

  // 3. Levenshtein ratio (catches typos in short queries).
  // For single-token queries we ALSO compute lev against the best matching
  // token in the candidate so a typo'd word can still match a longer body.
  let bestTokenLev = 0;
  if (qTokens.size === 1) {
    for (const tok of cTokens) {
      const r = levenshteinRatio(q, tok);
      if (r > bestTokenLev) bestTokenLev = r;
    }
  }
  const levRatio = Math.max(levenshteinRatio(q, c), bestTokenLev);

  // Blend: for single-token queries, levRatio dominates (Dice is 0 when
  // tokens don't overlap exactly — a typo kills it). For multi-token
  // queries, token-set is more informative.
  const blend = qTokens.size <= 1 ? 0.1 * dice + 0.9 * levRatio : 0.7 * dice + 0.3 * levRatio;

  return Math.max(0, Math.min(1, blend));
}

/** Score and rank candidates. Returns sorted (best first) with scores. */
export function rankFuzzy<T>(
  query: string,
  candidates: T[],
  getText: (c: T) => string,
  minScore = 0.6,
): Array<{ item: T; score: number }> {
  const out: Array<{ item: T; score: number }> = [];
  for (const c of candidates) {
    const score = fuzzyScore(query, getText(c));
    if (score >= minScore) out.push({ item: c, score });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}
