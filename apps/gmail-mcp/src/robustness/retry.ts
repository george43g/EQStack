/**
 * Generic retry wrapper for transient API failures.
 *
 * Library-eligible: no Gmail-specific imports. Caller chooses the
 * shouldRetry predicate. The default is conservative — only obviously
 * transient errors (5xx, 429, common network codes).
 */

import { envNum } from "./env.js";
import { warn } from "./logger.js";

const DEFAULT_MAX_ATTEMPTS = envNum("MCP_RETRY_MAX_ATTEMPTS", 3);
const DEFAULT_BASE_MS = envNum("MCP_RETRY_BASE_MS", 500);
const DEFAULT_CAP_MS = envNum("MCP_RETRY_CAP_MS", 8_000);

export interface RetryOptions {
  /** Total attempt budget (default: MCP_RETRY_MAX_ATTEMPTS or 3). */
  maxAttempts?: number;
  /** First retry delay in ms (default: MCP_RETRY_BASE_MS or 500). */
  baseMs?: number;
  /** Cap on any single retry delay (default: MCP_RETRY_CAP_MS or 8000). */
  capMs?: number;
  /** Add jitter (uniform 0..baseMs) to each delay (default: true). */
  jitter?: boolean;
  /** Predicate; default flags 5xx / 429 / common network codes. */
  shouldRetry?: (error: unknown) => boolean;
  /** Tag for logs (default: "retry"). */
  label?: string;
  /** Override `setTimeout` for tests. */
  timer?: (cb: () => void, ms: number) => unknown;
}

const DEFAULT_TRANSIENT_CODES = new Set([
  "ETIMEDOUT",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
]);

export function isTransientError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: number | string; status?: number; response?: { status?: number } };
  if (typeof e.code === "string" && DEFAULT_TRANSIENT_CODES.has(e.code)) return true;
  const status =
    (typeof e.code === "number" ? e.code : undefined) ?? e.status ?? e.response?.status;
  if (typeof status === "number") {
    if (status === 429) return true;
    if (status >= 500 && status < 600) return true;
  }
  return false;
}

function delayMsFor(attempt: number, baseMs: number, capMs: number, jitter: boolean): number {
  // Exponential: base * 2^(attempt-1). Cap at capMs. Optional jitter adds 0..baseMs.
  const exp = Math.min(capMs, baseMs * 2 ** (attempt - 1));
  if (!jitter) return exp;
  return Math.min(capMs, exp + Math.random() * baseMs);
}

function schedule(timer: RetryOptions["timer"], ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    const cb = () => resolveSleep();
    if (timer) timer(cb, ms);
    else setTimeout(cb, ms).unref?.();
  });
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseMs = opts.baseMs ?? DEFAULT_BASE_MS;
  const capMs = opts.capMs ?? DEFAULT_CAP_MS;
  const jitter = opts.jitter ?? true;
  const shouldRetry = opts.shouldRetry ?? isTransientError;
  const label = opts.label ?? "retry";

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= maxAttempts || !shouldRetry(err)) throw err;
      const delay = delayMsFor(attempt, baseMs, capMs, jitter);
      warn(`${label}_attempt`, {
        attempt,
        next_delay_ms: Math.round(delay),
        err_message: (err as Error)?.message,
      });
      await schedule(opts.timer, delay);
    }
  }
  throw lastErr;
}
