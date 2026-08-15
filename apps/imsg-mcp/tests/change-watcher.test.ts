/**
 * ChangeWatcher tests.
 *
 * Unit coverage drives the watcher through its injected DB seam (`pump()`
 * bypasses fs.watch + debounce), so classification, cursor advancement,
 * paging, and re-entrancy are deterministic. One integration block arms a
 * REAL fs.watch on a temp directory and asserts WAL-write events coalesce
 * through the debounce into a single drain.
 */

import { appendFileSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
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

    const walPath = join(dir, "chat.db-wal");
    const w = new ChangeWatcher({ dbPath, db, bus, debounceMs: 40, safetyPollMs: 0 });
    w.start();
    expect(w.isPolling()).toBe(false);

    push(msg(1), msg(2));

    // ── Phase 1: get the watch demonstrably armed ────────────────────────────
    // fs.watch arms ASYNCHRONOUSLY (kqueue on macOS, inotify on Linux). A single
    // burst fired in the same tick as start() can land entirely before the watch
    // is live, and with the safety poll disabled (safetyPollMs: 0) nothing would
    // ever drain — the test then fails with "expected [] to have a length of 1".
    // That race cost two releases (1.21.3, and again on the 1.21.5 run), so the
    // trigger retries instead of firing once. Later rounds are harmless: the
    // first drain consumes both rows, and subsequent drains find nothing past
    // the cursor, so they read but never emit.
    let n = 0;
    const deadline = Date.now() + 10_000;
    while (batches.length === 0 && Date.now() < deadline) {
      writeFileSync(walPath, "a".repeat(++n));
      await new Promise((r) => setTimeout(r, 60));
    }
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);

    await new Promise((r) => setTimeout(r, 150)); // let any straggler drain settle
    let settledReads = reads();
    expect(batches).toHaveLength(1); // still exactly one emission

    // ── Phase 2: NOW test debounce coalescing ───────────────────────────────
    // The watch is provably live (phase 1 observed an event through it), so a
    // rapid burst here is a real test of the debounce rather than a race with
    // arming. The invariant is no duplicate EMISSIONS, not a single read: the
    // directory watch and the wal-file watch are independent legs, and each may
    // schedule one (empty) drain for the burst — CI showed 2 where a laptop
    // shows 1. Three touches in one 40ms window must therefore cost at most one
    // drain PER LEG, and must not emit (no rows past the cursor).
    writeFileSync(walPath, "coalesce-1");
    writeFileSync(walPath, "coalesce-2");
    writeFileSync(walPath, "coalesce-3");
    await new Promise((r) => setTimeout(r, 250));
    expect(reads() - settledReads).toBeLessThanOrEqual(2);
    expect(batches).toHaveLength(1);
    settledReads = reads();

    // Unrelated files in the directory do not trigger drains.
    writeFileSync(join(dir, "unrelated.txt"), "x");
    await new Promise((r) => setTimeout(r, 120));
    expect(reads()).toBe(settledReads);

    w.stop();
    writeFileSync(join(dir, "chat.db-wal"), "abcd");
    await new Promise((r) => setTimeout(r, 120));
    expect(reads()).toBe(settledReads); // disarmed
  });

  it("APPENDS to a pre-existing WAL trigger a drain (the production write mode)", async () => {
    // Companion to the silent-watch bug: on the real ~/Library/Messages the
    // directory watch armed and then delivered nothing while rows landed
    // (suspected TCC/FSEvents filtering — NOT reproducible in a temp dir,
    // where dir watches do report appends, so this test cannot fail on the
    // old code). What it pins is the new wal FILE watch wiring: with the
    // safety poll disabled, a pure append to a PRE-EXISTING wal must drain.
    dir = mkdtempSync(join(tmpdir(), "imsg-cw-app-"));
    const dbPath = join(dir, "chat.db");
    writeFileSync(dbPath, "");
    writeFileSync(join(dir, "chat.db-wal"), "preexisting"); // BEFORE start()
    const { db, push } = fakeDb(0);
    const bus = new EventBus();
    const batches: (readonly ChangeEvent[])[] = [];
    bus.subscribe((e) => batches.push(e));

    const w = new ChangeWatcher({ dbPath, db, bus, debounceMs: 40, safetyPollMs: 0 });
    w.start();
    push(msg(1));

    // Append REPEATEDLY until the drain lands. A single append is a race on
    // CI: kqueue arms asynchronously, so an append issued microseconds after
    // start() can land before the watch is live and be missed forever with
    // the safety poll disabled (this test was flaky on macOS runners and
    // blocked a release). Production writes are continuous, so retrying is
    // faithful to the real case — and the assertion still fails if the file
    // watch never fires at all.
    const appender = setInterval(() => {
      try {
        appendFileSync(join(dir, "chat.db-wal"), "-more");
      } catch {
        // dir torn down between ticks — the waitFor below is the real gate
      }
    }, 100);
    try {
      await vi.waitFor(
        () => {
          expect(batches.length).toBeGreaterThanOrEqual(1);
        },
        { timeout: 5_000 },
      );
    } finally {
      clearInterval(appender);
    }
    expect(batches[0]).toHaveLength(1);
    w.stop();
  });

  it("keeps firing after the WAL is truncated and recreated (checkpoint survival)", async () => {
    dir = mkdtempSync(join(tmpdir(), "imsg-cw-ckpt-"));
    const dbPath = join(dir, "chat.db");
    writeFileSync(dbPath, "");
    writeFileSync(join(dir, "chat.db-wal"), "gen1");
    const { db, push } = fakeDb(0);
    const bus = new EventBus();
    const batches: (readonly ChangeEvent[])[] = [];
    bus.subscribe((e) => batches.push(e));

    const w = new ChangeWatcher({ dbPath, db, bus, debounceMs: 40, safetyPollMs: 0 });
    w.start();

    // Simulate a checkpoint: wal deleted and recreated (entry events re-arm
    // the file watch), then a later APPEND must still be seen.
    unlinkSync(join(dir, "chat.db-wal"));
    await new Promise((r) => setTimeout(r, 150));
    writeFileSync(join(dir, "chat.db-wal"), "gen2");
    await new Promise((r) => setTimeout(r, 250));

    push(msg(1));
    appendFileSync(join(dir, "chat.db-wal"), "-post-checkpoint-append");

    await vi.waitFor(
      () => {
        expect(batches.flat().length).toBeGreaterThanOrEqual(1);
      },
      { timeout: 3_000 },
    );
    w.stop();
  });
});
