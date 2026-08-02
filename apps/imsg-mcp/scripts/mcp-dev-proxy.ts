#!/usr/bin/env node
/**
 * MCP Dev Proxy - A persistent stdio proxy for MCP server development.
 *
 * Stays alive across child restarts. Buffers stdin from the host (Cursor/Warp)
 * during restart windows so requests aren't silently dropped.
 *
 * On restart:
 * 1. Replays the captured `initialize` request to the new child so the host's
 *    pre-existing protocol state stays valid.
 * 2. Then flushes any buffered subsequent requests.
 *
 * Usage:
 *   MCP_DEV_CMD="tsx src/cli.ts mcp" tsx scripts/mcp-dev-proxy.ts
 */

import { type ChildProcess, spawn } from "node:child_process";

const MCP_DEV_CMD = process.env.MCP_DEV_CMD || "tsx src/cli.ts mcp";
const RESTART_DELAY_MS = 100;
const RESPAWN_TIMEOUT_MS = 10_000;

let child: ChildProcess | null = null;
let isShuttingDown = false;
let childReady = false;
let restartCount = 0;

// Captured handshake — replayed to each new child.
let initializeLine: string | null = null;
let initializedNotificationLine: string | null = null;

// Buffer for stdin while child is starting/dead.
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

    // Capture the host's initialize handshake so we can replay it after restart.
    try {
      const parsed = JSON.parse(trimmed) as { method?: string };
      if (parsed.method === "initialize") {
        initializeLine = trimmed;
      } else if (parsed.method === "notifications/initialized") {
        initializedNotificationLine = trimmed;
      }
    } catch {
      // Not valid JSON — still forward
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
    // IMSG_DEV=1 tells the MCP server to expose dev-only tools (health_check,
    // get_logs, get_last_send_error, run_build, request_restart). The prod
    // `imsg mcp` entry doesn't set this, so end users never see those tools.
    env: { ...process.env, IMSG_DEV: "1" },
    stdio: ["pipe", "pipe", "pipe"],
    shell: true,
    detached: true, // own process group so we can kill the whole tree
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

  // Wait briefly for child to be ready, then replay handshake + flush pending.
  // We can't reliably detect "ready" without protocol introspection — use a
  // short grace period.
  setTimeout(() => {
    if (!child || child.killed) return;
    childReady = true;

    // On restart (not first spawn), replay handshake
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

  // Hard timeout: if child never becomes ready, kill it
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

// Forward stdin (line-buffered) from parent to child
process.stdin.on("data", processStdinChunk);

// Handle parent process shutdown
function killChildGroup(signal: NodeJS.Signals): void {
  if (child?.pid) {
    try {
      process.kill(-child.pid, signal);
    } catch {
      // process group may already be gone
    }
  }
}

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

// Start the first child
spawnChild();
