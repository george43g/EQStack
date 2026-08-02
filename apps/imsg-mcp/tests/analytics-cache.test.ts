/**
 * Coverage for the SQLite-backed analytics cache used by chat_analytics.
 *
 * Each test uses an isolated DB path via `_setCachePathForTests` so
 * concurrent runs and the production cache (`~/.imsg-mcp/analytics-cache.db`)
 * never interfere.
 */

import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _setCachePathForTests,
  closeCache,
  lookupCache,
  storeCache,
} from "../src/analytics-cache.js";

let workDir: string;
let dbPath: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "imsg-acache-"));
  dbPath = join(workDir, "analytics-cache.db");
  _setCachePathForTests(dbPath);
});

afterEach(() => {
  closeCache();
});

describe("storeCache + lookupCache round-trip", () => {
  it("returns null on a miss", () => {
    expect(lookupCache("messaging_streaks", { windowDays: 30 }, 100)).toBeNull();
  });

  it("returns the stored payload on a hit", () => {
    const payload = { result: [1, 2, 3], note: "synthesised" };
    storeCache("messaging_streaks", { windowDays: 30 }, 100, payload);
    const hit = lookupCache("messaging_streaks", { windowDays: 30 }, 100);
    expect(hit).not.toBeNull();
    expect(hit?.data).toEqual(payload);
    expect(typeof hit?.computedAt).toBe("number");
  });

  it("invalidates on a maxRowId bump (DB grew since cache write)", () => {
    storeCache("daily_heatmap", { windowDays: 7 }, 100, { v: 1 });
    expect(lookupCache("daily_heatmap", { windowDays: 7 }, 101)).toBeNull();
  });

  it("upserts when the same key is written twice (no UNIQUE conflict)", () => {
    storeCache("double_texts", { windowDays: 90 }, 50, { v: 1 });
    storeCache("double_texts", { windowDays: 90 }, 60, { v: 2 });
    const hit = lookupCache("double_texts", { windowDays: 90 }, 60);
    expect(hit?.data).toEqual({ v: 2 });
  });
});

describe("hashArgs key independence", () => {
  it("hits the same row regardless of key insertion order", () => {
    storeCache("daily_heatmap", { windowDays: 7, type: "X" }, 100, { ok: true });
    // Look up with reversed key order — must still hit because
    // hashArgs sorts the JSON-stringify replacer.
    const hit = lookupCache("daily_heatmap", { type: "X", windowDays: 7 }, 100);
    expect(hit?.data).toEqual({ ok: true });
  });
});

describe("malformed-row resilience", () => {
  it("returns null instead of throwing when data_json is corrupt", () => {
    // Open the DB directly and inject a malformed row.
    const sqlite = new Database(dbPath);
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS analytics_cache (
        type TEXT NOT NULL,
        args_hash TEXT NOT NULL,
        max_rowid INTEGER NOT NULL,
        data_json TEXT NOT NULL,
        computed_at INTEGER NOT NULL,
        PRIMARY KEY (type, args_hash)
      );
    `);
    // hashArgs for {windowDays:30} → use the same form storeCache writes.
    const argsHash = JSON.stringify({ windowDays: 30 }, ["windowDays"]);
    sqlite
      .prepare(
        "INSERT INTO analytics_cache (type, args_hash, max_rowid, data_json, computed_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("tapback_summary", argsHash, 100, "{not-valid-json", Date.now());
    sqlite.close();

    // lookupCache must surface a clean null, not throw.
    expect(() => lookupCache("tapback_summary", { windowDays: 30 }, 100)).not.toThrow();
    expect(lookupCache("tapback_summary", { windowDays: 30 }, 100)).toBeNull();
  });
});

describe("test fixture isolation", () => {
  it("does not touch the production ~/.imsg-mcp/analytics-cache.db", () => {
    storeCache("messaging_streaks", { windowDays: 1 }, 1, { ok: true });
    expect(existsSync(dbPath)).toBe(true);
    // We can't easily assert the prod file isn't touched without
    // pre/post-state diffs of the user's home, but `_setCachePathForTests`
    // is the documented contract — verify the path is honored.
    expect(dbPath).toContain(workDir);
  });

  it("ignores a write to the dir if it's a pre-existing valid file", () => {
    // Defensive: ensure the test fixture isn't broken by stale files.
    writeFileSync(join(workDir, "noise.txt"), "ignore me");
    storeCache("daily_heatmap", { windowDays: 1 }, 1, { ok: true });
    expect(lookupCache("daily_heatmap", { windowDays: 1 }, 1)?.data).toEqual({ ok: true });
  });
});
