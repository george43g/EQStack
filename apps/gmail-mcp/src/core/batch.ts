// Generic batch processor used by `batch_modify_emails` and `batch_delete_emails`.
//
// Honors an AbortSignal — bails between batches when the MCP host cancels the
// call (notifications/cancelled). If a whole batch fails, retries the items
// one-by-one so partial success is still reported (returns `successes` and
// `failures` separately).
//
// Pure / surface-agnostic — no Gmail / Google imports.

import { info as logInfo } from "@george43g/robustness";

export interface BatchResult<T, U> {
  successes: U[];
  failures: { item: T; error: Error }[];
}

export interface ProcessBatchesOptions {
  /** Tool name passed to the cancel log line so operators can correlate. */
  toolName: string;
  /** AbortSignal from the MCP request. If aborted between batches we stop. */
  signal?: AbortSignal;
}

/**
 * Process `items` in chunks of `batchSize`, calling `processFn` once per
 * batch. On per-batch failure, falls back to one-item-at-a-time so partial
 * success is captured. Returns both arrays — caller decides how to format.
 */
export async function processBatches<T, U>(
  items: T[],
  batchSize: number,
  processFn: (batch: T[]) => Promise<U[]>,
  opts: ProcessBatchesOptions,
): Promise<BatchResult<T, U>> {
  const successes: U[] = [];
  const failures: { item: T; error: Error }[] = [];
  const { toolName, signal } = opts;

  for (let i = 0; i < items.length; i += batchSize) {
    if (signal?.aborted) {
      logInfo("batch_cancelled_by_client", {
        tool: toolName,
        processed: i,
        total: items.length,
      });
      break;
    }
    const batch = items.slice(i, i + batchSize);
    try {
      const results = await processFn(batch);
      successes.push(...results);
    } catch (_error) {
      // If batch fails, try individual items
      for (const item of batch) {
        if (signal?.aborted) break;
        try {
          const result = await processFn([item]);
          successes.push(...result);
        } catch (itemError) {
          failures.push({ item, error: itemError as Error });
        }
      }
    }
  }

  return { successes, failures };
}
