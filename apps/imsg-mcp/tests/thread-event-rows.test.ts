/**
 * Pure placement of inline group-event rows (#106 follow-up).
 *
 * Events are ROWID-placed annotations, never merged into the messages array —
 * the invariants here are what keeps them inert to cursor math, eviction, and
 * pagination: events before the loaded window are dropped (they appear when
 * scroll-back loads their region), events inside an evicted gap are dropped
 * (the gap marker owns that region), events newer than every message land on
 * the tail key.
 */
import { describe, expect, it } from "vitest";
import { placeEventRows } from "../src/tui/thread-event-rows.js";
import type { ConversationEvent } from "../src/types.js";

function ev(id: number, overrides: Partial<ConversationEvent> = {}): ConversationEvent {
  return {
    id,
    date: new Date(Date.UTC(2026, 3, 1, 0, id)),
    kind: "member_added",
    actor: "+15550000001",
    actorName: "Alice Smith",
    target: "+15550000002",
    targetName: "Bob Jones",
    newName: null,
    ...overrides,
  };
}

const msgs = [{ id: 100 }, { id: 200 }, { id: 300 }];

describe("placeEventRows", () => {
  it("places an event before the first message with a higher ROWID", () => {
    const placed = placeEventRows(msgs, [ev(150)]);
    expect([...placed.keys()]).toEqual([1]);
    expect(placed.get(1)?.map((e) => e.id)).toEqual([150]);
  });

  it("multiple events between the same pair keep ROWID order", () => {
    const placed = placeEventRows(msgs, [ev(250), ev(210)]);
    expect(placed.get(2)?.map((e) => e.id)).toEqual([210, 250]);
  });

  it("events newer than every message land on the tail key (messages.length)", () => {
    const placed = placeEventRows(msgs, [ev(999)]);
    expect(placed.get(3)?.map((e) => e.id)).toEqual([999]);
  });

  it("drops events older than the loaded window — they belong to unloaded history", () => {
    expect(placeEventRows(msgs, [ev(50)]).size).toBe(0);
  });

  it("drops events inside an evicted gap — the gap marker owns that region", () => {
    const gaps = [{ atIdx: 1, oldestId: 140, newestId: 260, count: 12 }];
    const placed = placeEventRows(msgs, [ev(150), ev(280)], gaps);
    expect([...placed.keys()]).toEqual([2]);
    expect(placed.get(2)?.map((e) => e.id)).toEqual([280]);
  });

  it("empty messages or events → empty map", () => {
    expect(placeEventRows([], [ev(150)]).size).toBe(0);
    expect(placeEventRows(msgs, []).size).toBe(0);
  });
});
