/**
 * Bounded message window: when the in-memory message array grows past the
 * hard cap, the middle is evicted but the most-recent ANCHOR_KEEP and the
 * cursor's window are preserved. The eviction is recorded as gap markers
 * so the UI can show "N more messages" placeholders.
 */
import { describe, expect, it } from "vitest";
import { boundMessagesIfNeeded, initialState, reducer } from "../src/tui/types.js";
import type { Message } from "../src/types.js";

function fakeMsgs(n: number): Message[] {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    guid: `g${i + 1}`,
    text: `msg ${i + 1}`,
    handle: "+1",
    isFromMe: false,
    date: new Date(1000 + i),
    dateRead: null,
    dateDelivered: null,
    isRead: false,
    isDelivered: false,
    chatId: "c",
    service: "iMessage",
    isReaction: false,
    isReply: false,
    isEdited: false,
    isRetracted: false,
    hasAttachments: false,
  }));
}

describe("boundMessagesIfNeeded", () => {
  it("returns unchanged when under the hard cap", () => {
    const msgs = fakeMsgs(100);
    const result = boundMessagesIfNeeded(msgs, 50, []);
    expect(result.messages).toHaveLength(100);
    expect(result.selectedMsgIdx).toBe(50);
    expect(result.gapMarkers).toHaveLength(0);
  });

  it("evicts middle when over the hard cap", () => {
    // 6000 > default 5000 cap. Cursor at index 100 (deep in history).
    const msgs = fakeMsgs(6000);
    const result = boundMessagesIfNeeded(msgs, 100, []);
    // Should keep: window around cursor (100±300 = 0..400) + last 200 (5800..5999)
    expect(result.messages.length).toBeLessThan(msgs.length);
    expect(result.messages.length).toBeGreaterThanOrEqual(401 + 200); // window + anchor
    // Should produce exactly one gap marker between the two kept ranges
    expect(result.gapMarkers).toHaveLength(1);
    expect(result.gapMarkers[0].count).toBeGreaterThan(0);
  });

  it("preserves cursor logical position after eviction", () => {
    const msgs = fakeMsgs(6000);
    // Cursor at message id 101 (originally index 100)
    const result = boundMessagesIfNeeded(msgs, 100, []);
    expect(result.selectedMsgIdx).toBeGreaterThanOrEqual(0);
    // The message at the new cursor index should be the same logical message
    expect(result.messages[result.selectedMsgIdx].id).toBe(101);
  });

  it("preserves the most-recent anchor (last 200 messages always kept)", () => {
    const msgs = fakeMsgs(6000);
    const result = boundMessagesIfNeeded(msgs, 100, []);
    // The last message (id 6000) should still be present
    const lastMsg = result.messages[result.messages.length - 1];
    expect(lastMsg.id).toBe(6000);
    // And the message 200 from the end (id 5801) too
    expect(result.messages.some((m) => m.id === 5801)).toBe(true);
  });

  it("merges overlapping kept ranges into one (cursor near anchor)", () => {
    // Cursor at index 5900 (inside anchor zone) → no gap
    const msgs = fakeMsgs(6000);
    const result = boundMessagesIfNeeded(msgs, 5900, []);
    expect(result.gapMarkers).toHaveLength(0);
    // Kept range = [5600..5999] (cursor window) merged with [5800..5999] (anchor) = [5600..5999]
    expect(result.messages[0].id).toBe(5601);
  });

  it("gap marker IDs bracket the evicted region", () => {
    const msgs = fakeMsgs(6000);
    const result = boundMessagesIfNeeded(msgs, 100, []);
    const gap = result.gapMarkers[0];
    // The gap should start AFTER the kept window (last id at idx 400 = msg id 401)
    // and end BEFORE the anchor (first anchor id at idx 5800 = msg id 5801).
    expect(gap.oldestId).toBeGreaterThan(401);
    expect(gap.newestId).toBeLessThan(5801);
    expect(gap.newestId).toBeGreaterThanOrEqual(gap.oldestId);
  });

  it("places the gap atIdx where the renderer should show the placeholder", () => {
    const msgs = fakeMsgs(6000);
    const result = boundMessagesIfNeeded(msgs, 100, []);
    const gap = result.gapMarkers[0];
    // atIdx should equal the size of the first kept range (cursor window)
    // = 401 messages (indices 0..400)
    expect(gap.atIdx).toBe(401);
  });
});

/**
 * The load-older cursor after an evicting prepend (found 2026-08-16 while
 * verifying the eviction path the swarm could never reach).
 *
 * PREPEND_MESSAGES used to set `messageOldestLoadedId` to the FETCHED batch's
 * oldest id unconditionally. When bounding evicted the head of that batch, the
 * state then claimed history was loaded further back than the array held — the
 * next load-older paged from BELOW the evicted rows, skipping them forever and
 * reporting false exhaustion with a silent hole where they were. The cursor
 * must describe what SURVIVED.
 */
describe("PREPEND_MESSAGES load-older cursor vs eviction", () => {
  function prependState(existing: number, cursorIdx: number) {
    return { ...initialState, messages: fakeMsgs(existing), selectedMsgIdx: cursorIdx };
  }

  it("keeps the fetched cursor when nothing was evicted", () => {
    let s = prependState(100, 99);
    // Offset ids so the prepended batch is genuinely older (lower date).
    const older = fakeMsgs(50).map((m, i) => ({ ...m, id: 5000 + i, date: new Date(i) }));
    s = reducer(s, { type: "PREPEND_MESSAGES", data: older, oldestId: 5000 });
    expect(s.messages.length).toBe(150); // under the cap — no eviction
    expect(s.messageOldestLoadedId).toBe(5000);
  });

  it("moves the cursor to the oldest SURVIVOR when the head was evicted", () => {
    // 200 existing + 5900 older = 6100, over the 5000 cap with the cursor at
    // the tail — the head of the fetched batch gets evicted.
    let s = prependState(200, 199);
    const older = Array.from({ length: 5900 }, (_, i) => ({
      ...fakeMsgs(1)[0],
      id: 10_000 + i,
      guid: `old-${i}`,
      date: new Date(i), // all older than the existing msgs (dates 1000+)
    }));
    s = reducer(s, { type: "PREPEND_MESSAGES", data: older, oldestId: 10_000 });

    expect(s.messages.length).toBeLessThan(6100); // eviction happened
    const survivingOldest = s.messages[0];
    // The cursor must point at what the array actually holds — never below it.
    expect(s.messageOldestLoadedId).toBe(survivingOldest.id);
    // Regression shape: the old behaviour left the fetched batch's oldest.
    expect(s.messageOldestLoadedId).not.toBe(10_000);
  });

  it("preserves the -1 exhaustion sentinel on an empty prepend", () => {
    let s = prependState(50, 0);
    s = reducer(s, { type: "PREPEND_MESSAGES", data: [], oldestId: -1 });
    expect(s.messageOldestLoadedId).toBe(-1);
  });
});
