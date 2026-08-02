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

const cache = new Map<string, CacheEntry>();
let sweepTimer: ReturnType<typeof setInterval> | null = null;
let unsubMemSample: (() => void) | null = null;

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

/** Get cached entry; returns undefined if missing. Touches lastAccess. */
export function getCached(chatIdentifier: string): CacheEntry | undefined {
  const entry = cache.get(chatIdentifier);
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
}

/** Clear all cached entries — used on shutdown / explicit refresh. */
export function clearCache(): void {
  cache.clear();
}

/** Number of cached chats and total estimated bytes. For dev stats display. */
export function cacheStats(): { entries: number; bytes: number } {
  let bytes = 0;
  for (const e of cache.values()) bytes += e.bytesEstimate;
  return { entries: cache.size, bytes };
}

/** TTL sweep: drop entries older than TTL_MS. Exported for tests. */
export function ttlSweep(now = Date.now()): number {
  let dropped = 0;
  for (const [k, v] of cache) {
    if (now - v.loadedAt > TTL_MS) {
      cache.delete(k);
      dropped++;
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
  }
  return half;
}

/** Install TTL sweep + memory-pressure subscription. Idempotent. */
export function installCacheSweepers(): void {
  if (sweepTimer) return;

  sweepTimer = setInterval(() => {
    ttlSweep();
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
