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

  it("exposes cumulative hit/miss/eviction counters", () => {
    const s = cacheStats();
    expect(typeof s.hits).toBe("number");
    expect(typeof s.misses).toBe("number");
    expect(typeof s.evictions).toBe("number");
  });
});

// Counters are cumulative for the process lifetime (clearCache does not reset
// them), so every assertion here is a delta against a before-snapshot.
describe("hit-rate counters", () => {
  it("counts a miss on first read, a hit on warm read within STALE_MS", () => {
    const before = cacheStats();
    expect(getCached("counter-chat")).toBeUndefined(); // absent → miss
    expect(cacheStats().misses).toBe(before.misses + 1);
    expect(cacheStats().hits).toBe(before.hits);

    setCached("counter-chat", [fakeMsg(1, "a")], 1);
    expect(getCached("counter-chat")).toBeDefined(); // fresh → hit
    expect(cacheStats().hits).toBe(before.hits + 1);
    expect(cacheStats().misses).toBe(before.misses + 1);
  });

  it("counts a stale entry as a miss", () => {
    setCached("stale-chat", [fakeMsg(1, "a")], 1);
    const e = getCached("stale-chat")!; // fresh → hit (not asserted here)
    e.loadedAt = Date.now() - 24 * 60 * 60 * 1000; // way past any stale window
    const before = cacheStats();
    expect(getCached("stale-chat")).toBeDefined(); // stale → miss
    expect(cacheStats().misses).toBe(before.misses + 1);
    expect(cacheStats().hits).toBe(before.hits);
  });

  it("counts entries dropped by the TTL sweep as evictions", () => {
    setCached("t1", [fakeMsg(1, "a")], 1);
    setCached("t2", [fakeMsg(2, "b")], 2);
    for (const k of ["t1", "t2"]) {
      getCached(k)!.loadedAt = Date.now() - 11 * 60 * 1000;
    }
    const before = cacheStats();
    expect(ttlSweep()).toBe(2);
    expect(cacheStats().evictions).toBe(before.evictions + 2);
  });

  it("counts entries dropped under memory pressure as evictions", () => {
    setCached("p1", [fakeMsg(1, "a")], 1);
    setCached("p2", [fakeMsg(2, "b")], 2);
    const before = cacheStats();
    const evicted = evictUnderPressure(500); // way above threshold
    expect(evicted).toBeGreaterThan(0);
    expect(cacheStats().evictions).toBe(before.evictions + evicted);
  });

  it("clearCache does NOT count as evictions", () => {
    setCached("c1", [fakeMsg(1, "a")], 1);
    setCached("c2", [fakeMsg(2, "b")], 2);
    const before = cacheStats();
    clearCache();
    expect(cacheStats().entries).toBe(0);
    expect(cacheStats().evictions).toBe(before.evictions);
  });
});

describe("write-time byte budget (IMSG_TUI_CACHE_MAX_BYTES, default 24MB estimate)", () => {
  afterEach(() => clearCache());

  // ~7MB of estimateBytes per entry: 100 messages × 35k chars × 2 bytes.
  const bigEntry = (idBase: number) =>
    Array.from({ length: 100 }, (_, i) => fakeMsg(idBase + i, "x".repeat(35_000)));

  it("evicts LRU entries on write once the total estimate exceeds the budget", () => {
    const before = cacheStats().evictions;
    setCached("chat-a", bigEntry(1_000), 1_000);
    setCached("chat-b", bigEntry(2_000), 2_000);
    setCached("chat-c", bigEntry(3_000), 3_000);
    // 3 × ~7MB fits inside 24MB — nothing evicted yet.
    expect(cacheStats().entries).toBe(3);
    setCached("chat-d", bigEntry(4_000), 4_000);
    // 4th write crosses the budget: the LRU entry (chat-a) goes.
    expect(cacheStats().entries).toBeLessThan(4);
    expect(getCached("chat-a")).toBeUndefined();
    expect(cacheStats().evictions).toBeGreaterThan(before);
  });

  it("never evicts the entry just written, even if it alone exceeds the budget", () => {
    const huge = Array.from({ length: 100 }, (_, i) => fakeMsg(9_000 + i, "y".repeat(150_000)));
    setCached("chat-huge", huge, 9_000);
    expect(getCached("chat-huge")).toBeDefined();
    expect(cacheStats().entries).toBe(1);
  });

  it("prependCached also enforces the budget (the pagination-spree path)", () => {
    setCached("chat-active", bigEntry(1_000), 1_000);
    setCached("chat-idle", bigEntry(2_000), 2_000);
    // Grow the active entry past the budget via repeated prepends — the
    // wheel-held-at-top scenario. The idle entry must be evicted; the
    // active (protected) one must survive.
    for (let page = 0; page < 3; page++) {
      prependCached("chat-active", bigEntry(10_000 + page * 200));
    }
    expect(getCached("chat-active")).toBeDefined();
    expect(getCached("chat-idle")).toBeUndefined();
  });
});
