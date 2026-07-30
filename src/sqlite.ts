/**
 * SQLite engine resolver with graceful fallback — mirrors the Rust/TS
 * native-bridge pattern, applied to the SQLite binding.
 *
 * Resolution order (lazy, on first `new Database(...)`):
 *   1. **better-sqlite3** — fastest. Used automatically wherever its bundled
 *      native binary matches the runtime ABI (e.g. the CLI/TUI running on the
 *      user's mainline Node).
 *   2. **node:sqlite** — Node's built-in synchronous SQLite (`DatabaseSync`).
 *      Native C SQLite (within ~8% of better-sqlite3), but part of the runtime,
 *      so it is ABI-independent and needs no prebuilt binary or compilation.
 *      This is what runs inside Claude Desktop's Electron, whose bleeding-edge
 *      ABI has no better-sqlite3 prebuild.
 *
 * There is deliberately **no runtime compilation and no bundled toolchain** —
 * those cannot ship to arbitrary user machines (licensing, size, missing
 * compilers). node:sqlite gives the "always works" fallback for free.
 *
 * The node:sqlite adapter reproduces the small slice of the better-sqlite3
 * surface this codebase uses: `prepare/all/get/run`, `exec`, `close`,
 * `transaction`, the `{ readonly, fileMustExist }` constructor options, named
 * (`@name`) params, and BigInt→Number normalization so large integers
 * (iMessage nanosecond dates, ROWIDs) behave exactly as under better-sqlite3.
 *
 * Force the fallback for testing with `IMSG_FORCE_NODE_SQLITE=1`.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import type BetterSqlite3 from "better-sqlite3";
import { info, warn } from "./logger.js";

const require = createRequire(import.meta.url);

/** The instance type consumers annotate with (was `Database.Database`). */
export type SqliteDatabase = BetterSqlite3.Database;
export type SqliteStatement = BetterSqlite3.Statement;
export type SqliteOptions = BetterSqlite3.Options;

/** Constructor shape of the default export — matches `new Database(path, opts)`. */
export interface SqliteConstructor {
  new (filename: string, options?: SqliteOptions): SqliteDatabase;
}

/** Which engine ended up being used (for diagnostics / dev stats). */
export type SqliteEngine = "better-sqlite3" | "node:sqlite";
let _resolvedEngine: SqliteEngine | null = null;
export function activeSqliteEngine(): SqliteEngine | null {
  return _resolvedEngine;
}

// ── node:sqlite minimal typings (avoid depending on @types/node version) ──
interface NodeStatementSync {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  setReadBigInts(enabled: boolean): void;
  setAllowUnknownNamedParameters(enabled: boolean): void;
}
interface NodeDatabaseSync {
  prepare(sql: string): NodeStatementSync;
  exec(sql: string): void;
  close(): void;
}
interface NodeDatabaseSyncCtor {
  new (path: string, options?: { readOnly?: boolean; open?: boolean }): NodeDatabaseSync;
}

/** Normalize a single cell to match better-sqlite3's output types:
 *  - BigInt → Number (better-sqlite3's lossy default for large ints)
 *  - Uint8Array BLOB → Buffer (node:sqlite yields Uint8Array; the typedstream /
 *    attributedBody parsers rely on Buffer methods) */
function normalizeValue(v: unknown): unknown {
  if (typeof v === "bigint") return Number(v);
  if (v instanceof Uint8Array && !Buffer.isBuffer(v)) return Buffer.from(v);
  return v;
}

/** Convert a node:sqlite row (null-prototype) to a plain object with
 *  better-sqlite3-compatible value types. */
function normalizeRow(row: unknown): unknown {
  if (row == null || typeof row !== "object") return row;
  const out: Record<string, unknown> = {};
  for (const k in row as Record<string, unknown>) {
    out[k] = normalizeValue((row as Record<string, unknown>)[k]);
  }
  return out;
}

class NodeSqliteStatement {
  private raw: NodeStatementSync;
  constructor(raw: NodeStatementSync) {
    this.raw = raw;
    // Read large integers as BigInt so values > 2^53 don't throw; we convert
    // back to Number below to match better-sqlite3's (lossy) default.
    this.raw.setReadBigInts(true);
    // better-sqlite3 binds only the named params a statement references and
    // ignores extra keys on the params object; node:sqlite errors on unknown
    // keys unless this is enabled. (slug-store reuses one params object across
    // two statements with different param sets.)
    this.raw.setAllowUnknownNamedParameters(true);
  }
  all(...params: unknown[]): unknown[] {
    return this.raw.all(...params).map(normalizeRow);
  }
  get(...params: unknown[]): unknown {
    const r = this.raw.get(...params);
    return r == null ? undefined : normalizeRow(r);
  }
  run(...params: unknown[]): { changes: number; lastInsertRowid: number } {
    const info = this.raw.run(...params);
    return { changes: Number(info.changes), lastInsertRowid: Number(info.lastInsertRowid) };
  }
}

class NodeSqliteDatabase {
  private raw: NodeDatabaseSync;
  private txDepth = 0;
  constructor(filename: string, options?: SqliteOptions) {
    const readOnly = options?.readonly === true;
    if (options?.fileMustExist && !existsSync(filename)) {
      throw new Error(`unable to open database file: ${filename}`);
    }
    const Ctor = require("node:sqlite").DatabaseSync as NodeDatabaseSyncCtor;
    this.raw = new Ctor(filename, { readOnly });
    // better-sqlite3 defaults busy_timeout to 5000ms; node:sqlite defaults to 0
    // (fail immediately on a locked DB). Match it so concurrent access waits
    // instead of erroring — matters under WAL + multiple readers.
    try {
      this.raw.exec("PRAGMA busy_timeout = 5000");
    } catch {
      // Some read-only opens may reject; the default (0) still works.
    }
  }
  prepare(sql: string): NodeSqliteStatement {
    return new NodeSqliteStatement(this.raw.prepare(sql));
  }
  exec(sql: string): void {
    this.raw.exec(sql);
  }
  // better-sqlite3-compatible `.pragma()`. `{ simple: true }` returns the first
  // column of the first row (scalar); otherwise an array of row objects. Handles
  // both reads (`user_version`) and assignments (`journal_mode = WAL`).
  pragma(source: string, options?: { simple?: boolean }): unknown {
    const stmt = this.raw.prepare(`PRAGMA ${source}`);
    stmt.setReadBigInts(true);
    const rows = stmt.all().map(normalizeRow) as Array<Record<string, unknown>>;
    if (options?.simple) {
      const first = rows[0];
      if (first == null) return undefined;
      const keys = Object.keys(first);
      return keys.length ? first[keys[0]] : undefined;
    }
    return rows;
  }
  close(): void {
    this.raw.close();
  }
  // better-sqlite3-compatible: returns a function that runs `fn` inside a
  // transaction (ROLLBACK on throw), forwarding any arguments. Nested calls use
  // SAVEPOINTs so a transaction can call another transaction (e.g. upsertMany →
  // upsert), matching better-sqlite3.
  transaction<F extends (...args: never[]) => unknown>(fn: F): F {
    const wrapped = (...args: never[]): unknown => {
      const depth = this.txDepth;
      const nested = depth > 0;
      const sp = `imsg_sp_${depth}`;
      this.raw.exec(nested ? `SAVEPOINT ${sp}` : "BEGIN");
      this.txDepth = depth + 1;
      try {
        const result = fn(...args);
        this.raw.exec(nested ? `RELEASE ${sp}` : "COMMIT");
        return result;
      } catch (err) {
        try {
          if (nested) {
            this.raw.exec(`ROLLBACK TO ${sp}`);
            this.raw.exec(`RELEASE ${sp}`);
          } else {
            this.raw.exec("ROLLBACK");
          }
        } catch {
          // ignore rollback failure; surface the original error
        }
        throw err;
      } finally {
        this.txDepth = depth;
      }
    };
    return wrapped as F;
  }
}

function loadBetterSqlite3(): SqliteConstructor | null {
  if (process.env.IMSG_FORCE_NODE_SQLITE === "1") return null;
  try {
    const Ctor = require("better-sqlite3") as SqliteConstructor;
    // better-sqlite3's JS entry require()s successfully even when its native
    // binding is ABI-incompatible — the `.node` is only dlopen()'d when a
    // Database is CONSTRUCTED. So probe by opening an in-memory DB here; an ABI
    // mismatch (e.g. Electron's abi 146 vs a node-abi-137 prebuild) throws now
    // and we fall back, instead of committing to better-sqlite3 and crashing on
    // the first real query.
    new Ctor(":memory:").close();
    return Ctor;
  } catch (err) {
    // Native binding missing or ABI-mismatched (e.g. Electron host) — fall back.
    warn("sqlite_engine_fallback", {
      to: "node:sqlite",
      reason: err instanceof Error ? err.message.split("\n")[0] : String(err),
    });
    return null;
  }
}

let _engine: SqliteConstructor | null = null;
function resolveEngine(): SqliteConstructor {
  if (_engine) return _engine;
  const better = loadBetterSqlite3();
  if (better) {
    _engine = better;
    _resolvedEngine = "better-sqlite3";
  } else {
    _engine = NodeSqliteDatabase as unknown as SqliteConstructor;
    _resolvedEngine = "node:sqlite";
  }
  info("sqlite_engine", { engine: _resolvedEngine });
  return _engine;
}

// Default export: a lazy constructor. Resolving on first construction (not at
// import) means the engine-selection log lands after the MCP entrypoint has
// enabled stderr mirroring, so the choice is visible in the host log.
function Database(this: unknown, filename: string, options?: SqliteOptions): SqliteDatabase {
  return new (resolveEngine())(filename, options);
}

export default Database as unknown as SqliteConstructor;
