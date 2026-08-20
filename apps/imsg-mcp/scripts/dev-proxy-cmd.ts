/**
 * Default child command for mcp-dev-proxy.
 *
 * INVARIANT: never spawn a signalled child through the tsx CLI
 * (`node_modules/.bin/tsx`). The tsx CLI runs your code in a GRANDCHILD and
 * relays signals to it with a 30ms IPC-ack window; if the grandchild's event
 * loop is busy at signal time (routine during shutdown — SQLite close, cache
 * teardown), tsx escalates to an untrappable SIGKILL ~60ms in. That truncates
 * the graceful shutdown and leaves no `shutdown` marker in the NDJSON log,
 * which our crash heuristic then reads as a crash. `node --import <tsx>` runs
 * ONE process: the loader is in-process and signals reach the server directly.
 * (Mechanism verified upstream in tsx 4.23.1 `relaySignalToChild`;
 * mcp-cli-starter-template#64.)
 */
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

/** file:// URL of tsx's `--import` entry, resolved from THIS file's location
 *  (not cwd) so the default works no matter where the host spawns the proxy. */
export function tsxLoaderHref(): string {
  return pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
}

/** Absolute path of the dev server entry (src/cli.ts), cwd-independent. */
export function devCliPath(): string {
  return fileURLToPath(new URL("../src/cli.ts", import.meta.url));
}

/** The full default MCP_DEV_CMD: one node process, tsx as an in-process
 *  loader. Word-split by the shell at spawn time, so every segment must be
 *  space-free (node path, file URL, and repo path all are). */
export function buildDefaultDevCmd(): string {
  return `${process.execPath} --import ${tsxLoaderHref()} ${devCliPath()} mcp`;
}
