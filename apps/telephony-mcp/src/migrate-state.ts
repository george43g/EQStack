/**
 * One-time legacy-state migration: `voice-mcp` dirs → `telephony-mcp` (D-40/D-47).
 *
 * Runs at process startup BEFORE any DB open, from every entry point (cli.ts
 * calls it ahead of command dispatch). Startup-only means it can never fire
 * mid-call; the lock probe means it SKIPS — rather than corrupts — when another
 * process still holds the legacy DB. A dated `cp -a` backup is taken before
 * anything moves. The Keychain recording key does not move: it is keyed on the
 * frozen literal "voice-mcp" (INV-13 / D-24) and is path-independent.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { log } from "./log.js";
import {
  APP_NAME,
  LEGACY_NAME,
  legacyConfigDir,
  legacyStateRoot,
  newConfigDir,
  newStateRoot,
} from "./paths.js";

export interface MigrateResult {
  migrated: boolean;
  /** "done" | "already-migrated" | "no-legacy" | "env-override" | "busy" | "error" */
  reason: string;
}

/** True when the legacy DB can be exclusively locked and its WAL fully checkpointed. */
function checkpointAndProbe(dbFile: string): boolean {
  const db = new DatabaseSync(dbFile);
  try {
    db.exec("BEGIN IMMEDIATE; COMMIT;");
    const row = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number } | undefined;
    return (row?.busy ?? 1) === 0;
  } catch {
    return false;
  } finally {
    db.close();
  }
}

export function migrateLegacyState(home: string = homedir()): MigrateResult {
  if (process.env.TEL_STATE_DIR || process.env.TEL_CONFIG) {
    return { migrated: false, reason: "env-override" };
  }
  const legacyState = legacyStateRoot(home);
  const newState = newStateRoot(home);
  const legacyConfig = legacyConfigDir(home);
  const newConfig = newConfigDir(home);
  const stateNeeded = existsSync(legacyState) && !existsSync(newState);
  const configNeeded = existsSync(legacyConfig) && !existsSync(newConfig);
  if (!stateNeeded && !configNeeded) {
    return {
      migrated: false,
      reason: existsSync(newState) || existsSync(newConfig) ? "already-migrated" : "no-legacy",
    };
  }

  try {
    if (stateNeeded) {
      const legacyDb = join(legacyState, `${LEGACY_NAME}.sqlite3`);
      if (existsSync(legacyDb) && !checkpointAndProbe(legacyDb)) {
        log("warn", "state_migration_deferred", {
          reason: "another process holds the legacy DB — stop it and rerun",
          legacyState,
        });
        return { migrated: false, reason: "busy" };
      }
      const stamp = new Date().toISOString().slice(0, 10);
      const backup = `${legacyState}-backup-${stamp}`;
      if (!existsSync(backup)) execFileSync("/bin/cp", ["-a", legacyState, backup]);
      renameSync(legacyState, newState);
      if (existsSync(join(newState, `${LEGACY_NAME}.sqlite3`))) {
        renameSync(join(newState, `${LEGACY_NAME}.sqlite3`), join(newState, `${APP_NAME}.sqlite3`));
        // Post-checkpoint the sidecars are stale; a moved -wal beside a renamed
        // main DB is a corruption vector. Delete, never rename, them.
        for (const suffix of ["-shm", "-wal"]) {
          rmSync(join(newState, `${LEGACY_NAME}.sqlite3${suffix}`), { force: true });
        }
      }
      chmodSync(newState, 0o700);
      if (existsSync(join(newState, "recordings"))) chmodSync(join(newState, "recordings"), 0o700);
      log("info", "state_migrated", { from: legacyState, to: newState, backup });
    }
    if (configNeeded) {
      renameSync(legacyConfig, newConfig);
      log("info", "config_migrated", { from: legacyConfig, to: newConfig });
    }
    return { migrated: true, reason: "done" };
  } catch (err) {
    log("error", "state_migration_failed", { error: (err as Error).message });
    return { migrated: false, reason: "error" };
  }
}
