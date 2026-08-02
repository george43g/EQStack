import { describe, expect, it } from "vitest";
import { ensureVisibleScroll, initialState, reducer } from "../src/tui/types.js";
import type { Conversation } from "../src/types.js";

function fakeConversations(n: number): Conversation[] {
  return Array.from({ length: n }, (_, i) => ({
    chatId: `c${i}`,
    chatIdentifier: `chat${i}`,
    displayName: `Chat ${i}`,
    rawIdentifier: `chat${i}`,
    participants: [`chat${i}`],
    lastMessageDate: null,
    lastMessageSnippet: null,
    unreadCount: 0,
    threadSlug: `c${i}`,
    isGroupChat: false,
    serviceType: "iMessage" as const,
  }));
}

describe("ensureVisibleScroll", () => {
  it("keeps cursor in view when below the visible window", () => {
    // 100 items, visible=10, current scroll=0, cursor moved to 15
    const newScroll = ensureVisibleScroll(15, 0, 10, 100);
    // Cursor 15 must be in [newScroll, newScroll+9]
    expect(newScroll).toBeLessThanOrEqual(15);
    expect(newScroll + 9).toBeGreaterThanOrEqual(15);
  });

  it("keeps cursor in view when above the visible window", () => {
    const newScroll = ensureVisibleScroll(5, 50, 10, 100);
    expect(newScroll).toBeLessThanOrEqual(5);
  });

  it("doesn't move when cursor is already in the middle of the visible window", () => {
    // visible window is [10, 19], cursor at 15 — comfortably inside, not within 2-row buffer
    const newScroll = ensureVisibleScroll(15, 10, 10, 100);
    expect(newScroll).toBe(10);
  });

  it("clamps scroll so it never goes negative", () => {
    expect(ensureVisibleScroll(0, 5, 10, 100)).toBeGreaterThanOrEqual(0);
  });

  it("clamps scroll so it doesn't exceed totalCount - visibleCount", () => {
    // 100 items, visible=10. Max scroll should be 90.
    const result = ensureVisibleScroll(99, 50, 10, 100);
    expect(result).toBeLessThanOrEqual(90);
  });

  it("returns 0 for empty list", () => {
    expect(ensureVisibleScroll(0, 0, 10, 0)).toBe(0);
  });
});

describe("SELECT reducer auto-scroll", () => {
  it("scrolls down to keep cursor visible when navigating below the window", () => {
    const state = {
      ...initialState,
      conversations: fakeConversations(50),
      sidebarScroll: 0,
      selectedIdx: 0,
    };
    // Navigate to index 25 with visibleCount=10
    const next = reducer(state, { type: "SELECT", index: 25, visibleCount: 10 });
    // Cursor 25 must be visible: scroll in [25-9, 25] but bounded to ≤ 40
    expect(next.selectedIdx).toBe(25);
    expect(next.sidebarScroll).toBeLessThanOrEqual(25);
    expect(next.sidebarScroll + 9).toBeGreaterThanOrEqual(25);
  });

  it("does NOT change sidebarScroll when visibleCount is omitted (back-compat)", () => {
    const state = {
      ...initialState,
      conversations: fakeConversations(50),
      sidebarScroll: 5,
    };
    const next = reducer(state, { type: "SELECT", index: 25 });
    expect(next.sidebarScroll).toBe(5); // unchanged
    expect(next.selectedIdx).toBe(25);
  });

  it("clamps selectedIdx to valid range", () => {
    const state = {
      ...initialState,
      conversations: fakeConversations(10),
    };
    const next = reducer(state, { type: "SELECT", index: 999, visibleCount: 5 });
    expect(next.selectedIdx).toBe(9);
  });
});

describe("filter resets cursor + scroll (so matches are never sliced out of view)", () => {
  it("ENTER_FILTER zeroes selectedIdx and sidebarScroll", () => {
    const state = {
      ...initialState,
      conversations: fakeConversations(300),
      selectedIdx: 199,
      sidebarScroll: 190,
      selectedModuleIdx: 2,
    };
    const next = reducer(state, { type: "ENTER_FILTER" });
    expect(next.mode).toBe("filter");
    expect(next.selectedIdx).toBe(0);
    expect(next.sidebarScroll).toBe(0);
    expect(next.selectedModuleIdx).toBeNull();
  });

  it("UPDATE_FILTER keeps the top matches in view on every keystroke", () => {
    const state = {
      ...initialState,
      mode: "filter" as const,
      conversations: fakeConversations(300),
      selectedIdx: 199,
      sidebarScroll: 190,
    };
    const next = reducer(state, { type: "UPDATE_FILTER", query: "naomi" });
    expect(next.filterQuery).toBe("naomi");
    expect(next.selectedIdx).toBe(0);
    expect(next.sidebarScroll).toBe(0);
  });
});
