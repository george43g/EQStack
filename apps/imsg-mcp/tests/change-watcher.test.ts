/**
 * ChangeWatcher tests.
 *
 * Unit coverage drives the watcher through its injected DB seam (`pump()`
 * bypasses fs.watch + debounce), so classification, cursor advancement,
 * paging, and re-entrancy are deterministic. One integration block arms a
 * REAL fs.watch on a temp directory and asserts WAL-write events coalesce
 * through the debounce into a single drain.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChangeWatcher, type ChangeWatcherDb } from "../src/change-watcher.js";
import { type ChangeEvent, EventBus } from "../src/event-bus.js";
import type { Message } from "../src/types.js";

function msg(id: number, isReaction = false): Message {
  return { id, isReaction, text: `m${id}`, date: new Date(id) } as unknown as Message;
}

/** Fake DB: rows appear via push(); delta reads mirror the real contract. */
function fakeDb(initialMaxRowid = 100) {
  const rows: Message[] = [];
  let reads = 0;
  const db: ChangeWatcherDb = {
    getMaxMessageRowId: () => initialMaxRowid,
    getMessagesAfterRowid: async (afterRowid, limit = 500) => {
      reads += 1;
      return rows.filter((m) => m.id > afterRowid).slice(0, limit);
    },
  };
  return {
    db,
    push: (...ms: Message[]) => rows.push(...ms),
    reads: () => reads,
  };
}

describe("ChangeWatcher (unit, injected db)", () => {
  it("seeds the high-water mark from the current max ROWID at start", () => {
    const { db } = fakeDb(42);
    const w = new ChangeWatcher({
      dbPath: "/nonexistent-dir-xyz/chat.db",
      db,
      bus: new EventBus(),
    });
    w.start();
    expect(w.getHighWaterRowid()).toBe(42);
    w.stop();
  });

  it("pump() emits classified batches and advances the cursor", async () => {
    const { db, push } = fakeDb(100);
    const bus = new EventBus();
    const batches: (readonly ChangeEvent[])[] = [];
    bus.subscribe((e) => batches.push(e));

    const w = new ChangeWatcher({ dbPath: "/nonexistent-dir-xyz/chat.db", db, bus });
    w.start();
    push(msg(101), msg(102, true), msg(103));
    await w.pump();

    expect(batches).toHaveLength(1);
    expect(batches[0]?.map((e) => e.type)).toEqual(["message.new", "reaction", "message.new"]);
    expect(w.getHighWaterRowid()).toBe(103);

    // Nothing new -> no emit, cursor stays.
    await w.pump();
    expect(batches).toHaveLength(1);
    expect(w.getHighWaterRowid()).toBe(103);
    w.stop();
  });

  it("pages full batches in a loop (bulk sync) without duplicating rows", async () => {
    const { db, push } = fakeDb(0);
    const bus = new EventBus();
    const batches: (readonly ChangeEvent[])[] = [];
    bus.subscribe((e) => batches.push(e));

    const w = new ChangeWatcher({
      dbPath: "/nonexistent-dir-xyz/chat.db",
      db,
      bus,
      maxBatch: 3,
    });
    w.start();
    push(msg(1), msg(2), msg(3), msg(4), msg(5), msg(6), msg(7));
    await w.pump();

    expect(batches.map((b) => b.length)).toEqual([3, 3, 1]);
    const ids = batches.flat().map((e) => ("message" in e ? e.message.id : -1));
    expect(ids).toEqual([1, 2, 3, 4, 5, 6, 7]); // in order, no dupes
    expect(w.getHighWaterRowid()).toBe(7);
    w.stop();
  });

  it("re-entrant pump during a drain re-arms instead of overlapping", async () => {
    const bus = new EventBus();
    const batches: (readonly ChangeEvent[])[] = [];
    bus.subscribe((e) => batches.push(e));

    let release: (() => void) | null = null;
    let reads = 0;
    const rows: Message[] = [msg(1)];
    const db: ChangeWatcherDb = {
      getMaxMessageRowId: () => 0,
      getMessagesAfterRowid: async (afterRowid) => {
        reads += 1;
        if (reads === 1) {
          // Hold the first read open so a second pump lands mid-drain.
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return rows.filter((m) => m.id > afterRowid);
      },
    };

    const w = new ChangeWatcher({ dbPath: "/nonexistent-dir-xyz/chat.db", db, bus });
    w.start();
    const first = w.pump();
    const second = w.pump(); // lands while the first drain is blocked
    await second; // returns immediately (re-arm flag set)
    rows.push(msg(2));
    release?.();
    await first;
    await vi.waitFor(() => {
      // The re-armed drain picked up the row added mid-flight.
      expect(w.getHighWaterRowid()).toBe(2);
    });
    const ids = batches.flat().map((e) => ("message" in e ? e.message.id : -1));
    expect(ids).toEqual([1, 2]); // no duplicated row from overlapping reads
    w.stop();
  });

  it("drain errors are swallowed (never thrown into the host)", async () => {
    const bus = new EventBus();
    const db: ChangeWatcherDb = {
      getMaxMessageRowId: () => 0,
      getMessagesAfterRowid: async () => {
        throw new Error("db locked");
      },
    };
    const w = new ChangeWatcher({ dbPath: "/nonexistent-dir-xyz/chat.db", db, bus });
    w.start();
    await expect(w.pump()).resolves.toBeUndefined();
    w.stop();
  });

  it("falls back to polling when fs.watch is unavailable", () => {
    const { db } = fakeDb(0);
    // dirname of this path does not exist -> fs.watch throws synchronously.
    const w = new ChangeWatcher({
      dbPath: join(tmpdir(), `imsg-cw-missing-${process.pid}`, "chat.db"),
      db,
      bus: new EventBus(),
    });
    w.start();
    expect(w.isPolling()).toBe(true);
    w.stop();
  });
});

describe("ChangeWatcher (integration, real fs.watch)", () => {
  let dir: string;
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  it("WAL writes trigger exactly one debounced drain; stop() disarms", async () => {
    dir = mkdtempSync(join(tmpdir(), "imsg-cw-int-"));
    const dbPath = join(dir, "chat.db");
    writeFileSync(dbPath, "");
    const { db, push, reads } = fakeDb(0);
    const bus = new EventBus();
    const batches: (readonly ChangeEvent[])[] = [];
    bus.subscribe((e) => batches.push(e));

    const w = new ChangeWatcher({ dbPath, db, bus, debounceMs: 40 });
    w.start();
    expect(w.isPolling()).toBe(false);

    push(msg(1), msg(2));
    // Three rapid WAL touches must coalesce into ONE drain via the debounce.
    writeFileSync(join(dir, "chat.db-wal"), "a");
    writeFileSync(join(dir, "chat.db-wal"), "ab");
    writeFileSync(join(dir, "chat.db-wal"), "abc");

    await vi.waitFor(
      () => {
        expect(batches).toHaveLength(1);
      },
      { timeout: 3_000 },
    );
    expect(batches[0]).toHaveLength(2);
    expect(reads()).toBe(1);

    // Unrelated files in the directory do not trigger drains.
    writeFileSync(join(dir, "unrelated.txt"), "x");
    await new Promise((r) => setTimeout(r, 120));
    expect(reads()).toBe(1);

    w.stop();
    writeFileSync(join(dir, "chat.db-wal"), "abcd");
    await new Promise((r) => setTimeout(r, 120));
    expect(reads()).toBe(1); // disarmed
  });
});
