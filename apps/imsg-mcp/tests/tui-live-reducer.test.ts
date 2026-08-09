/**
 * Reducer semantics for the live change stream (PR: live TUI updates).
 *
 *  - APPEND_LIVE_MESSAGES: dedupe by ROWID and guid (post-send confirm poll
 *    and lazy loads race the stream), tail-follow only when the cursor is on
 *    the tail (no view jump while scrolled up), optimistic-pending resolution.
 *  - APPLY_LIVE_REACTIONS: fold tapbacks onto their target message with the
 *    DB layer's consolidation semantics (removals delete, re-adds replace).
 *  - TOUCH_CONVERSATIONS: in-place sidebar patch — snippet/date/unread, no
 *    reordering under the user's cursor.
 */

import { describe, expect, it } from "vitest";
import { type AppState, applyLiveReactions, initialState, reducer } from "../src/tui/types.js";
import type { Conversation, Message, Reaction } from "../src/types.js";

function makeMessage(id: number, text: string, overrides: Partial<Message> = {}): Message {
  return {
    id,
    guid: `guid-${id}`,
    text,
    handle: "+15550000131",
    isFromMe: false,
    date: new Date(2026, 0, 1, 0, id),
    dateRead: null,
    dateDelivered: null,
    isRead: false,
    isDelivered: true,
    chatId: "+15550000131",
    service: "iMessage",
    isReaction: false,
    isReply: false,
    isEdited: false,
    isRetracted: false,
    hasAttachments: false,
    ...overrides,
  } as Message;
}

function makeConversation(slug: string, overrides: Partial<Conversation> = {}): Conversation {
  return {
    chatId: `iMessage;-;${slug}`,
    chatIdentifier: `+1555${slug}`,
    displayName: slug,
    rawIdentifier: `+1555${slug}`,
    participants: [`+1555${slug}`],
    lastMessageDate: new Date(2026, 0, 1),
    lastMessageSnippet: "old snippet",
    unreadCount: 2,
    threadSlug: slug,
    isGroupChat: false,
    serviceType: "iMessage",
    ...overrides,
  };
}

function stateWith(overrides: Partial<AppState>): AppState {
  return { ...initialState, loading: false, status: "", ...overrides };
}

describe("APPEND_LIVE_MESSAGES", () => {
  it("appends new messages and follows the tail when the cursor is on it", () => {
    const messages = [makeMessage(1, "a"), makeMessage(2, "b")];
    const state = stateWith({ messages, selectedMsgIdx: 1, threadScroll: 2 });
    const next = reducer(state, { type: "APPEND_LIVE_MESSAGES", data: [makeMessage(3, "c")] });
    expect(next.messages.map((m) => m.id)).toEqual([1, 2, 3]);
    expect(next.selectedMsgIdx).toBe(2); // followed the tail
    expect(next.threadScroll).toBe(3);
  });

  it("does NOT move the cursor when the user is scrolled up", () => {
    const messages = [makeMessage(1, "a"), makeMessage(2, "b"), makeMessage(3, "c")];
    const state = stateWith({ messages, selectedMsgIdx: 0, threadScroll: 0 });
    const next = reducer(state, { type: "APPEND_LIVE_MESSAGES", data: [makeMessage(4, "d")] });
    expect(next.messages).toHaveLength(4);
    expect(next.selectedMsgIdx).toBe(0); // anchor preserved — no view jump
    expect(next.threadScroll).toBe(0);
  });

  it("dedupes by ROWID and by guid — the same guid twice appends once", () => {
    const state = stateWith({ messages: [makeMessage(1, "a")], selectedMsgIdx: 0 });
    const live = makeMessage(50, "live");
    const once = reducer(state, { type: "APPEND_LIVE_MESSAGES", data: [live] });
    expect(once.messages).toHaveLength(2);

    // Same event delivered again (stream vs poll race) — no growth.
    const twice = reducer(once, { type: "APPEND_LIVE_MESSAGES", data: [live] });
    expect(twice).toBe(once); // zero fresh rows -> same state reference

    // Same guid under a different ROWID (confirm-poll re-read) — still once.
    const sameGuid = makeMessage(51, "live", { guid: live.guid });
    const third = reducer(once, { type: "APPEND_LIVE_MESSAGES", data: [sameGuid] });
    expect(third.messages.filter((m) => m.guid === live.guid)).toHaveLength(1);
  });

  it("resolves a matching optimistic pending bubble for from-me rows", () => {
    const state = stateWith({
      messages: [makeMessage(1, "a")],
      selectedMsgIdx: 0,
      pending: [{ text: "hello there", sentAt: new Date(), status: "sending" }],
    });
    const echoed = makeMessage(2, "hello there", { isFromMe: true });
    const next = reducer(state, { type: "APPEND_LIVE_MESSAGES", data: [echoed] });
    expect(next.pending).toHaveLength(0);
    expect(next.messages).toHaveLength(2);
  });

  it("seeds messageOldestLoadedId when the thread had none loaded", () => {
    const state = stateWith({ messages: [], selectedMsgIdx: -1, messageOldestLoadedId: null });
    const next = reducer(state, { type: "APPEND_LIVE_MESSAGES", data: [makeMessage(7, "x")] });
    expect(next.messageOldestLoadedId).toBe(7);
    expect(next.selectedMsgIdx).toBe(0);
  });
});

describe("APPLY_LIVE_REACTIONS / applyLiveReactions", () => {
  const reaction = (overrides: Partial<Reaction> = {}): Reaction => ({
    type: "love",
    fromHandle: "+15550000131",
    isRemoval: false,
    targetMessageGuid: "guid-1",
    targetMessagePart: 0,
    ...overrides,
  });

  it("folds a tapback onto its target message by guid", () => {
    const state = stateWith({ messages: [makeMessage(1, "a"), makeMessage(2, "b")] });
    const next = reducer(state, { type: "APPLY_LIVE_REACTIONS", reactions: [reaction()] });
    expect(next.messages[0].reactions).toHaveLength(1);
    expect(next.messages[0].reactions?.[0].type).toBe("love");
    expect(next.messages[1].reactions).toBeUndefined();
  });

  it("re-adding the same sender+type replaces instead of duplicating", () => {
    const msgs = applyLiveReactions(applyLiveReactions([makeMessage(1, "a")], [reaction()]), [
      reaction(),
    ]);
    expect(msgs[0].reactions).toHaveLength(1);
  });

  it("a removal deletes the matching reaction", () => {
    const withReaction = applyLiveReactions([makeMessage(1, "a")], [reaction()]);
    const removed = applyLiveReactions(withReaction, [reaction({ isRemoval: true })]);
    expect(removed[0].reactions).toBeUndefined();
  });

  it("returns the same state when no target message is present", () => {
    const state = stateWith({ messages: [makeMessage(9, "z")] });
    const next = reducer(state, {
      type: "APPLY_LIVE_REACTIONS",
      reactions: [reaction({ targetMessageGuid: "guid-404" })],
    });
    expect(next).toBe(state);
  });
});

describe("TOUCH_CONVERSATIONS", () => {
  it("patches snippet, date, and unread in place without reordering", () => {
    const conversations = [makeConversation("alice"), makeConversation("bob")];
    const state = stateWith({ conversations });
    const when = new Date(2026, 5, 1);
    const next = reducer(state, {
      type: "TOUCH_CONVERSATIONS",
      touches: [{ threadSlug: "bob", snippet: "fresh", lastMessageDate: when, unreadDelta: 2 }],
    });
    // Order preserved — no yanking rows under the cursor.
    expect(next.conversations.map((c) => c.threadSlug)).toEqual(["alice", "bob"]);
    expect(next.conversations[1].lastMessageSnippet).toBe("fresh");
    expect(next.conversations[1].lastMessageDate).toBe(when);
    expect(next.conversations[1].unreadCount).toBe(4); // 2 + 2
    // Untouched row is the SAME object (no spurious re-render churn).
    expect(next.conversations[0]).toBe(conversations[0]);
  });

  it("null snippet keeps the row's current one", () => {
    const state = stateWith({ conversations: [makeConversation("alice")] });
    const next = reducer(state, {
      type: "TOUCH_CONVERSATIONS",
      touches: [
        { threadSlug: "alice", snippet: null, lastMessageDate: new Date(), unreadDelta: 1 },
      ],
    });
    expect(next.conversations[0].lastMessageSnippet).toBe("old snippet");
    expect(next.conversations[0].unreadCount).toBe(3);
  });

  it("unknown slugs leave the state untouched (same reference)", () => {
    const state = stateWith({ conversations: [makeConversation("alice")] });
    const next = reducer(state, {
      type: "TOUCH_CONVERSATIONS",
      touches: [{ threadSlug: "ghost", snippet: "x", lastMessageDate: new Date(), unreadDelta: 1 }],
    });
    expect(next).toBe(state);
  });
});
