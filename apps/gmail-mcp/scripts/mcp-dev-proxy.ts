#!/usr/bin/env node
/**
 * MCP Dev Proxy — persistent stdio proxy for MCP server development.
 *
 * Stays alive across child restarts. Buffers stdin from the host (Cursor/Claude/Warp)
 * during restart windows so requests aren't dropped. Watches source files and
 * triggers a restart when any .ts file under MCP_DEV_WATCH_DIR changes.
 *
 * On restart it replays the captured `initialize` request + `notifications/initialized`
 * to the new child so the host's pre-existing protocol state stays valid, then
 * flushes any buffered subsequent requests.
 *
 * Why an in-process watcher instead of `tsx watch` or `nodemon`:
 *   - `tsx watch` consumes stdin (treats Return as a restart key), corrupting JSON-RPC.
 *   - `nodemon` would add a dev dependency. fs.watch is built into Node.
 *
 * Env:
 *   MCP_DEV_CMD       — child command (default: "tsx src/index.ts" relative to cwd)
 *   MCP_DEV_WATCH_DIR — dir to watch recursively (default: "src")
 */

import { type ChildProcess, spawn } from "node:child_process";
import { watch } from "node:fs";
import { resolve } from "node:path";

const MCP_DEV_CMD = process.env.MCP_DEV_CMD || "tsx src/index.ts";
const WATCH_DIR = resolve(process.cwd(), process.env.MCP_DEV_WATCH_DIR || "src");
const RESTART_DELAY_MS = 100;
const RESPAWN_TIMEOUT_MS = 10_000;
const DEBOUNCE_MS = 150;

let child: ChildProcess | null = null;
let isShuttingDown = false;
let childReady = false;
let restartCount = 0;

let initializeLine: string | null = null;
let initializedNotificationLine: string | null = null;

const pendingLines: string[] = [];
let stdinBuffer = "";

function writeToChild(line: string): void {
  if (child?.stdin && !child.stdin.destroyed) {
    try {
      child.stdin.write(`${line}\n`);
      return;
    } catch {
      // fall through to buffer
    }
  }
  pendingLines.push(line);
}

function flushPending(): void {
  if (!child?.stdin || child.stdin.destroyed) return;
  while (pendingLines.length > 0) {
    const line = pendingLines.shift();
    if (!line) continue;
    try {
      child.stdin.write(`${line}\n`);
    } catch {
      pendingLines.unshift(line);
      return;
    }
  }
}

function processStdinChunk(chunk: Buffer): void {
  stdinBuffer += chunk.toString("utf8");
  const lines = stdinBuffer.split("\n");
  stdinBuffer = lines.pop() ?? "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const parsed = JSON.parse(trimmed) as { method?: string };
      if (parsed.method === "initialize") {
        initializeLine = trimmed;
      } else if (parsed.method === "notifications/initialized") {
        initializedNotificationLine = trimmed;
      }
    } catch {
      // not JSON — still forward
    }

    if (childReady) {
      writeToChild(trimmed);
    } else {
      pendingLines.push(trimmed);
    }
  }
}

function spawnChild(): void {
  const [cmd, ...args] = MCP_DEV_CMD.split(" ");
  childReady = false;
  restartCount++;

  child = spawn(cmd, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
    shell: true,
    detached: true,
  });
  child.unref();

  child.stdout?.on("data", (data: Buffer) => {
    process.stdout.write(data);
  });

  child.stderr?.on("data", (data: Buffer) => {
    process.stderr.write(data);
  });

  child.on("error", (err) => {
    console.error("[dev-proxy] Child process error:", err);
  });

  child.on("exit", (code, signal) => {
    if (isShuttingDown) return;
    childReady = false;
    console.error(
      `[dev-proxy] Child exited (code: ${code}, signal: ${signal}), restarting in ${RESTART_DELAY_MS}ms...`,
    );
    setTimeout(spawnChild, RESTART_DELAY_MS);
  });

  setTimeout(() => {
    if (!child || child.killed) return;
    childReady = true;

    if (restartCount > 1 && initializeLine) {
      try {
        child.stdin?.write(`${initializeLine}\n`);
      } catch {
        // ignore
      }
      if (initializedNotificationLine) {
        try {
          child.stdin?.write(`${initializedNotificationLine}\n`);
        } catch {
          // ignore
        }
      }
      console.error(`[dev-proxy] Replayed handshake to child (restart #${restartCount - 1})`);
    }

    flushPending();
  }, 250);

  setTimeout(() => {
    if (!childReady && child && !child.killed) {
      console.error("[dev-proxy] Child failed to become ready within timeout, killing");
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        // ignore
      }
    }
  }, RESPAWN_TIMEOUT_MS);
}

function killChildGroup(signal: NodeJS.Signals): void {
  if (child?.pid) {
    try {
      process.kill(-child.pid, signal);
    } catch {
      // process group may already be gone
    }
  }
}

let restartTimer: NodeJS.Timeout | null = null;
function scheduleRestart(reason: string): void {
  if (isShuttingDown) return;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    console.error(`[dev-proxy] Source change detected (${reason}); restarting child`);
    killChildGroup("SIGTERM");
    // child 'exit' handler respawns
  }, DEBOUNCE_MS);
}

try {
  watch(WATCH_DIR, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    if (!/\.(ts|js|mjs|cjs|json)$/.test(filename)) return;
    if (filename.includes(".test.") || filename.includes(".spec.")) return;
    scheduleRestart(filename);
  });
  console.error(`[dev-proxy] Watching ${WATCH_DIR} for changes`);
} catch (err) {
  console.error(`[dev-proxy] Failed to watch ${WATCH_DIR}:`, err);
}

process.stdin.on("data", processStdinChunk);

process.on("SIGINT", () => {
  isShuttingDown = true;
  killChildGroup("SIGINT");
  process.exit(0);
});

process.on("SIGTERM", () => {
  isShuttingDown = true;
  killChildGroup("SIGTERM");
  process.exit(0);
});

spawnChild();
