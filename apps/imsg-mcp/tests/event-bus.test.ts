/**
 * EventBus unit tests — the framework-agnostic seam between the
 * ChangeWatcher and the frontends. Covers subscription delivery, version
 * bumps for useSyncExternalStore adapters, subscriber-throw isolation, and
 * the async-iterator consumption path.
 */

import { describe, expect, it } from "vitest";
import { type ChangeEvent, EventBus } from "../src/event-bus.js";
import type { Message } from "../src/types.js";

function msg(id: number, isReaction = false): Message {
  return { id, isReaction, text: `m${id}`, date: new Date(id) } as unknown as Message;
}

function newEvent(id: number): ChangeEvent {
  return { type: "message.new", message: msg(id) };
}

describe("EventBus", () => {
  it("delivers batches to subscribers and bumps the version once per batch", () => {
    const bus = new EventBus();
    const seen: (readonly ChangeEvent[])[] = [];
    bus.subscribe((events) => seen.push(events));

    expect(bus.getVersion()).toBe(0);
    bus.emit([newEvent(1), newEvent(2)]);
    bus.emit([newEvent(3)]);

    expect(seen).toHaveLength(2);
    expect(seen[0]).toHaveLength(2);
    expect(bus.getVersion()).toBe(2);
    expect(bus.getLastBatch()).toEqual([newEvent(3)]);
  });

  it("ignores empty batches (no version bump, no delivery)", () => {
    const bus = new EventBus();
    let calls = 0;
    bus.subscribe(() => {
      calls += 1;
    });
    bus.emit([]);
    expect(calls).toBe(0);
    expect(bus.getVersion()).toBe(0);
  });

  it("unsubscribe detaches the listener", () => {
    const bus = new EventBus();
    let calls = 0;
    const unsub = bus.subscribe(() => {
      calls += 1;
    });
    bus.emit([newEvent(1)]);
    unsub();
    bus.emit([newEvent(2)]);
    expect(calls).toBe(1);
    expect(bus.subscriberCount()).toBe(0);
  });

  it("a throwing subscriber does not break delivery to the others", () => {
    const bus = new EventBus();
    const seen: number[] = [];
    bus.subscribe(() => {
      throw new Error("bad subscriber");
    });
    bus.subscribe((events) => seen.push(events.length));
    bus.emit([newEvent(1)]);
    expect(seen).toEqual([1]);
  });

  it("async iterator yields emitted batches in order and detaches on return", async () => {
    const bus = new EventBus();
    const it = bus[Symbol.asyncIterator]();
    expect(bus.subscriberCount()).toBe(1);

    bus.emit([newEvent(1)]);
    bus.emit([newEvent(2), newEvent(3)]);

    const first = await it.next();
    const second = await it.next();
    expect(first.done).toBe(false);
    expect((first.value as readonly ChangeEvent[]).map((e) => e.type)).toEqual(["message.new"]);
    expect(second.value as readonly ChangeEvent[]).toHaveLength(2);

    // A pending next() resolves once a batch arrives.
    const pending = it.next();
    bus.emit([newEvent(4)]);
    const third = await pending;
    expect((third.value as readonly ChangeEvent[])[0]).toEqual(newEvent(4));

    await it.return?.();
    expect(bus.subscriberCount()).toBe(0);
  });

  it("for-await consumption sees live batches", async () => {
    const bus = new EventBus();
    const collected: number[] = [];
    const consumer = (async () => {
      for await (const batch of bus) {
        collected.push(batch.length);
        if (collected.length === 2) break; // break must detach cleanly
      }
    })();
    // Yield to let the consumer subscribe before emitting.
    await new Promise((r) => setImmediate(r));
    bus.emit([newEvent(1)]);
    bus.emit([newEvent(2), newEvent(3)]);
    await consumer;
    expect(collected).toEqual([1, 2]);
    expect(bus.subscriberCount()).toBe(0);
  });
});
