/**
 * SQLite-backed permanent cache for media interpretation results, so the same
 * attachment is never transcribed / described twice (paid calls especially).
 *
 * Key: a stable per-attachment id (its `guid`, or `att:<rowId>` fallback).
 * `file_sig` (size:mtime) invalidates a row if the underlying file changes
 * (e.g. re-downloaded at higher quality). No TTL — interpretation of a fixed
 * file is stable forever; `retry()` is the only eviction.
 *
 * Path: ~/.imsg-mcp/media-intel.db. Standalone from the main chat.db. Mirrors
 * the analytics-cache module shape.
 */
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import Database, { type SqliteDatabase } from "./sqlite.js";

export type MediaKind = "audio" | "image" | "video";

export interface MediaIntelRecord {
  /** Stable attachment key (guid, or `att:<rowId>`). */
  key: string;
  kind: MediaKind;
  status: "done" | "failed";
  /** Primary text: transcript (audio) or caption/description (image/video). */
  text: string | null;
  /** Structured extras, e.g. `{ description, transcript }` for video. */
  extra: Record<string, unknown> | null;
  /** Where it came from: "apple" | "local:yap" | "provider:openrouter". */
  source: string;
  model: string | null;
  /** `size:mtimeMs` of the on-disk file at interpretation time. */
  fileSig: string;
  durMs: number;
  error: string | null;
  createdAt: number;
}

let dbPath = join(homedir(), ".imsg-mcp", "media-intel.db");
let db: SqliteDatabase | null = null;

function open(): SqliteDatabase {
  if (db) return db;
  const dir = dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS media_intel (
      key TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      text TEXT,
      extra_json TEXT,
      source TEXT NOT NULL,
      model TEXT,
      file_sig TEXT NOT NULL,
      dur_ms INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at INTEGER NOT NULL
    );
  `);
  return db;
}

/** Override path (tests). */
export function _setMediaIntelCachePathForTests(path: string): void {
  if (db) {
    db.close();
    db = null;
  }
  dbPath = path;
}

/** Compute a file signature (`size:mtimeMs`) for cache invalidation. */
export function fileSignature(size: number, mtimeMs: number): string {
  return `${size}:${Math.floor(mtimeMs)}`;
}

/**
 * Look up a cached interpretation. A row whose `file_sig` no longer matches the
 * current file is treated as a miss (returns null) — the file changed under it.
 * Failed rows ARE returned (so callers can show "failed — retry" without
 * re-hitting a provider) unless `includeFailed` is false.
 */
export function lookupMediaIntel(
  key: string,
  fileSig: string,
  opts: { includeFailed?: boolean } = {},
): MediaIntelRecord | null {
  const conn = open();
  const row = conn.prepare(`SELECT * FROM media_intel WHERE key = ?`).get(key) as
    | {
        key: string;
        kind: MediaKind;
        status: "done" | "failed";
        text: string | null;
        extra_json: string | null;
        source: string;
        model: string | null;
        file_sig: string;
        dur_ms: number;
        error: string | null;
        created_at: number;
      }
    | undefined;
  if (!row) return null;
  if (row.file_sig !== fileSig) return null;
  if (row.status === "failed" && opts.includeFailed === false) return null;
  let extra: Record<string, unknown> | null = null;
  if (row.extra_json) {
    try {
      extra = JSON.parse(row.extra_json);
    } catch {
      extra = null;
    }
  }
  return {
    key: row.key,
    kind: row.kind,
    status: row.status,
    text: row.text,
    extra,
    source: row.source,
    model: row.model,
    fileSig: row.file_sig,
    durMs: row.dur_ms,
    error: row.error,
    createdAt: row.created_at,
  };
}

export function storeMediaIntel(rec: MediaIntelRecord): void {
  const conn = open();
  conn
    .prepare(
      `INSERT INTO media_intel (key, kind, status, text, extra_json, source, model, file_sig, dur_ms, error, created_at)
       VALUES (@key, @kind, @status, @text, @extra_json, @source, @model, @fileSig, @durMs, @error, @createdAt)
       ON CONFLICT(key) DO UPDATE SET
         kind = excluded.kind, status = excluded.status, text = excluded.text,
         extra_json = excluded.extra_json, source = excluded.source, model = excluded.model,
         file_sig = excluded.file_sig, dur_ms = excluded.dur_ms, error = excluded.error,
         created_at = excluded.created_at`,
    )
    .run({
      key: rec.key,
      kind: rec.kind,
      status: rec.status,
      text: rec.text,
      extra_json: rec.extra ? JSON.stringify(rec.extra) : null,
      source: rec.source,
      model: rec.model,
      fileSig: rec.fileSig,
      durMs: rec.durMs,
      error: rec.error,
      createdAt: rec.createdAt,
    });
}

/** Evict one entry (for `retry`). */
export function deleteMediaIntel(key: string): void {
  open().prepare(`DELETE FROM media_intel WHERE key = ?`).run(key);
}

/** How many of `keys` already have a successful (`done`) cached result. */
export function countCachedDone(keys: string[]): number {
  if (keys.length === 0) return 0;
  const conn = open();
  let n = 0;
  const stmt = conn.prepare(`SELECT status FROM media_intel WHERE key = ?`);
  for (const k of keys) {
    const row = stmt.get(k) as { status: string } | undefined;
    if (row?.status === "done") n++;
  }
  return n;
}

export function closeMediaIntelCache(): void {
  if (db) {
    db.close();
    db = null;
  }
}
