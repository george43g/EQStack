/**
 * Structured logger with performance monitoring.
 *
 * - In-memory ring buffer (last 500 lines) for runtime introspection.
 * - NDJSON file output to MCP_LOG_DIR (default: $TMPDIR/gmail-mcp/) for
 *   post-mortem analysis. Rotates at 10MB by default.
 * - Performance spans: `const span = perf("op"); ... span.end({ rows: 100 })`.
 * - Heartbeat heap monitor for crash forensics.
 *
 * Library-eligible: no Gmail-specific imports. Configurable via MCP_LOG_*.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envNum, envStr } from "./env.js";

// ── Types ──────────────────────────────────────────────────────────────

export type LogLevel = "info" | "warn" | "error" | "perf";

export interface LogEntry {
  ts: string;
  level: LogLevel;
  msg: string;
  dur_ms?: number;
  mem_mb: number;
  mem_delta_mb?: number;
  data?: Record<string, unknown>;
}

export interface PerfSpan {
  end(data?: Record<string, unknown>): number;
}

// ── Config ─────────────────────────────────────────────────────────────

const MAX_LOG_LINES = envNum("MCP_LOG_RING_SIZE", 500);
const MAX_FILE_BYTES = envNum("MCP_LOG_MAX_BYTES", 10 * 1024 * 1024);
const HEAP_WARN_MB = envNum("MCP_HEAP_WARN_MB", 150);
const HEAP_CHECK_INTERVAL_MS = envNum("MCP_HEAP_CHECK_MS", 60_000);

// ── State ──────────────────────────────────────────────────────────────

const memoryLines: string[] = [];
let logFilePath: string | null = null;
let logFileBytes = 0;
let heapMonitorTimer: ReturnType<typeof setInterval> | null = null;

// ── File output ────────────────────────────────────────────────────────

function getLogDir(): string {
  return envStr("MCP_LOG_DIR", join(tmpdir(), "gmail-mcp"));
}

function ensureLogFile(): string | null {
  if (logFilePath && logFileBytes < MAX_FILE_BYTES) return logFilePath;

  try {
    const dir = getLogDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const date = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    logFilePath = join(dir, `gmail-mcp-${process.pid}-${date}.ndjson`);
    logFileBytes = 0;
    return logFilePath;
  } catch {
    return null;
  }
}

function writeToFile(json: string): void {
  const path = ensureLogFile();
  if (!path) return;
  try {
    const line = `${json}\n`;
    appendFileSync(path, line);
    logFileBytes += line.length;
  } catch {
    // Don't let file I/O failures break the app.
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

function heapMB(): number {
  return Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 10) / 10;
}

function formatMemoryLine(entry: LogEntry): string {
  let line = `${entry.ts} [${entry.level}] ${entry.msg}`;
  if (entry.dur_ms != null) line += ` (${entry.dur_ms.toFixed(1)}ms)`;
  if (entry.data != null) line += ` ${JSON.stringify(entry.data)}`;
  return line;
}

function emit(entry: LogEntry): void {
  const line = formatMemoryLine(entry);
  memoryLines.push(line);
  if (memoryLines.length > MAX_LOG_LINES) {
    memoryLines.splice(0, memoryLines.length - MAX_LOG_LINES);
  }
  writeToFile(JSON.stringify(entry));
}

// ── Public API ─────────────────────────────────────────────────────────

export function info(msg: string, data?: Record<string, unknown>): void {
  emit({ ts: new Date().toISOString(), level: "info", msg, mem_mb: heapMB(), data });
}

export function warn(msg: string, data?: Record<string, unknown>): void {
  emit({ ts: new Date().toISOString(), level: "warn", msg, mem_mb: heapMB(), data });
}

export function error(msg: string, data?: Record<string, unknown>): void {
  emit({ ts: new Date().toISOString(), level: "error", msg, mem_mb: heapMB(), data });
}

/**
 * Start a performance span. Call `.end()` to log duration + heap delta.
 *
 * ```ts
 * const span = perf("gmail.search");
 * // ... work ...
 * span.end({ results: 10 });
 * ```
 */
export function perf(msg: string): PerfSpan {
  const startTime = performance.now();
  const startHeap = heapMB();

  return {
    end(data?: Record<string, unknown>): number {
      const dur_ms = performance.now() - startTime;
      const endHeap = heapMB();
      emit({
        ts: new Date().toISOString(),
        level: "perf",
        msg,
        dur_ms,
        mem_mb: endHeap,
        mem_delta_mb: Math.round((endHeap - startHeap) * 10) / 10,
        data,
      });
      return dur_ms;
    },
  };
}

export function getLogs(tail?: number): string[] {
  if (tail != null && tail > 0) return memoryLines.slice(-tail);
  return [...memoryLines];
}

export function clearLogs(): void {
  memoryLines.length = 0;
}

export function getLogFilePath(): string | null {
  return logFilePath;
}

export function getLogDirectory(): string {
  return getLogDir();
}

export function logStartup(entrypoint: string): void {
  info("startup", {
    pid: process.pid,
    ppid: process.ppid,
    entrypoint,
    node: process.version,
  });
}

export function logShutdown(reason: string): void {
  info("shutdown", {
    pid: process.pid,
    reason,
    uptime_s: Math.round(process.uptime()),
  });
}

/**
 * Read the latest NDJSON log file from disk. Returns the last N lines.
 */
export function getFileLogLines(tail = 50): string[] {
  try {
    const dir = getLogDir();
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".ndjson"))
      .sort()
      .reverse();
    if (files.length === 0) return [];

    const content = readFileSync(join(dir, files[0]), "utf8");
    const lines = content.trim().split("\n").filter(Boolean);
    return tail > 0 ? lines.slice(-tail) : lines;
  } catch {
    return [];
  }
}

// ── Heap monitor ───────────────────────────────────────────────────────

/**
 * Start periodic heap monitoring. Logs a warning if heap exceeds the
 * threshold and a heartbeat for post-mortem baseline. Call once at startup.
 */
export function startHeapMonitor(): void {
  if (heapMonitorTimer) return;
  heapMonitorTimer = setInterval(() => {
    const heap = heapMB();
    const { rss } = process.memoryUsage();
    const rssMb = Math.round((rss / 1024 / 1024) * 10) / 10;
    if (heap > HEAP_WARN_MB) {
      warn("heap exceeds threshold", {
        heap_mb: heap,
        rss_mb: rssMb,
        threshold_mb: HEAP_WARN_MB,
      });
    }
    emit({
      ts: new Date().toISOString(),
      level: "info",
      msg: "heartbeat",
      mem_mb: heap,
      data: { rss_mb: rssMb, uptime_s: Math.round(process.uptime()) },
    });
  }, HEAP_CHECK_INTERVAL_MS);
  heapMonitorTimer.unref();
}

export function stopHeapMonitor(): void {
  if (heapMonitorTimer) {
    clearInterval(heapMonitorTimer);
    heapMonitorTimer = null;
  }
}

/**
 * Test-only: reset the in-memory state (lines, file pointer, heap timer).
 * @internal
 */
export function _resetForTests(): void {
  memoryLines.length = 0;
  logFilePath = null;
  logFileBytes = 0;
  if (heapMonitorTimer) {
    clearInterval(heapMonitorTimer);
    heapMonitorTimer = null;
  }
}
