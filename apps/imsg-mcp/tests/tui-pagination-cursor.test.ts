/**
 * Pagination cursor correctness (swarm findings A1-1 false-exhaustion,
 * A1-2 date-jump stall):
 *
 *  - `oldestMessageCursor` must return the id of the message with the minimum
 *    (date, ROWID) — NOT the min ROWID. In merged threads a newer-dated
 *    message can carry a lower ROWID; using min-ROWID as the "load older"
 *    cursor overlapped pages and falsely declared exhaustion.
 *  - `SELECT_MSG_BY_DATE` selects the first message at/after a target against
 *    the live reducer state (date jump can't rely on a closure snapshot).
 */

import { describe, expect, it } from "vitest";
import { type AppState, initialState, reducer } from "../src/tui/types.js";
import { type Message, oldestMessageCursor } from "../src/types.js";

function msg(id: number, dateMs: number): Message {
  return {
    id,
    guid: `g${id}`,
    text: `m${id}`,
    handle: "+1",
    isFromMe: false,
    date: new Date(dateMs),
    dateRead: null,
    dateDelivered: null,
    isRead: false,
    isDelivered: false,
    isReaction: false,
  } as unknown as Message;
}

describe("oldestMessageCursor", () => {
  it("returns null for an empty list", () => {
    expect(oldestMessageCursor([])).toBeNull();
  });

  it("returns the id of the oldest message by date", () => {
    // ids ascending, dates ascending — trivial case.
    expect(oldestMessageCursor([msg(10, 1000), msg(11, 2000), msg(12, 3000)])).toBe(10);
  });

  it("picks the oldest DATE even when its ROWID is NOT the minimum (merged thread)", () => {
    // The merged-thread bug: message id=99 is the oldest by DATE (t=500) but
    // carries a HIGHER ROWID than id=10 (t=3000). min-ROWID would wrongly
    // return 10; the correct cursor is 99.
    const merged = [msg(10, 3000), msg(50, 2000), msg(99, 500)];
    expect(oldestMessageCursor(merged)).toBe(99);
  });

  it("breaks date ties by the lower ROWID (matches the DB composite cursor)", () => {
    const sameDate = [msg(30, 1000), msg(20, 1000), msg(25, 1000)];
    expect(oldestMessageCursor(sameDate)).toBe(20);
  });
});

describe("SELECT_MSG_BY_DATE", () => {
  const base: AppState = {
    ...initialState,
    messages: [msg(1, 1000), msg(2, 2000), msg(3, 3000), msg(4, 4000)],
    selectedMsgIdx: 3,
  };

  it("selects the first message at or after the target date", () => {
    const next = reducer(base, { type: "SELECT_MSG_BY_DATE", date: new Date(2500) });
    expect(next.selectedMsgIdx).toBe(2); // first with date >= 2500 is id=3 at idx 2
  });

  it("selects an exact-date match", () => {
    const next = reducer(base, { type: "SELECT_MSG_BY_DATE", date: new Date(2000) });
    expect(next.selectedMsgIdx).toBe(1);
  });

  it("falls back to the last message when the target is newer than all", () => {
    const next = reducer(base, { type: "SELECT_MSG_BY_DATE", date: new Date(9999) });
    expect(next.selectedMsgIdx).toBe(3);
  });

  it("selects the first message when the target predates all", () => {
    const next = reducer(base, { type: "SELECT_MSG_BY_DATE", date: new Date(1) });
    expect(next.selectedMsgIdx).toBe(0);
  });
});
