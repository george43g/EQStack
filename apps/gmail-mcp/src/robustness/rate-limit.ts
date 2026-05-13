/**
 * Token-bucket rate limiter.
 *
 * Library-eligible: no Gmail-specific imports. The default singleton is
 * configured via `MCP_RATE_LIMIT_RPS` (steady-state requests per second) and
 * `MCP_RATE_LIMIT_BURST` (max tokens). Set RPS to 0 to disable.
 *
 * Use:
 *   await acquire();              // 1 token, default bucket
 *   await acquire(2);             // 2 tokens
 *   const b = new TokenBucket(...);
 *   await b.acquire();
 */

import { envNum } from "./env.js";

const DEFAULT_RPS = envNum("MCP_RATE_LIMIT_RPS", 10);
const DEFAULT_BURST = envNum("MCP_RATE_LIMIT_BURST", 30);

export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    public readonly capacity: number,
    public readonly rps: number,
    private readonly clock: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => {
        const t = setTimeout(r, ms);
        if (typeof (t as { unref?: () => void }).unref === "function") {
          (t as { unref: () => void }).unref();
        }
      }),
  ) {
    if (capacity < 0) throw new Error("capacity must be >= 0");
    if (rps < 0) throw new Error("rps must be >= 0");
    this.tokens = capacity;
    this.lastRefill = clock();
  }

  private refill(now: number): void {
    if (this.rps <= 0) return;
    const elapsedSec = Math.max(0, (now - this.lastRefill) / 1000);
    const refilled = elapsedSec * this.rps;
    this.tokens = Math.min(this.capacity, this.tokens + refilled);
    this.lastRefill = now;
  }

  /** Available tokens right now (for tests / introspection). */
  available(): number {
    this.refill(this.clock());
    return this.tokens;
  }

  /**
   * Block until `n` tokens are available, then deduct them. With rps=0
   * tokens never refill, so once exhausted further calls hang — call sites
   * should treat rps=0 as "limiter off" and skip calling acquire. The
   * default singleton's `acquire()` handles that for you.
   */
  async acquire(n = 1): Promise<void> {
    if (n <= 0) return;
    if (this.rps <= 0) return; // disabled — never wait
    // Loop instead of recursion so a stampede can't blow the stack.
    for (;;) {
      const now = this.clock();
      this.refill(now);
      if (this.tokens >= n) {
        this.tokens -= n;
        return;
      }
      const needed = n - this.tokens;
      const waitMs = Math.max(1, Math.ceil((needed / this.rps) * 1000));
      await this.sleep(waitMs);
    }
  }
}

const defaultLimiter = new TokenBucket(DEFAULT_BURST, DEFAULT_RPS);

/** Acquire from the default process-wide bucket. */
export async function acquire(n = 1): Promise<void> {
  return defaultLimiter.acquire(n);
}

/** Inspect the default bucket — for health_check / tests. */
export function defaultLimiterAvailable(): number {
  return defaultLimiter.available();
}
