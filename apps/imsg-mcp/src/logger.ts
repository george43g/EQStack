/**
 * Structured logger — facade over `@george43g/robustness`'s logger (which was
 * extracted from this module's previous 393-line implementation).
 *
 * What the kit provides (delegated): ring buffer for `get_logs`, NDJSON file
 * output with 10MB rotation, stderr mirror, perf spans, safe stringification,
 * and — the reason this migration ships as a `fix:` — **redaction of phone
 * numbers and secret-shaped strings in every sink, ON by default**.
 *
 * What stays local, and why:
 *  - the `IMSG_DEV` file gate (kit default is file-logging ON; imsg's contract
 *    is OFF for end users unless IMSG_DEV=1 or the TUI forces it) — synced
 *    into the kit before every emit so the gate stays call-time;
 *  - `getFileLogLines` (prefers the CURRENT PID's file; the kit reads only
 *    the newest file, which returns another instance's log when an MCP server
 *    and a TUI share the machine — pinned by tests/get-logs-file-source);
 *  - `startHeapMonitor` (IMSG_DEV-gated, 256MB default via IMSG_HEAP_WARN_MB
 *    with a 64MB floor, IMSG_LOG_VERBOSE 10s cadence, `system_free_mb`);
 *  - `setLastSendError`/`getLastSendError` (imsg-specific, feeds the
 *    `get_last_send_error` MCP tool; the stored details stay RAW for the tool
 *    response — only the log line is redacted);
 *  - `logStartup` (imsg adds version/arch/abi to the marker);
 *  - `appendLog` (legacy level-string API used by MCP tools + shutdown).
 *
 * `setLogFilePrefix("imsg-mcp")` keeps the NDJSON location byte-identical:
 * `$TMPDIR/imsg-mcp/imsg-mcp-{PID}-{date}.ndjson`.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { freemem } from "node:os";
import { join } from "node:path";
import {
  clearLogs,
  getLogDirectory,
  getLogFilePath,
  getLogs,
  error as kitError,
  info as kitInfo,
  logShutdown as kitLogShutdown,
  perf as kitPerf,
  warn as kitWarn,
  type LogEntry,
  type LogLevel,
  type PerfSpan,
  setFileLogging,
  setLogFilePrefix,
  setStderrMirror,
  writeStderrLine,
} from "@george43g/robustness/logger";
import { APP_VERSION } from "./meta.js";

// Byte-identical NDJSON path/filename + `[imsg-mcp]` stderr prefix.
setLogFilePrefix("imsg-mcp");

export type { LogEntry, LogLevel, PerfSpan };
export { clearLogs, getLogDirectory, getLogFilePath, getLogs, writeStderrLine };

// ── Types (imsg-specific) ──────────────────────────────────────────────

export interface LastSendErrorDetails {
  message: string;
  stderr?: string;
  stdout?: string;
  code?: string | number;
  timestamp: string;
}

// ── IMSG_DEV file gate ─────────────────────────────────────────────────

/**
 * File logging is opt-in via IMSG_DEV=1 OR a programmatic `enableFileLogging()`
 * call. End users running the published `imsg mcp` bin don't get NDJSON files
 * in $TMPDIR by default. The TUI flips this on unconditionally so a future
 * crash leaves a postmortem trail. The in-memory ring buffer (500 lines)
 * still works either way.
 *
 * Checked at call time, not module-load time, so tests can flip the flag
 * without re-importing the module. `syncFileGate()` pushes the current gate
 * into the kit before every emit — this also means the kit's own
 * `MCP_LOG_TO_FILE` default-ON never applies to imsg (programmatic override
 * beats env in the kit).
 */
let fileLoggingForced = false;

/**
 * Force file logging on regardless of `IMSG_DEV`. Called by long-running
 * interactive entry points (TUI) where a postmortem trail justifies the
 * disk usage (file is 10 MB capped). Idempotent. No way to disable once on.
 */
export function enableFileLogging(): void {
  fileLoggingForced = true;
  syncFileGate();
}

function isFileLoggingEnabled(): boolean {
  return fileLoggingForced || process.env.IMSG_DEV === "1";
}

function isVerboseLogging(): boolean {
  return process.env.IMSG_LOG_VERBOSE === "1";
}

function syncFileGate(): void {
  setFileLogging(isFileLoggingEnabled());
}

// ── Emit API (delegated, gate-synced) ──────────────────────────────────

export function info(msg: string, data?: Record<string, unknown>): void {
  syncFileGate();
  kitInfo(msg, data);
}

export function warn(msg: string, data?: Record<string, unknown>): void {
  syncFileGate();
  kitWarn(msg, data);
}

export function error(msg: string, data?: Record<string, unknown>): void {
  syncFileGate();
  kitError(msg, data);
}

/**
 * Start a performance span. Call `.end()` on the returned object to log
 * the duration, heap delta, and optional metadata.
 *
 * ```ts
 * const span = perf("listConversations");
 * // ... work ...
 * span.end({ chats: 200, deduped: 180 });
 * ```
 */
export function perf(msg: string): PerfSpan {
  const span = kitPerf(msg);
  return {
    end(data?: Record<string, unknown>): number {
      // The emit happens at end() time — sync the gate then, not at start.
      syncFileGate();
      return span.end(data);
    },
  };
}

/**
 * Mirror structured info/warn/error logs to stderr. Call once from the MCP
 * stdio entrypoint. Never call this from the TUI — it would garble the render.
 */
export function enableStderrLogging(): void {
  setStderrMirror(true);
}

// ── Backwards-compatible API (used by MCP tools + shutdown wrapper) ────

/** @deprecated Use info/warn/error instead. Kept for MCP tool compat. */
export function appendLog(level: string, message: string, data?: unknown): void {
  const normalized =
    data != null
      ? typeof data === "object"
        ? (data as Record<string, unknown>)
        : { value: data }
      : undefined;
  if (level === "error") error(message, normalized);
  else if (level === "warn") warn(message, normalized);
  else info(message, normalized);
}

// ── Last-send-error store (imsg-specific) ──────────────────────────────

let lastSendError: LastSendErrorDetails | null = null;

export function setLastSendError(details: Omit<LastSendErrorDetails, "timestamp">): void {
  // Stored RAW for the get_last_send_error tool response (the agent needs the
  // real stderr to diagnose a failed send); the log line below IS redacted by
  // the kit like every other sink.
  lastSendError = { ...details, timestamp: new Date().toISOString() };
  error("send_message failed", details as Record<string, unknown>);
}

export function getLastSendError(): LastSendErrorDetails | null {
  return lastSendError ? { ...lastSendError } : null;
}

// ── Lifecycle markers ──────────────────────────────────────────────────

/** Log a startup marker — call at process start. */
export function logStartup(entrypoint: string): void {
  info("startup", {
    version: APP_VERSION,
    pid: process.pid,
    ppid: process.ppid,
    entrypoint,
    node: process.version,
    arch: process.arch,
    abi: process.versions.modules,
  });
}

/** Log a shutdown marker — call before process exits. */
export function logShutdown(reason: string): void {
  syncFileGate();
  kitLogShutdown(reason);
}

// ── File tail (imsg-specific: current-PID preference) ──────────────────

/**
 * Read the latest NDJSON log file from disk (for external access).
 * Returns the last N lines from the most recent log file.
 *
 * Kept local (not the kit's version): this prefers the file tagged with the
 * CURRENT PID so the caller gets logs from THIS server process even when
 * stale files from prior crashes / other instances sort later, falling back
 * to the most-recent file when no current-PID file exists. Uses the kit's
 * `getLogDirectory()` so reader and writer always agree on the directory.
 */
export function getFileLogLines(tail = 50): string[] {
  try {
    const dir = getLogDirectory();
    if (!existsSync(dir)) return [];
    const files = readdirSync(dir)
      .filter((f: string) => f.endsWith(".ndjson"))
      .sort();
    if (files.length === 0) return [];

    const currentPid = String(process.pid);
    const mine = files.filter((f: string) => f.includes(`imsg-mcp-${currentPid}-`));
    const targetFile = mine[mine.length - 1] ?? files[files.length - 1];
    if (targetFile === undefined) return [];

    const content = readFileSync(join(dir, targetFile), "utf8");
    const lines = content.trim().split("\n").filter(Boolean);
    return tail > 0 ? lines.slice(-tail) : lines;
  } catch {
    return [];
  }
}

// ── Heap monitor (imsg-specific gate + thresholds) ─────────────────────

/**
 * Heap warning threshold for the heartbeat monitor. Tunable via
 * `IMSG_HEAP_WARN_MB` env var. The default of 256 MB is set above the
 * legitimate working-set for big chat_analytics / large search_messages
 * sweeps on real Mac DBs (~240 MB at peak). Pre-fix this was 150,
 * which tripped on every analytic call — agents reading get_logs
 * saw a wall of false-positive "heap exceeds threshold" warnings on
 * every healthy invocation.
 */
const HEAP_WARN_MB = Math.max(
  64,
  Number.parseInt(process.env.IMSG_HEAP_WARN_MB ?? "256", 10) || 256,
);
let heapMonitorTimer: ReturnType<typeof setInterval> | null = null;

function heapMB(): number {
  return Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 10) / 10;
}

/**
 * Start periodic heap monitoring. Logs a warning if heap exceeds the
 * threshold. Call once at server startup.
 *
 * No-op when IMSG_DEV is unset — end users running the published bin don't
 * accumulate heartbeats. The watchdog itself (src/watchdog.ts) still runs
 * unconditionally for self-healing; this monitor is purely observability.
 *
 * Heartbeats fire every 60s by default, or every 10s when IMSG_LOG_VERBOSE=1.
 * Kept local (not the kit's): the kit monitor has no dev gate, a 150MB
 * default, and no `system_free_mb` (which diagnoses "process vanished"
 * reports where the kill came from outside — SIGKILL, OOM, parent host).
 */
export function startHeapMonitor(): void {
  if (!isFileLoggingEnabled()) return;
  if (heapMonitorTimer) return;
  const intervalMs = isVerboseLogging() ? 10_000 : 60_000;
  heapMonitorTimer = setInterval(() => {
    const heap = heapMB();
    const { rss } = process.memoryUsage();
    const rssMb = Math.round((rss / 1024 / 1024) * 10) / 10;
    if (heap > HEAP_WARN_MB) {
      warn("heap exceeds threshold", { heap_mb: heap, rss_mb: rssMb, threshold_mb: HEAP_WARN_MB });
    }
    const freeMb = Math.round(freemem() / 1024 / 1024);
    info("heartbeat", {
      rss_mb: rssMb,
      uptime_s: Math.round(process.uptime()),
      system_free_mb: freeMb || undefined,
    });
  }, intervalMs);
  // Don't prevent process exit
  heapMonitorTimer.unref();
}

export function stopHeapMonitor(): void {
  if (heapMonitorTimer) {
    clearInterval(heapMonitorTimer);
    heapMonitorTimer = null;
  }
}
