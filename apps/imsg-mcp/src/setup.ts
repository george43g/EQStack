/**
 * `imsg setup` engine — autodetects DB paths on this machine and
 * emits a ready-to-paste MCP server configuration snippet.
 *
 * Behaviour:
 *   - Probe ~/Library/Messages/chat.db
 *   - Probe ~/Library/Application Support/AddressBook/AddressBook-v22.abcddb
 *   - Try a tiny read on each (verifies Full Disk Access)
 *   - Build the JSON snippet — env block is OMITTED if every probed path
 *     matches the built-in default (the common case → minimal snippet).
 *   - With --write claude/cursor, merge the snippet into the host's
 *     config file (creating a `.bak` first).
 *
 * The default snippet is the npx form. If the user wants `bunx`, they
 * can pass --runtime=bunx; if they want a global install, `--runtime=global`
 * emits the bin command directly.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { getContactsDbPaths, getImsgDbPath, getSlugsDbPath } from "./config.js";
import Database from "./sqlite.js";

// ── Probing ───────────────────────────────────────────────────────────────

export interface PathProbeResult {
  /** Resolved absolute path that the MCP server would use today. */
  path: string;
  /** File exists on disk. */
  exists: boolean;
  /** A trivial read query succeeded (verifies Full Disk Access for the running process). */
  readable: boolean;
  /** Human-readable error message if `readable` is false. */
  error?: string;
}

function probeSqlite(path: string): PathProbeResult {
  if (!existsSync(path)) {
    return { path, exists: false, readable: false, error: "file does not exist" };
  }
  try {
    const db = new Database(path, { readonly: true, fileMustExist: true });
    // tiny read; sqlite_master is always present
    db.prepare("SELECT 1 FROM sqlite_master LIMIT 1").get();
    db.close();
    return { path, exists: true, readable: true };
  } catch (err) {
    return {
      path,
      exists: true,
      readable: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface SetupReport {
  imsgDb: PathProbeResult;
  contactsDbs: PathProbeResult[];
  slugsDb: { path: string; exists: boolean }; // slugs.db is created on-demand; no read probe
  /** True when every probed file is readable. */
  fullDiskAccess: boolean;
  /** True if any non-default path was used (env override OR contacts had multi-source). */
  needsEnvOverrides: boolean;
}

export function probeMachine(): SetupReport {
  const imsgDb = probeSqlite(getImsgDbPath());
  const contacts = getContactsDbPaths() ?? [];
  const contactsDbs = contacts.map(probeSqlite);
  const slugsDb = (() => {
    const p = getSlugsDbPath();
    return { path: p, exists: existsSync(p) };
  })();
  const fullDiskAccess = imsgDb.readable && contactsDbs.every((p) => p.readable || !p.exists);

  const needsEnvOverrides = Boolean(
    process.env.VITE_IMSG_DB_PATH ||
      process.env.VITE_CONTACTS_DB_PATH ||
      process.env.VITE_ADDRESS_BOOK_UUID ||
      process.env.VITE_SLUGS_DB_PATH,
  );

  return { imsgDb, contactsDbs, slugsDb, fullDiskAccess, needsEnvOverrides };
}

// ── Snippet generation ────────────────────────────────────────────────────

export type Runtime = "npx" | "bunx" | "global";

export interface SnippetOptions {
  runtime?: Runtime;
  /** Force the env block to include these keys regardless of probe results. */
  forceEnv?: Record<string, string>;
}

export function buildMcpServerEntry(
  _report: SetupReport,
  opts: SnippetOptions = {},
): { command: string; args: string[]; env?: Record<string, string> } {
  const runtime = opts.runtime ?? "npx";
  const command = runtime === "global" ? "imsg" : runtime === "bunx" ? "bunx" : "npx";
  const args =
    runtime === "global"
      ? ["mcp"]
      : runtime === "bunx"
        ? ["imsg-mcp", "mcp"]
        : ["-y", "imsg-mcp", "mcp"];

  // Only emit env entries when the user's resolved path differs from the
  // built-in default. The probe already used those defaults, so we just
  // pass through any explicit env overrides currently set.
  const env: Record<string, string> = {};
  for (const k of [
    "VITE_IMSG_DB_PATH",
    "VITE_CONTACTS_DB_PATH",
    "VITE_ADDRESS_BOOK_UUID",
    "VITE_SLUGS_DB_PATH",
  ] as const) {
    if (process.env[k]) env[k] = process.env[k] as string;
  }
  if (opts.forceEnv) Object.assign(env, opts.forceEnv);

  // Suppress empty env blocks so the snippet stays minimal.
  if (Object.keys(env).length === 0) {
    return { command, args };
  }
  return { command, args, env };
}

export function buildMcpSnippet(report: SetupReport, opts: SnippetOptions = {}): string {
  const entry = buildMcpServerEntry(report, opts);
  const snippet = {
    mcpServers: {
      imessage: entry,
    },
  };
  return `${JSON.stringify(snippet, null, 2)}\n`;
}

// ── Host config writers ──────────────────────────────────────────────────

export type Host = "claude" | "cursor";

export function getHostConfigPath(host: Host): string {
  const home = process.env.HOME ?? "";
  switch (host) {
    case "claude":
      // Claude Desktop on macOS
      return `${home}/Library/Application Support/Claude/claude_desktop_config.json`;
    case "cursor":
      return `${home}/.cursor/mcp.json`;
  }
}

/**
 * Merge our `mcpServers.imessage` entry into the host's config file.
 * Creates the file (and parent directories) if missing. Writes a `.bak`
 * of any existing file before overwriting.
 *
 * Returns the path written and a `replaced: true` flag if an existing
 * `imessage` entry was overwritten (so the caller can warn the user).
 */
export function writeHostConfig(
  host: Host,
  report: SetupReport,
  opts: SnippetOptions = {},
): { path: string; replaced: boolean } {
  const path = getHostConfigPath(host);
  const dir = path.substring(0, path.lastIndexOf("/"));
  mkdirSync(dir, { recursive: true });

  let existing: Record<string, unknown> = {};
  let replaced = false;
  if (existsSync(path)) {
    copyFileSync(path, `${path}.bak`);
    try {
      existing = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      // Corrupt or empty file — start fresh; the .bak preserves the original.
      existing = {};
    }
  }

  const servers = ((existing as { mcpServers?: Record<string, unknown> }).mcpServers ??
    {}) as Record<string, unknown>;
  if (servers.imessage) replaced = true;
  servers.imessage = buildMcpServerEntry(report, opts);
  (existing as { mcpServers: Record<string, unknown> }).mcpServers = servers;

  writeFileSync(path, `${JSON.stringify(existing, null, 2)}\n`);
  return { path, replaced };
}
