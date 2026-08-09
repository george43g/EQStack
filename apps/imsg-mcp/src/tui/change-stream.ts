/**
 * useSyncExternalStore adapter over the core EventBus — the TUI-side seam
 * from docs/plans/realtime-streaming-and-api-surface.md Part A ("core owns
 * detection; frontends only render"). No React imports here: the store is a
 * plain subscribe/getSnapshot pair that App plugs into React.
 *
 * Contract:
 *  - `getSnapshot` returns an IMMUTABLE, referentially-stable object between
 *    bus emissions. React calls it repeatedly to detect tearing — minting a
 *    fresh object per call would re-render forever.
 *  - Events ACCUMULATE across emissions until the consumer calls
 *    `ack(version)`. React effects run after paint, so two watcher drains can
 *    land between renders; snapshotting only the LAST bus batch would
 *    silently drop the earlier one. `batch` is therefore "every event not
 *    yet acknowledged", in arrival order.
 *  - The accumulation is capped: past MAX_PENDING_EVENTS the oldest events
 *    are dropped and `overflowed` is set, so the consumer can fall back to a
 *    full refresh instead of trusting an incomplete delta.
 */

import type { ChangeEvent, EventBus } from "../event-bus.js";

export interface ChangeStreamSnapshot {
  /** Mirrors EventBus.getVersion() at the time of the last emission. */
  readonly version: number;
  /** All events since the last ack (coalesced across bus batches). */
  readonly batch: readonly ChangeEvent[];
  /** True when the cap dropped events — the delta is incomplete. */
  readonly overflowed: boolean;
}

export interface ChangeStreamStore {
  /** React useSyncExternalStore subscribe: returns the unsubscribe fn. */
  subscribe(onStoreChange: () => void): () => void;
  getSnapshot(): ChangeStreamSnapshot;
  /**
   * Mark everything up to `version` as processed, clearing the accumulated
   * batch (and the overflow flag). A stale version — more events arrived
   * since the caller read its snapshot — is ignored so those events survive
   * until the consumer sees the newer snapshot.
   */
  ack(version: number): void;
}

/** Accumulation cap — a bulk sync between two renders lands thousands of
 * rows; past this the snapshot stops being a trustworthy delta. */
export const MAX_PENDING_EVENTS = 2048;

const EMPTY_BATCH: readonly ChangeEvent[] = Object.freeze([]);

const NOOP_UNSUBSCRIBE = (): void => {};

/** Stable no-op subscribe for rendering App without a bus (hooks may not be
 * conditional, so App always calls useSyncExternalStore with SOMETHING). */
export function noopSubscribe(_onStoreChange: () => void): () => void {
  return NOOP_UNSUBSCRIBE;
}

const EMPTY_SNAPSHOT: ChangeStreamSnapshot = Object.freeze({
  version: 0,
  batch: EMPTY_BATCH,
  overflowed: false,
});

/** Stable empty getSnapshot companion to `noopSubscribe`. */
export function emptyChangeSnapshot(): ChangeStreamSnapshot {
  return EMPTY_SNAPSHOT;
}

export function createChangeStream(bus: EventBus): ChangeStreamStore {
  // Start at the bus's CURRENT version with no events: history is the
  // initial-load path's job, the stream carries only what happens next
  // (same philosophy as the watcher's high-water seed).
  let snapshot: ChangeStreamSnapshot = Object.freeze({
    version: bus.getVersion(),
    batch: EMPTY_BATCH,
    overflowed: false,
  });
  let pending: ChangeEvent[] = [];
  let overflowed = false;
  const listeners = new Set<() => void>();
  let detach: (() => void) | null = null;

  const onBusBatch = (events: readonly ChangeEvent[]): void => {
    pending.push(...events);
    if (pending.length > MAX_PENDING_EVENTS) {
      pending = pending.slice(pending.length - MAX_PENDING_EVENTS);
      overflowed = true;
    }
    snapshot = Object.freeze({
      version: bus.getVersion(),
      batch: Object.freeze([...pending]) as readonly ChangeEvent[],
      overflowed,
    });
    for (const listener of [...listeners]) listener();
  };

  return {
    subscribe(onStoreChange: () => void): () => void {
      listeners.add(onStoreChange);
      // Attach to the bus lazily and detach with the last listener so an
      // unmounted App leaves no dangling bus subscription behind.
      if (!detach) detach = bus.subscribe(onBusBatch);
      return () => {
        listeners.delete(onStoreChange);
        if (listeners.size === 0 && detach) {
          detach();
          detach = null;
        }
      };
    },
    getSnapshot(): ChangeStreamSnapshot {
      return snapshot;
    },
    ack(version: number): void {
      if (version < snapshot.version) return; // newer events pending — keep them
      pending = [];
      overflowed = false;
      snapshot = Object.freeze({
        version: snapshot.version,
        batch: EMPTY_BATCH,
        overflowed: false,
      });
      // No listener notification: the consumer just processed this version;
      // waking React for an empty batch would be a render for nothing.
    },
  };
}
