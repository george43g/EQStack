import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateLegacyState } from "./migrate-state.js";
import { legacyConfigDir, legacyStateRoot, newConfigDir, newStateRoot } from "./paths.js";

let home: string;
let savedStateDir: string | undefined;
let savedConfig: string | undefined;

function seedLegacy(opts: { config?: boolean; db?: boolean } = {}): void {
  const state = legacyStateRoot(home);
  mkdirSync(join(state, "recordings"), { recursive: true, mode: 0o700 });
  writeFileSync(join(state, "recordings", "RE123.enc"), Buffer.from("VMC1fake"));
  if (opts.db !== false) {
    const db = new DatabaseSync(join(state, "voice-mcp.sqlite3"));
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE t(v TEXT); INSERT INTO t VALUES('kept');");
    db.close();
  }
  if (opts.config !== false) {
    mkdirSync(legacyConfigDir(home), { recursive: true });
    writeFileSync(join(legacyConfigDir(home), "config.json"), '{"a":1}');
  }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tel-migrate-"));
  savedStateDir = process.env.TEL_STATE_DIR;
  savedConfig = process.env.TEL_CONFIG;
  delete process.env.TEL_STATE_DIR;
  delete process.env.TEL_CONFIG;
});

afterEach(() => {
  if (savedStateDir !== undefined) process.env.TEL_STATE_DIR = savedStateDir;
  if (savedConfig !== undefined) process.env.TEL_CONFIG = savedConfig;
  rmSync(home, { recursive: true, force: true });
});

describe("migrateLegacyState", () => {
  it("moves state + config, renames the DB, drops sidecars, leaves a backup", () => {
    seedLegacy();
    const res = migrateLegacyState(home);
    expect(res).toEqual({ migrated: true, reason: "done" });

    const state = newStateRoot(home);
    expect(existsSync(join(state, "telephony-mcp.sqlite3"))).toBe(true);
    expect(existsSync(join(state, "voice-mcp.sqlite3"))).toBe(false);
    expect(existsSync(join(state, "voice-mcp.sqlite3-wal"))).toBe(false);
    expect(existsSync(join(state, "voice-mcp.sqlite3-shm"))).toBe(false);
    expect(existsSync(join(state, "recordings", "RE123.enc"))).toBe(true);
    expect(existsSync(legacyStateRoot(home))).toBe(false);

    const db = new DatabaseSync(join(state, "telephony-mcp.sqlite3"));
    expect((db.prepare("SELECT v FROM t").get() as { v: string }).v).toBe("kept");
    db.close();

    expect(readFileSync(join(newConfigDir(home), "config.json"), "utf8")).toBe('{"a":1}');
    expect(existsSync(legacyConfigDir(home))).toBe(false);

    const backups = execFileSync("ls", [join(home, "Library", "Application Support")])
      .toString()
      .split("\n")
      .filter((n) => n.startsWith("voice-mcp-backup-"));
    expect(backups).toHaveLength(1);
    const backup = join(home, "Library", "Application Support", backups[0] as string);
    expect(existsSync(join(backup, "voice-mcp.sqlite3"))).toBe(true);
    expect(existsSync(join(backup, "recordings", "RE123.enc"))).toBe(true);
  });

  it("is a no-op when the new location already exists", () => {
    seedLegacy();
    mkdirSync(newStateRoot(home), { recursive: true });
    mkdirSync(newConfigDir(home), { recursive: true });
    const res = migrateLegacyState(home);
    expect(res).toEqual({ migrated: false, reason: "already-migrated" });
    expect(existsSync(join(legacyStateRoot(home), "voice-mcp.sqlite3"))).toBe(true);
  });

  it("is a no-op when nothing legacy exists", () => {
    expect(migrateLegacyState(home)).toEqual({ migrated: false, reason: "no-legacy" });
  });

  it("skips under an env override (tests, explicit redirection)", () => {
    seedLegacy();
    process.env.TEL_STATE_DIR = join(home, "elsewhere");
    expect(migrateLegacyState(home)).toEqual({ migrated: false, reason: "env-override" });
    expect(existsSync(legacyStateRoot(home))).toBe(true);
  });

  it("defers instead of corrupting while another connection holds the DB", () => {
    seedLegacy({ config: false });
    const holder = new DatabaseSync(join(legacyStateRoot(home), "voice-mcp.sqlite3"));
    holder.exec("BEGIN IMMEDIATE");
    try {
      const res = migrateLegacyState(home);
      expect(res).toEqual({ migrated: false, reason: "busy" });
      expect(existsSync(join(legacyStateRoot(home), "voice-mcp.sqlite3"))).toBe(true);
      expect(existsSync(newStateRoot(home))).toBe(false);
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
  });
});
