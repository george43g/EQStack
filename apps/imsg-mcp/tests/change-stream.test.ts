/**
 * useSyncExternalStore adapter over the EventBus (src/tui/change-stream.ts).
 *
 * Contract under test: subscriber notification, immutable + referentially
 * stable snapshots, version bumps per emission, accumulation across
 * emissions until ack, stale-ack protection, unsubscribe detaching from the
 * bus, and the overflow fallback flag.
 */

import { describe, expect, it, vi } from "vitest";
import { type ChangeEvent, EventBus } from "../src/event-bus.js";
import {
  createChangeStream,
  emptyChangeSnapshot,
  MAX_PENDING_EVENTS,
  noopSubscribe,
} from "../src/tui/change-stream.js";
import type { Message } from "../src/types.js";

function evt(id: number): ChangeEvent {
  const message = { id, guid: `g${id}`, text: `m${id}`, isReaction: false } as unknown as Message;
  return { type: "message.new", message };
}

describe("createChangeStream", () => {
  it("notifies subscribers on emit and bumps the snapshot version", () => {
    const bus = new EventBus();
    const store = createChangeStream(bus);
    const onChange = vi.fn();
    store.subscribe(onChange);

    expect(store.getSnapshot().version).toBe(0);
    bus.emit([evt(1)]);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().version).toBe(1);
    expect(store.getSnapshot().batch.map((e) => ("message" in e ? e.message.id : -1))).toEqual([1]);

    bus.emit([evt(2)]);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().version).toBe(2);
  });

  it("returns an immutable, referentially stable snapshot between emissions", () => {
    const bus = new EventBus();
    const store = createChangeStream(bus);
    store.subscribe(() => {});
    bus.emit([evt(1)]);

    const a = store.getSnapshot();
    const b = store.getSnapshot();
    // Same reference until the next emission — React calls getSnapshot
    // repeatedly and a fresh object per call would re-render forever.
    expect(a).toBe(b);
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a.batch)).toBe(true);

    bus.emit([evt(2)]);
    expect(store.getSnapshot()).not.toBe(a);
    // The earlier snapshot is untouched by later emissions.
    expect(a.batch).toHaveLength(1);
  });

  it("accumulates events across emissions until ack (no batch is lost)", () => {
    const bus = new EventBus();
    const store = createChangeStream(bus);
    store.subscribe(() => {});

    // Two drains land before the consumer's effect runs.
    bus.emit([evt(1), evt(2)]);
    bus.emit([evt(3)]);

    const snap = store.getSnapshot();
    expect(snap.version).toBe(2);
    expect(snap.batch.map((e) => ("message" in e ? e.message.id : -1))).toEqual([1, 2, 3]);

    store.ack(snap.version);
    expect(store.getSnapshot().batch).toHaveLength(0);
    expect(store.getSnapshot().version).toBe(2); // version survives the ack

    // Post-ack events start a fresh accumulation.
    bus.emit([evt(4)]);
    expect(store.getSnapshot().batch.map((e) => ("message" in e ? e.message.id : -1))).toEqual([4]);
  });

  it("ignores a stale ack so events emitted since the consumer's read survive", () => {
    const bus = new EventBus();
    const store = createChangeStream(bus);
    store.subscribe(() => {});

    bus.emit([evt(1)]);
    const stale = store.getSnapshot().version; // consumer read v1...
    bus.emit([evt(2)]); // ...but v2 landed before it acked

    store.ack(stale);
    expect(store.getSnapshot().batch).toHaveLength(2); // nothing dropped
  });

  it("detaches from the bus when the last subscriber unsubscribes", () => {
    const bus = new EventBus();
    const store = createChangeStream(bus);
    expect(bus.subscriberCount()).toBe(0); // lazy attach

    const un1 = store.subscribe(() => {});
    const un2 = store.subscribe(() => {});
    expect(bus.subscriberCount()).toBe(1); // one bus subscription fans out

    un1();
    expect(bus.subscriberCount()).toBe(1);
    un2();
    expect(bus.subscriberCount()).toBe(0);
  });

  it("caps accumulation and flags overflow; ack clears the flag", () => {
    const bus = new EventBus();
    const store = createChangeStream(bus);
    store.subscribe(() => {});

    const flood: ChangeEvent[] = [];
    for (let i = 0; i < MAX_PENDING_EVENTS + 10; i++) flood.push(evt(i));
    bus.emit(flood);

    const snap = store.getSnapshot();
    expect(snap.overflowed).toBe(true);
    expect(snap.batch).toHaveLength(MAX_PENDING_EVENTS);
    // Oldest dropped first — the newest event must survive.
    const last = snap.batch[snap.batch.length - 1];
    expect("message" in last && last.message.id).toBe(MAX_PENDING_EVENTS + 9);

    store.ack(snap.version);
    expect(store.getSnapshot().overflowed).toBe(false);
    expect(store.getSnapshot().batch).toHaveLength(0);
  });

  it("no-op pair for App-without-a-bus renders", () => {
    // Stable references (App passes these to useSyncExternalStore on every render).
    expect(emptyChangeSnapshot()).toBe(emptyChangeSnapshot());
    const unsubscribe = noopSubscribe(() => {});
    expect(unsubscribe).toBeTypeOf("function");
    unsubscribe();
  });
});
