/**
 * ChangeWatcher — turns chat.db writes into typed EventBus batches.
 *
 * Detection uses THREE layered primitives (the original design's single
 * directory watch was blind in production — see below):
 *
 *  1. A file watch on `chat.db-wal` ITSELF — kqueue on an opened fd, which
 *     delivers write/extend events regardless of which process writes.
 *  2. A directory watch on dirname(dbPath) — re-arms the file watch when a
 *     checkpoint truncates/recreates the wal (stale inode), and is the
 *     drain signal on platforms where it does report file events.
 *  3. A slow safety poll (default 10s; one MAX(ROWID) query per tick) that
 *     always runs alongside the watches.
 *
 * Why not the original directory watch alone: on the REAL
 * `~/Library/Messages` it armed cleanly and then delivered NOTHING while
 * rows landed in chat.db (observed live, 2026-08-10; suspected TCC/FSEvents
 * filtering on the protected directory — plain temp dirs DO report appends,
 * which is why the integration tests couldn't catch it). The file watch and
 * the safety poll are the primitives that don't depend on that delivery.
 *
 * If fs.watch throws outright (exotic filesystems), degrade to the
 * documented fast-poll fallback of the same drain path (default 2s).
 * The authoritative cursor is always a high-water ROWID, never file state.
 *
 * On a signal: debounce ~150ms (one logical message = several WAL writes),
 * then delta-read rows past the high-water mark via
 * `IMessageDB.getMessagesAfterRowid` — the same parse/convert pipeline as
 * every other reader ("one parser, N callers"; no forked streamer parser) —
 * classify, and emit ONE coalesced batch per drain. Bulk syncs loop the
 * delta read in `maxBatch` pages so thousands of rows become a few batches,
 * not a subscriber storm.
 *
 * The watcher never throws into the host process: drain errors are logged
 * and retried on the next event. Timers are unref'd; `stop()` is idempotent
 * and safe to register as a shutdown cleanup (the ENTRY POINT registers it —
 * this module stays side-effect-free at import, like the rest of core).
 */

import { watch } from "node:fs";
import { basename, dirname } from "node:path";
import type { ChangeEvent, EventBus } from "./event-bus.js";
import { info, warn } from "./logger.js";
import type { Message } from "./types.js";

/** The DB surface the watcher needs — injectable for tests. */
export interface ChangeWatcherDb {
  getMaxMessageRowId(): number;
  getMessagesAfterRowid(afterRowid: number, limit?: number): Promise<Message[]>;
}

export interface ChangeWatcherOptions {
  /** Path to chat.db — the watcher watches its parent directory. */
  dbPath: string;
  db: ChangeWatcherDb;
  bus: EventBus;
  /** Trailing-edge debounce between an fs event and the delta read. */
  debounceMs?: number;
  /** Poll cadence for the degenerate no-fs.watch fallback. */
  pollFallbackMs?: number;
  /** Slow backstop poll cadence while fs.watch is armed (0 disables). */
  safetyPollMs?: number;
  /** Rows per delta page; drains loop while a page comes back full. */
  maxBatch?: number;
}

export class ChangeWatcher {
  private readonly dbPath: string;
  private readonly db: ChangeWatcherDb;
  private readonly bus: EventBus;
  private readonly debounceMs: number;
  private readonly pollFallbackMs: number;
  private readonly maxBatch: number;

  private readonly safetyPollMs: number;

  private watcher: ReturnType<typeof watch> | null = null;
  private walWatcher: ReturnType<typeof watch> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private safetyTimer: ReturnType<typeof setInterval> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private highWaterRowid = 0;
  private draining = false;
  private rearm = false;
  private started = false;
  private usingPollFallback = false;

  constructor(opts: ChangeWatcherOptions) {
    this.dbPath = opts.dbPath;
    this.db = opts.db;
    this.bus = opts.bus;
    this.debounceMs = opts.debounceMs ?? 150;
    this.pollFallbackMs = opts.pollFallbackMs ?? 2_000;
    this.safetyPollMs = opts.safetyPollMs ?? 10_000;
    this.maxBatch = opts.maxBatch ?? 500;
  }

  /**
   * Seed the high-water mark from the CURRENT max ROWID (history is the
   * initial-load path's job; the stream carries only what happens next) and
   * arm the directory watch — or the poll fallback if fs.watch throws.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.highWaterRowid = this.db.getMaxMessageRowId();

    const dir = dirname(this.dbPath);
    const dbFile = basename(this.dbPath);
    try {
      this.watcher = watch(dir, (eventType, filename) => {
        // Directory watches only report ENTRY changes (create/rename/delete)
        // on macOS — a checkpoint truncating/recreating the wal lands here.
        // Any wal entry event means the file watch's inode may be stale:
        // re-arm it, then drain. filename can be null on some platforms —
        // treat that as a hit.
        if (filename === null || filename === `${dbFile}-wal` || filename === dbFile) {
          if (eventType === "rename" || this.walWatcher === null) this.armWalWatch();
          this.scheduleDrain();
        }
      });
      // Like the timers, the fs.watch handle must never keep the process
      // alive on its own — entry points arm the watcher lazily inside
      // request handlers, and shutdown() already stops it explicitly.
      this.watcher.unref();
      this.watcher.on("error", (err) => {
        warn("change_watcher_fs_error_falling_back_to_poll", { message: String(err) });
        this.teardownWatch();
        this.armPollFallback();
      });
      this.armWalWatch();
      this.armSafetyPoll();
      info("change_watcher_started", {
        dir,
        high_water_rowid: this.highWaterRowid,
        debounce_ms: this.debounceMs,
        wal_file_watch: this.walWatcher !== null,
        safety_poll_ms: this.safetyPollMs,
      });
    } catch (err) {
      warn("change_watcher_fs_watch_unavailable", { message: String(err) });
      this.armPollFallback();
    }
  }

  /**
   * Watch the WAL file itself — the only fs.watch mode that fires on APPENDS
   * on macOS (kqueue on the file). Best-effort: the wal may not exist yet
   * (fresh db, post-checkpoint gap); the directory watch re-arms us when its
   * entry appears, and the safety poll covers the meantime.
   */
  private armWalWatch(): void {
    if (!this.started) return;
    if (this.walWatcher) {
      this.walWatcher.close();
      this.walWatcher = null;
    }
    try {
      this.walWatcher = watch(`${this.dbPath}-wal`, () => {
        this.scheduleDrain();
      });
      this.walWatcher.unref();
      this.walWatcher.on("error", () => {
        // Stale inode (checkpoint) or vanished file — the dir watch will
        // re-arm on the next wal entry event; don't fall back to full poll.
        if (this.walWatcher) {
          this.walWatcher.close();
          this.walWatcher = null;
        }
      });
    } catch {
      // ENOENT etc. — covered by dir watch + safety poll.
      this.walWatcher = null;
    }
  }

  /** Slow backstop drain while fs.watch is armed — catches silent watches. */
  private armSafetyPoll(): void {
    if (this.safetyTimer || this.safetyPollMs <= 0) return;
    this.safetyTimer = setInterval(() => {
      void this.drain();
    }, this.safetyPollMs);
    this.safetyTimer.unref();
  }

  /** Idempotent teardown — clears the watches, timers, and pending drains. */
  stop(): void {
    this.started = false;
    this.teardownWatch();
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.safetyTimer) {
      clearInterval(this.safetyTimer);
      this.safetyTimer = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  /** Current cursor — exposed for the dev-stats panel and tests. */
  getHighWaterRowid(): number {
    return this.highWaterRowid;
  }

  /** True when running in the degenerate poll mode (fs.watch unavailable). */
  isPolling(): boolean {
    return this.usingPollFallback;
  }

  /**
   * Trigger a delta read now, bypassing the debounce. The poll fallback and
   * tests use this; the fs.watch path goes through `scheduleDrain`.
   */
  async pump(): Promise<void> {
    await this.drain();
  }

  private teardownWatch(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.walWatcher) {
      this.walWatcher.close();
      this.walWatcher = null;
    }
  }

  private armPollFallback(): void {
    if (this.pollTimer || !this.started) return;
    this.usingPollFallback = true;
    this.pollTimer = setInterval(() => {
      void this.drain();
    }, this.pollFallbackMs);
    this.pollTimer.unref();
    info("change_watcher_poll_fallback_armed", { interval_ms: this.pollFallbackMs });
  }

  private scheduleDrain(): void {
    if (!this.started) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.drain();
    }, this.debounceMs);
    this.debounceTimer.unref();
  }

  /**
   * Read rows past the high-water mark and emit them as one batch per page.
   * Re-entrancy guard: fs events landing mid-drain set `rearm` so the drain
   * runs once more instead of overlapping (overlapping reads would emit
   * duplicate rows — both would read from the same stale cursor).
   */
  private async drain(): Promise<void> {
    if (this.draining) {
      this.rearm = true;
      return;
    }
    this.draining = true;
    try {
      // Loop while pages come back full — a bulk sync writes thousands of
      // rows in one burst and each page becomes one coalesced batch.
      for (;;) {
        const messages = await this.db.getMessagesAfterRowid(this.highWaterRowid, this.maxBatch);
        if (messages.length === 0) break;
        for (const m of messages) {
          if (m.id > this.highWaterRowid) this.highWaterRowid = m.id;
        }
        this.bus.emit(messages.map(classify));
        if (messages.length < this.maxBatch) break;
      }
    } catch (err) {
      // Never throw into the host — the next WAL event retries naturally.
      warn("change_watcher_drain_failed", { message: String(err) });
    } finally {
      this.draining = false;
      if (this.rearm) {
        this.rearm = false;
        void this.drain();
      }
    }
  }
}

/**
 * New-ROWID classification. Edited/unsent rows mutate EXISTING ROWIDs and are
 * invisible to the high-water delta — they belong to the mutation-detection
 * backlog item (date_edited / is_read deltas), not this path.
 */
function classify(message: Message): ChangeEvent {
  return message.isReaction ? { type: "reaction", message } : { type: "message.new", message };
}
