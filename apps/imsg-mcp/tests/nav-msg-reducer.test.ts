/**
 * NAV_MSG — thread-cursor motion through tui-kit navReduce (the last 0.5.x
 * primitive from the adoption pledge). Pins the consumer-side contract:
 *
 * - the vim count is read AND consumed from the shared numBuffer in the same
 *   reducer step as the movement (the router must never pre-consume it — a
 *   SET_NUM_BUFFER("") dispatched first would clear the count before NAV_MSG
 *   ran, because the router's `state` is a render snapshot);
 * - movement repeats by count; groupJump now repeats too (`3}` crosses three
 *   sender groups — pre-adoption it consumed the count and jumped one);
 * - PREPEND_MESSAGES and eviction remap the cursor via the kit's
 *   itemsReplaced, which never remaps the -1 follow-tail sentinel (#94's
 *   bug class) and clamps the remap output.
 */
import { describe, expect, it } from "vitest";
import { type AppState, initialState, reducer } from "../src/tui/types.js";
import type { Message } from "../src/types.js";

function msg(id: number, handle = "+15550000001", isFromMe = false): Message {
  return {
    id,
    guid: `g-${id}`,
    text: `m${id}`,
    handle,
    isFromMe,
    date: new Date(Date.UTC(2026, 0, 1, 0, 0, id)),
    dateRead: null,
    dateDelivered: null,
    isRead: true,
    isDelivered: true,
    chatId: "c",
    service: "iMessage",
    isReaction: false,
    isReply: false,
    isEdited: false,
    isRetracted: false,
    hasAttachments: false,
  };
}

function withMessages(n: number, over: Partial<AppState> = {}): AppState {
  return {
    ...initialState,
    messages: Array.from({ length: n }, (_, i) => msg(i + 1)),
    selectedMsgIdx: 0,
    focus: "thread",
    ...over,
  };
}

describe("NAV_MSG through navReduce", () => {
  it("consumes the shared numBuffer as a repeat count in ONE reducer step", () => {
    const s = withMessages(20, { numBuffer: "5" });
    const out = reducer(s, { type: "NAV_MSG", intent: { kind: "down" } });
    expect(out.selectedMsgIdx).toBe(5);
    expect(out.numBuffer).toBe(""); // consumed atomically with the move
  });

  it("clamps at the ends", () => {
    const s = withMessages(3, { selectedMsgIdx: 2, numBuffer: "99" });
    expect(reducer(s, { type: "NAV_MSG", intent: { kind: "down" } }).selectedMsgIdx).toBe(2);
    expect(
      reducer(withMessages(3, { numBuffer: "99" }), { type: "NAV_MSG", intent: { kind: "up" } })
        .selectedMsgIdx,
    ).toBe(0);
  });

  it("page intents scale by the caller-supplied pageSize (layout-derived)", () => {
    const s = withMessages(50);
    const out = reducer(s, { type: "NAV_MSG", intent: { kind: "pageDown" }, pageSize: 12 });
    expect(out.selectedMsgIdx).toBe(12);
  });

  it("groupJump repeats by count — `3}` crosses three sender groups", () => {
    // Groups of 2: sender flips every other message.
    const messages = Array.from({ length: 12 }, (_, i) =>
      msg(i + 1, `+1555000${Math.floor(i / 2)}`, false),
    );
    const s = { ...withMessages(0), messages, selectedMsgIdx: 0, numBuffer: "3" };
    const out = reducer(s, { type: "NAV_MSG", intent: { kind: "groupJump", dir: 1 } });
    expect(out.selectedMsgIdx).toBe(6); // boundaries at 2, 4, 6
    expect(out.numBuffer).toBe("");
  });

  it("top/bottom land on the ends and consume any pending count", () => {
    const s = withMessages(9, { selectedMsgIdx: 4, numBuffer: "7" });
    expect(reducer(s, { type: "NAV_MSG", intent: { kind: "bottom" } }).selectedMsgIdx).toBe(8);
    expect(reducer(s, { type: "NAV_MSG", intent: { kind: "bottom" } }).numBuffer).toBe("");
    expect(reducer(s, { type: "NAV_MSG", intent: { kind: "top" } }).selectedMsgIdx).toBe(0);
  });

  it("empty thread → cursor stays the follow-tail sentinel", () => {
    const s = { ...initialState, messages: [], selectedMsgIdx: -1 };
    expect(reducer(s, { type: "NAV_MSG", intent: { kind: "down" } }).selectedMsgIdx).toBe(-1);
  });
});

describe("itemsReplaced properties (prepend + follow-tail)", () => {
  it("PREPEND_MESSAGES shifts a concrete cursor to the same logical message", () => {
    const s = withMessages(5, { selectedMsgIdx: 2 });
    const older = [msg(-3), msg(-2), msg(-1)]; // 3 fresh older rows
    const out = reducer(s, { type: "PREPEND_MESSAGES", data: older, oldestId: -3 });
    expect(out.selectedMsgIdx).toBe(5); // 2 + 3
  });

  it("PREPEND_MESSAGES never remaps the -1 follow-tail sentinel", () => {
    const s = withMessages(5, { selectedMsgIdx: -1 });
    const out = reducer(s, {
      type: "PREPEND_MESSAGES",
      data: [msg(-1)],
      oldestId: -1,
    });
    expect(out.selectedMsgIdx).toBe(-1);
  });
});
