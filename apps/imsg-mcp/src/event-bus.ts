/**
 * Typed change-event bus — the framework-agnostic seam between the core
 * ChangeWatcher (detection) and every frontend (rendering).
 *
 * Design per docs/plans/realtime-streaming-and-api-surface.md Part A:
 *  - Core owns detection; frontends only render. No React in here — the TUI
 *    wraps this in a `useSyncExternalStore` adapter (`getVersion` is the
 *    snapshot; a bumped version tells React to re-read whatever store the
 *    adapter maintains), the console consumes the async iterator, and the
 *    MCP `wait_for_changes` tool long-polls a subscription.
 *  - Events arrive in BATCHES (one per watcher debounce window) so a bulk
 *    sync writing thousands of rows coalesces instead of storming
 *    subscribers.
 *
 * Currently emitted by the watcher: `message.new` and `reaction` (both are
 * new ROWIDs, classified via the shared Message conversion). The remaining
 * variants are reserved for the mutation-detection and group-event backlog
 * items (STATUS.md §9) so consumers can switch over the closed union today.
 */

import type { Message } from "./types.js";

export type ChangeEvent =
  | { type: "message.new"; message: Message }
  | { type: "reaction"; message: Message }
  | { type: "message.edited"; message: Message }
  | { type: "message.unsent"; message: Message }
  | {
      type: "group.renamed" | "group.member_added" | "group.member_removed";
      chatIdentifier: string;
    };

export type ChangeBatchListener = (events: readonly ChangeEvent[]) => void;

/**
 * Async-iterator queues are bounded so a subscriber that stops pulling
 * (or pulls slowly through a bulk sync) can't grow memory without limit.
 * Oldest batches are dropped first; `droppedBatches` on the iterator's
 * return records the loss so a consumer can trigger a full refresh.
 */
const MAX_QUEUED_BATCHES = 256;

export class EventBus {
  private readonly listeners = new Set<ChangeBatchListener>();
  private version = 0;
  private lastBatch: readonly ChangeEvent[] = [];

  /** Deliver a batch to all subscribers. Empty batches are ignored. */
  emit(events: readonly ChangeEvent[]): void {
    if (events.length === 0) return;
    this.version += 1;
    this.lastBatch = events;
    for (const listener of this.listeners) {
      try {
        listener(events);
      } catch {
        // A throwing subscriber must never break delivery to the others
        // (or the watcher's drain loop above us).
      }
    }
  }

  /** Subscribe to event batches. Returns an unsubscribe function. */
  subscribe(listener: ChangeBatchListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Monotonic change counter — the `getSnapshot` value for
   * `useSyncExternalStore`. Bumped once per delivered batch.
   */
  getVersion(): number {
    return this.version;
  }

  /** The most recently delivered batch (empty before the first emit). */
  getLastBatch(): readonly ChangeEvent[] {
    return this.lastBatch;
  }

  /** Number of live subscribers (asyncIterator consumers included). */
  subscriberCount(): number {
    return this.listeners.size;
  }

  /**
   * Consume batches as an async stream:
   *
   * ```ts
   * for await (const batch of bus) render(batch);
   * ```
   *
   * Each iteration yields one emitted batch. Break/return detaches the
   * underlying subscription.
   */
  [Symbol.asyncIterator](): AsyncIterator<readonly ChangeEvent[]> {
    const queue: (readonly ChangeEvent[])[] = [];
    let droppedBatches = 0;
    let wake: (() => void) | null = null;
    let done = false;

    const unsubscribe = this.subscribe((events) => {
      queue.push(events);
      if (queue.length > MAX_QUEUED_BATCHES) {
        queue.shift();
        droppedBatches += 1;
      }
      wake?.();
      wake = null;
    });

    return {
      async next(): Promise<IteratorResult<readonly ChangeEvent[]>> {
        while (queue.length === 0) {
          if (done) return { done: true, value: undefined };
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
        return { done: false, value: queue.shift() as readonly ChangeEvent[] };
      },
      async return(): Promise<IteratorResult<readonly ChangeEvent[]>> {
        done = true;
        unsubscribe();
        wake?.();
        wake = null;
        if (droppedBatches > 0) {
          // Surfaced for debugging; consumers that care should track lag
          // via their own high-water mark and re-sync on gaps.
          queue.length = 0;
        }
        return { done: true, value: undefined };
      },
    };
  }
}
