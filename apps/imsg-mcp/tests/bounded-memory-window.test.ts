/**
 * Bounded message window: when the in-memory message array grows past the
 * hard cap, the middle is evicted but the most-recent ANCHOR_KEEP and the
 * cursor's window are preserved. The eviction is recorded as gap markers
 * so the UI can show "N more messages" placeholders.
 */
import { describe, expect, it } from "vitest";
import { boundMessagesIfNeeded } from "../src/tui/types.js";
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
