/**
 * Structured JSON-lines logger. Always writes to stderr so the stdio MCP
 * transport (stdout) is never polluted. Fields pass through `redactValue`
 * so a full phone number or bearer token can never reach a log line.
 */
import { redactValue } from "@george43g/robustness";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let minLevel: LogLevel = (process.env.TEL_LOG_LEVEL as LogLevel) || "info";

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

export function log(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[minLevel]) return;
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg,
  };
  if (fields) {
    for (const [k, v] of Object.entries(fields)) entry[k] = redactValue(v);
  }
  process.stderr.write(`${JSON.stringify(entry)}\n`);
}

export const logger = {
  debug: (msg: string, fields?: Record<string, unknown>) => log("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => log("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => log("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => log("error", msg, fields),
};
