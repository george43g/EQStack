/**
 * In-memory cache of messages-per-chat for the TUI.
 *
 * Behavior:
 *  - When the user re-enters a chat they've already viewed within
 *    `STALE_MS`, return cached messages immediately (no DB round trip).
 *  - Older entries get evicted on a TTL sweep every 60s.
 *  - When heap pressure crosses `MEMORY_PRESSURE_MB` (sampled by the
 *    watchdog), evict the LRU half of the cache until below threshold.
 *
 * Pure module — no React imports. Used by `useImsg.ts` and observable
 * via `cacheStats()` for the dev stats panel.
 */

import { info } from "../logger.js";
import type { Message } from "../types.js";
import { onMemorySample } from "../watchdog.js";

interface CacheEntry {
  messages: Message[];
  oldestId: number; // for "load older" continuity
  loadedAt: number; // wall-clock ms
  lastAccess: number; // for LRU
  bytesEstimate: number;
}

function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const TTL_MS = envNum("IMSG_TUI_CACHE_TTL_MS", 600_000); // 10 min
const STALE_MS = envNum("IMSG_TUI_CACHE_STALE_MS", 30_000); // 30s
const MEMORY_PRESSURE_MB = envNum("IMSG_TUI_CACHE_MEM_PRESSURE_MB", 200); // heap MB
// Hard byte budget enforced ON WRITE. The memory-pressure eviction above only
// runs on the watchdog's 60s sample — a fast pagination spree (wheel held at
// the top of a big thread) can accumulate hundreds of MB inside one window,
// which is exactly how a real session hit the 1024MB RSS watchdog kill in
// under 3 minutes. Budget is in estimateBytes() space (text-only, so real
// retained memory is a multiple of it) — the default is deliberately small.
const MAX_TOTAL_BYTES = envNum("IMSG_TUI_CACHE_MAX_BYTES", 24 * 1024 * 1024);

const cache = new Map<string, CacheEntry>();
let sweepTimer: ReturnType<typeof setInterval> | null = null;
let unsubMemSample: (() => void) | null = null;

// Hit-rate accounting — cumulative for the process lifetime. `clearCache()`
// deliberately leaves these alone: it's a manual reset, not an eviction.
let hits = 0;
let misses = 0;
let evictions = 0;
let lastLoggedLookups = 0; // hits+misses at the last cache_hit_rate emission

function estimateBytes(messages: Message[]): number {
  // Rough — only matters for relative sizing during eviction
  let bytes = 0;
  for (const m of messages) {
    bytes += (m.text?.length ?? 0) * 2; // UTF-16
    bytes += (m.handle?.length ?? 0) * 2;
    bytes += 80; // fixed overhead per message (date, ids, flags)
  }
  return bytes;
}

/** Get cached entry; returns undefined if missing. Touches lastAccess.
 *
 * This is the read boundary for hit-rate accounting: a fresh entry counts as
 * a hit; absent or stale counts as a miss — matching the `useImsg`
 * read-through, which treats a stale entry as a DB round-trip.
 */
export function getCached(chatIdentifier: string): CacheEntry | undefined {
  const entry = cache.get(chatIdentifier);
  if (entry && isFresh(entry)) hits++;
  else misses++;
  if (entry) entry.lastAccess = Date.now();
  return entry;
}

/** Returns true if the entry is fresh enough to skip a DB round-trip. */
export function isFresh(entry: CacheEntry, now = Date.now()): boolean {
  return now - entry.loadedAt < STALE_MS;
}

/** Replace (or insert) the cache entry for a chat. */
export function setCached(chatIdentifier: string, messages: Message[], oldestId: number): void {
  const now = Date.now();
  cache.set(chatIdentifier, {
    messages,
    oldestId,
    loadedAt: now,
    lastAccess: now,
    bytesEstimate: estimateBytes(messages),
  });
  enforceByteBudget(chatIdentifier);
}

/** Prepend older messages to an existing entry (dedup by id). */
export function prependCached(chatIdentifier: string, olderMessages: Message[]): void {
  const entry = cache.get(chatIdentifier);
  if (!entry) return;
  const existingIds = new Set(entry.messages.map((m) => m.id));
  const fresh = olderMessages.filter((m) => !existingIds.has(m.id));
  if (fresh.length === 0) return;
  const merged = [...fresh, ...entry.messages].sort((a, b) => a.date.getTime() - b.date.getTime());
  entry.messages = merged;
  // Reduce instead of `Math.min(entry.oldestId, ...fresh.map(...))`. The
  // spread form throws `RangeError: Maximum call stack size exceeded`
  // somewhere above ~125k arguments — reachable via batched older-load
  // on threads with huge history.
  let minFresh = fresh[0].id;
  for (let i = 1; i < fresh.length; i++) {
    if (fresh[i].id < minFresh) minFresh = fresh[i].id;
  }
  entry.oldestId = Math.min(entry.oldestId, minFresh);
  entry.lastAccess = Date.now();
  entry.bytesEstimate = estimateBytes(merged);
  enforceByteBudget(chatIdentifier);
}

/**
 * Append live-stream messages to an existing entry (dedupe by id).
 *
 * Deliberately does NOT bump `loadedAt`: the stream keeps the VIEW fresh,
 * but mutations it doesn't mirror into the cache (reaction folds, edits)
 * still need the read-through staleness window to trigger a real DB
 * re-query on re-entry.
 */
export function appendCached(chatIdentifier: string, newMessages: Message[]): void {
  const entry = cache.get(chatIdentifier);
  if (!entry) return;
  const existingIds = new Set(entry.messages.map((m) => m.id));
  const fresh = newMessages.filter((m) => !existingIds.has(m.id));
  if (fresh.length === 0) return;
  entry.messages = [...entry.messages, ...fresh];
  entry.lastAccess = Date.now();
  entry.bytesEstimate = estimateBytes(entry.messages);
  enforceByteBudget(chatIdentifier);
}

/**
 * Evict LRU entries until total estimated bytes fit the budget. The entry
 * named by `protectKey` (the chat just written — i.e. the active thread) is
 * never evicted, so a single over-budget thread stays viewable; the budget
 * then bounds everything else. Called from every write path.
 */
function enforceByteBudget(protectKey: string): void {
  let total = 0;
  for (const e of cache.values()) total += e.bytesEstimate;
  if (total <= MAX_TOTAL_BYTES) return;
  const lru = [...cache.entries()]
    .filter(([k]) => k !== protectKey)
    .sort((a, b) => a[1].lastAccess - b[1].lastAccess);
  for (const [k, e] of lru) {
    if (total <= MAX_TOTAL_BYTES) break;
    cache.delete(k);
    total -= e.bytesEstimate;
    evictions++;
  }
}

/** Clear all cached entries — used on shutdown / explicit refresh. */
export function clearCache(): void {
  cache.clear();
}

/** Cache size + cumulative hit/miss/eviction counters. For dev stats display. */
export function cacheStats(): {
  entries: number;
  bytes: number;
  hits: number;
  misses: number;
  evictions: number;
} {
  let bytes = 0;
  for (const e of cache.values()) bytes += e.bytesEstimate;
  return { entries: cache.size, bytes, hits, misses, evictions };
}

/** TTL sweep: drop entries older than TTL_MS. Exported for tests. */
export function ttlSweep(now = Date.now()): number {
  let dropped = 0;
  for (const [k, v] of cache) {
    if (now - v.loadedAt > TTL_MS) {
      cache.delete(k);
      dropped++;
      evictions++;
    }
  }
  return dropped;
}

/**
 * Memory-pressure eviction: when heap exceeds threshold, drop the LRU
 * half of the cache. Called from the watchdog memory sampler.
 */
export function evictUnderPressure(heapMb: number): number {
  if (heapMb < MEMORY_PRESSURE_MB) return 0;
  const sorted = [...cache.entries()].sort((a, b) => a[1].lastAccess - b[1].lastAccess);
  const half = Math.ceil(sorted.length / 2);
  for (let i = 0; i < half; i++) {
    cache.delete(sorted[i][0]);
    evictions++;
  }
  return half;
}

/**
 * Emit one `cache_hit_rate` log line per sweep tick — but only when a lookup
 * happened since the last emission, so an idle TUI doesn't heartbeat-spam.
 */
function logHitRate(): void {
  const lookups = hits + misses;
  if (lookups === lastLoggedLookups) return;
  lastLoggedLookups = lookups;
  info("cache_hit_rate", {
    hits,
    misses,
    evictions,
    entries: cache.size,
    hit_rate: lookups === 0 ? 0 : Math.round((hits / lookups) * 100) / 100,
  });
}

/** Install TTL sweep + memory-pressure subscription. Idempotent. */
export function installCacheSweepers(): void {
  if (sweepTimer) return;

  sweepTimer = setInterval(() => {
    ttlSweep();
    logHitRate();
  }, 60_000);
  sweepTimer.unref();

  unsubMemSample = onMemorySample((_rss, heapMb) => {
    evictUnderPressure(heapMb);
  });
}

/** Stop sweepers. Used by tests + on shutdown. */
export function stopCacheSweepers(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  if (unsubMemSample) {
    unsubMemSample();
    unsubMemSample = null;
  }
}
