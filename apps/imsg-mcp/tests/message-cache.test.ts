/**
 * messageCache: TTL eviction, LRU under memory pressure, prepend dedup.
 *
 * Pure module tests — no DB, no React. Each test resets state via clearCache.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  cacheStats,
  clearCache,
  evictUnderPressure,
  getCached,
  isFresh,
  prependCached,
  setCached,
  ttlSweep,
} from "../src/tui/messageCache.js";
import type { Message } from "../src/types.js";

function fakeMsg(id: number, text: string, dateMs = id * 1000): Message {
  return {
    id,
    guid: `g${id}`,
    text,
    handle: "+1",
    isFromMe: false,
    date: new Date(dateMs),
    dateRead: null,
    dateDelivered: null,
    isRead: false,
    isDelivered: false,
    chatId: "c",
    service: "iMessage",
    isReaction: false,
    isReply: false,
    isEdited: false,
    isRetracted: false,
    hasAttachments: false,
  };
}

afterEach(() => {
  clearCache();
});

describe("setCached / getCached", () => {
  it("round-trips a chat's messages", () => {
    const msgs = [fakeMsg(1, "a"), fakeMsg(2, "b")];
    setCached("chat1", msgs, 1);
    const entry = getCached("chat1");
    expect(entry).toBeDefined();
    expect(entry!.messages).toHaveLength(2);
    expect(entry!.oldestId).toBe(1);
  });

  it("getCached touches lastAccess (LRU bookkeeping)", () => {
    setCached("chat1", [fakeMsg(1, "a")], 1);
    const t0 = getCached("chat1")!.lastAccess;
    // Force time advancement
    const start = Date.now();
    while (Date.now() - start < 5) {
      // busy wait
    }
    const t1 = getCached("chat1")!.lastAccess;
    expect(t1).toBeGreaterThan(t0);
  });
});

describe("isFresh", () => {
  it("returns true within stale window", () => {
    setCached("c", [fakeMsg(1, "a")], 1);
    const e = getCached("c")!;
    expect(isFresh(e, e.loadedAt + 1000)).toBe(true);
  });

  it("returns false past stale window", () => {
    setCached("c", [fakeMsg(1, "a")], 1);
    const e = getCached("c")!;
    expect(isFresh(e, e.loadedAt + 60_000)).toBe(false);
  });
});

describe("prependCached", () => {
  it("prepends older messages and dedupes by id", () => {
    setCached("c", [fakeMsg(5, "e"), fakeMsg(6, "f")], 5);
    prependCached("c", [fakeMsg(3, "c"), fakeMsg(4, "d"), fakeMsg(5, "e-dup")]);
    const e = getCached("c")!;
    const ids = e.messages.map((m) => m.id);
    expect(ids).toEqual([3, 4, 5, 6]);
    expect(e.oldestId).toBe(3);
    // The 'e-dup' shouldn't have replaced the original 5
    expect(e.messages.find((m) => m.id === 5)?.text).toBe("e");
  });

  it("ignores prepend on missing entry", () => {
    expect(() => prependCached("missing", [fakeMsg(1, "x")])).not.toThrow();
    expect(getCached("missing")).toBeUndefined();
  });

  it("no-op when nothing new (all already in cache)", () => {
    setCached("c", [fakeMsg(1, "a"), fakeMsg(2, "b")], 1);
    const before = getCached("c")!.messages.length;
    prependCached("c", [fakeMsg(1, "a-dup"), fakeMsg(2, "b-dup")]);
    expect(getCached("c")!.messages.length).toBe(before);
  });

  it("survives a very large fresh batch (no Math.min spread crash)", () => {
    // Pre-fix the implementation did `Math.min(entry.oldestId, ...fresh.map(...))`
    // which throws "Maximum call stack size exceeded" past ~125k spread
    // args. A 200k-message older-load batch (reachable via the bounded
    // cap or aggressive paginate) would crash the cache update.
    setCached("c", [fakeMsg(1_000_000, "tail")], 1_000_000);
    const huge = Array.from({ length: 200_000 }, (_, i) => fakeMsg(i + 1, `m${i}`));
    expect(() => prependCached("c", huge)).not.toThrow();
    const entry = getCached("c");
    expect(entry?.oldestId).toBe(1);
    expect(entry?.messages.length).toBe(200_001);
  }, 15_000);
});

describe("ttlSweep", () => {
  it("drops entries older than TTL_MS", () => {
    setCached("c1", [fakeMsg(1, "a")], 1);
    // Manually move loadedAt back beyond default TTL (10 min)
    const e = getCached("c1")!;
    e.loadedAt = Date.now() - 11 * 60 * 1000;
    const dropped = ttlSweep();
    expect(dropped).toBe(1);
    expect(getCached("c1")).toBeUndefined();
  });

  it("keeps entries within TTL_MS", () => {
    setCached("c1", [fakeMsg(1, "a")], 1);
    const dropped = ttlSweep();
    expect(dropped).toBe(0);
    expect(getCached("c1")).toBeDefined();
  });
});

describe("evictUnderPressure", () => {
  it("evicts LRU half when heap > threshold", () => {
    setCached("a", [fakeMsg(1, "a")], 1);
    setCached("b", [fakeMsg(2, "b")], 2);
    setCached("c", [fakeMsg(3, "c")], 3);
    setCached("d", [fakeMsg(4, "d")], 4);
    // Simulate access order: a is oldest (lastAccess earliest)
    getCached("d");
    getCached("c");
    getCached("b");
    // a is LRU
    const evicted = evictUnderPressure(500); // way above threshold
    expect(evicted).toBeGreaterThan(0);
    expect(getCached("a")).toBeUndefined(); // LRU got evicted first
    expect(getCached("d")).toBeDefined();
  });

  it("does nothing under the threshold", () => {
    setCached("a", [fakeMsg(1, "a")], 1);
    const evicted = evictUnderPressure(50); // well under default 200
    expect(evicted).toBe(0);
    expect(getCached("a")).toBeDefined();
  });
});

describe("cacheStats", () => {
  it("counts entries", () => {
    expect(cacheStats().entries).toBe(0);
    setCached("a", [fakeMsg(1, "hello")], 1);
    setCached("b", [fakeMsg(2, "world")], 2);
    expect(cacheStats().entries).toBe(2);
    expect(cacheStats().bytes).toBeGreaterThan(0);
  });
});
