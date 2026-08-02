/**
 * `contact:N` disambiguation selector — port of the carterlasalle pattern.
 *
 * When a fuzzy contact search returns multiple matches, the agent can't pick
 * one without round-tripping a clarifying question to the user. Instead, the
 * server remembers the most recent ambiguous result set, returns an indexed
 * `matches` list, and accepts `handle: "contact:N"` on the next call to
 * re-select the Nth match.
 *
 * Scope: process-wide LRU of the 10 most recent searches. Per-process is
 * deliberate — the selector is meant to bridge a single agent turn, not
 * persist forever. Clients that restart the MCP server lose the cache.
 */

const MAX_ENTRIES = 10;

interface CachedMatch {
  handle: string;
  displayName: string;
}

interface CacheEntry {
  query: string;
  recordedAt: number;
  matches: CachedMatch[];
}

const lru: CacheEntry[] = [];

/** Record a search result set so the user can re-select with `contact:N`. */
export function rememberSearch(query: string, matches: CachedMatch[]): void {
  if (matches.length === 0) return;
  // Drop existing entry for the same query (keep LRU ordering coherent).
  const dupIdx = lru.findIndex((e) => e.query === query);
  if (dupIdx >= 0) lru.splice(dupIdx, 1);
  lru.unshift({ query, recordedAt: Date.now(), matches });
  if (lru.length > MAX_ENTRIES) lru.length = MAX_ENTRIES;
}

/**
 * If `selector` is of the form `contact:N`, return the corresponding
 * remembered match (1-indexed). Searches all cached entries newest-first
 * so the most recent ambiguous search wins. Returns null if no `contact:N`
 * input or no match found.
 */
export function resolveContactSelector(selector: string): CachedMatch | null {
  const m = selector.match(/^contact:(\d+)$/i);
  if (!m?.[1]) return null;
  const idx = Number.parseInt(m[1], 10) - 1;
  if (idx < 0) return null;
  for (const entry of lru) {
    if (idx < entry.matches.length) {
      const hit = entry.matches[idx];
      if (hit) return hit;
    }
  }
  return null;
}

/** Test-only — inspect cache state. */
export function _cacheForTests(): ReadonlyArray<CacheEntry> {
  return lru;
}

/** Test-only — clear cache between cases. */
export function _resetCacheForTests(): void {
  lru.length = 0;
}
