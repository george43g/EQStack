/**
 * Filesystem layout.
 *
 *  config  ~/.config/voice-mcp/config.json        (human-edited; TEL_CONFIG overrides)
 *  state   ~/Library/Application Support/voice-mcp (machine state, 0700;
 *          TEL_STATE_DIR overrides — tests point this at a temp dir)
 */
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function configPath(): string {
  return process.env.TEL_CONFIG ?? join(homedir(), ".config", "voice-mcp", "config.json");
}

export function stateDir(): string {
  return (
    process.env.TEL_STATE_DIR ?? join(homedir(), "Library", "Application Support", "voice-mcp")
  );
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
  return join(stateDir(), "voice-mcp.sqlite3");
}

export function recordingsDir(): string {
  return join(stateDir(), "recordings");
}
