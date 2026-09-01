/**
 * Filesystem layout.
 *
 *  config  ~/.config/telephony-mcp/config.json        (human-edited; TEL_CONFIG overrides)
 *  state   ~/Library/Application Support/telephony-mcp (machine state, 0700;
 *          TEL_STATE_DIR overrides — tests point this at a temp dir)
 *
 * Back-compat (one release, D-40): when the new location is absent and the
 * legacy `voice-mcp` one exists — i.e. the D-47 migration was skipped, e.g.
 * because another process still held the DB — resolution falls back to the
 * legacy paths so existing state stays visible rather than silently empty.
 */
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const LEGACY_NAME = "voice-mcp";
export const APP_NAME = "telephony-mcp";

export function legacyConfigDir(home: string = homedir()): string {
  return join(home, ".config", LEGACY_NAME);
}

export function newConfigDir(home: string = homedir()): string {
  return join(home, ".config", APP_NAME);
}

export function legacyStateRoot(home: string = homedir()): string {
  return join(home, "Library", "Application Support", LEGACY_NAME);
}

export function newStateRoot(home: string = homedir()): string {
  return join(home, "Library", "Application Support", APP_NAME);
}

export function configPath(): string {
  if (process.env.TEL_CONFIG) return process.env.TEL_CONFIG;
  const preferred = join(newConfigDir(), "config.json");
  const legacy = join(legacyConfigDir(), "config.json");
  return !existsSync(preferred) && existsSync(legacy) ? legacy : preferred;
}

export function stateDir(): string {
  if (process.env.TEL_STATE_DIR) return process.env.TEL_STATE_DIR;
  const preferred = newStateRoot();
  const legacy = legacyStateRoot();
  return !existsSync(preferred) && existsSync(legacy) ? legacy : preferred;
}

/** Create the state layout with restrictive permissions; returns the root. */
export function ensureStateDir(): string {
  const root = stateDir();
  for (const dir of [root, join(root, "recordings")]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }
  return root;
}

export function dbPath(): string {
  const root = stateDir();
  // The legacy tree keeps its legacy filename until the migration renames both.
  const name = root === legacyStateRoot() ? `${LEGACY_NAME}.sqlite3` : `${APP_NAME}.sqlite3`;
  return join(root, name);
}

export function recordingsDir(): string {
  return join(stateDir(), "recordings");
}
