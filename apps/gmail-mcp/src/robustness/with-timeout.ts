/**
 * Per-tool timeout wrapper.
 *
 * Library-eligible: no Gmail-specific imports. Caller supplies the timeout
 * value (typically from a per-tool map plus a default).
 *
 * Behaviour:
 * - timeoutMs <= 0 disables the wrapper (the underlying promise runs unbounded).
 * - On timeout, throws ToolTimeoutError. The orphaned in-flight promise is NOT
 *   cancelled (Promise.race semantics) — the watchdog's event-loop monitor is
 *   the safety net for runaway work.
 * - The internal timer is .unref()'d so it never prevents process exit.
 */

export class ToolTimeoutError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly timeoutMs: number,
  ) {
    super(`Tool "${toolName}" timed out after ${timeoutMs}ms`);
    this.name = "ToolTimeoutError";
  }
}

export async function withTimeout<T>(
  toolName: string,
  fn: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  if (timeoutMs <= 0) return fn();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new ToolTimeoutError(toolName, timeoutMs));
    }, timeoutMs);
    timer.unref();
  });

  try {
    return await Promise.race([fn(), timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
