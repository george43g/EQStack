/**
 * Grapheme-aware visual width and truncation helpers.
 *
 * The sidebar `ConversationItem` was truncating by `String#length`, which
 * counts UTF-16 code units. That splits surrogate pairs (one emoji is two
 * code units) and produces broken glyphs in the terminal. It also ignores
 * the fact that an emoji takes two terminal cells, not one.
 *
 * Approach:
 *   - Walk the string with `Intl.Segmenter` (granularity: "grapheme") so we
 *     never split inside a grapheme cluster (single emoji, family ZWJ, flag).
 *   - Approximate each cluster's terminal cell width with a fast range
 *     check — emoji, CJK, fullwidth and regional indicators are 2 cells;
 *     everything else (incl. ASCII, Latin diacritics, combining marks) is 1.
 *
 * Width approximation is coarse but covers every real-world iMessage handle
 * we care about (emoji-in-display-name is the dominant failure mode).
 */

const SEG = new Intl.Segmenter("en", { granularity: "grapheme" });

/**
 * Returns the approximate width in monospaced terminal cells of a single
 * grapheme cluster. 2 for emoji / CJK / fullwidth, 1 otherwise.
 */
export function clusterWidth(cluster: string): number {
  // ASCII fast path — single-byte and 1-cell.
  if (cluster.length === 1) {
    const code = cluster.charCodeAt(0);
    if (code < 0x80) return 1;
  }
  for (const ch of cluster) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    // Note: the 0x2600..0x27BF "misc symbols + dingbats" range (▶ ◀ ● ✉
    // ✓ ✗ ★ etc) is *ambiguous-width* per UAX #11 but monospaced
    // terminals render it as single-cell — we leave it at 1 to match
    // what the TUI's `safe` theme actually paints.
    if (
      // CJK Unified Ideographs + Compatibility — wide.
      (cp >= 0x3000 && cp <= 0x9fff) ||
      // Hangul Syllables.
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      // CJK Compatibility Ideographs.
      (cp >= 0xf900 && cp <= 0xfaff) ||
      // Fullwidth forms.
      (cp >= 0xff00 && cp <= 0xff60) ||
      // Halfwidth / fullwidth fence range (still 2-cell for fullwidth).
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      // Misc symbols and pictographs — the true emoji plane.
      cp >= 0x1f300
    ) {
      return 2;
    }
  }
  return 1;
}

/** Total monospaced cell width of a string. */
export function visualWidth(str: string): number {
  let w = 0;
  for (const { segment } of SEG.segment(str)) {
    w += clusterWidth(segment);
  }
  return w;
}

/**
 * Truncates `str` so that the returned string (including any ellipsis if
 * applied) fits within `maxCols` terminal cells. Never splits inside a
 * grapheme cluster. If `maxCols <= 0`, returns "".
 */
export function truncateToWidth(str: string, maxCols: number, ellipsis = "…"): string {
  if (maxCols <= 0) return "";
  if (visualWidth(str) <= maxCols) return str;

  const ellipsisW = visualWidth(ellipsis);
  // If the ellipsis itself doesn't fit, take whatever clusters do and
  // skip the ellipsis — better than returning "" or a clipped ellipsis.
  if (ellipsisW >= maxCols) {
    let usedFallback = 0;
    let outFallback = "";
    for (const { segment } of SEG.segment(str)) {
      const w = clusterWidth(segment);
      if (usedFallback + w > maxCols) break;
      outFallback += segment;
      usedFallback += w;
    }
    return outFallback;
  }

  let used = 0;
  let out = "";
  for (const { segment } of SEG.segment(str)) {
    const w = clusterWidth(segment);
    if (used + w + ellipsisW > maxCols) break;
    out += segment;
    used += w;
  }
  return out + ellipsis;
}
