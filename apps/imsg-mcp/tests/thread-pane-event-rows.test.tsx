/**
 * Inline group-event rows rendered in the thread pane (#106 follow-up).
 *
 * Cursor-inert invariant: with events present, the same selectedMsgIdx still
 * highlights the same message, and the bottom-anchored window still shows the
 * newest message (events are charged to the window budget, so they must not
 * push the last bubble past the pane edge).
 */
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { ThreadPane } from "../src/tui/components/ThreadPane.js";
import { makeTheme } from "../src/tui/theme.js";
import { ThemeProvider } from "../src/tui/themes/ThemeContext.js";
import type { Conversation, ConversationEvent, Message } from "../src/types.js";

function makeMessage(id: number, dayOffset = 0): Message {
  return {
    id,
    guid: `guid-${id}`,
    text: `marker-${id}`,
    handle: "+15555550002",
    isFromMe: id % 2 === 0,
    date: new Date(Date.UTC(2026, 4, 1 + dayOffset, 12, id % 60)),
    dateRead: null,
    dateDelivered: null,
    isRead: true,
    isDelivered: true,
    chatId: "chat123",
    service: "iMessage",
    isReaction: false,
    isReply: false,
    isEdited: false,
    isRetracted: false,
    hasAttachments: false,
  };
}

function makeEvent(id: number, overrides: Partial<ConversationEvent> = {}): ConversationEvent {
  return {
    id,
    date: new Date(Date.UTC(2026, 4, 1, 13, 0)),
    kind: "member_added",
    actor: "+15550000001",
    actorName: "Alice Smith",
    target: "+15550000002",
    targetName: "Bob Jones",
    newName: null,
    ...overrides,
  };
}

const conversation: Conversation = {
  chatId: "chat123",
  chatIdentifier: "chat123",
  displayName: "Weekend Crew",
  rawIdentifier: "chat123",
  participants: ["+15550000001", "+15550000002", "+15550000003"],
  lastMessageDate: new Date("2026-05-02T12:00:00Z"),
  lastMessageSnippet: null,
  unreadCount: 0,
  threadSlug: "weekend-crew~imsg~aaaa",
  isGroupChat: true,
  serviceType: "iMessage",
};

function renderPane(messages: Message[], events: ConversationEvent[], selectedMsgIdx = -1) {
  const { lastFrame, unmount } = render(
    <ThemeProvider value={makeTheme()}>
      <ThreadPane
        conversation={conversation}
        messages={messages}
        pending={[]}
        resolvedNames={[]}
        scrollOffset={0}
        selectedMsgIdx={selectedMsgIdx}
        selectionAnchor={null}
        gapMarkers={[]}
        events={events}
        focused={true}
        width={90}
        height={20}
        mode="normal"
        onChangeCompose={() => {}}
        onSubmitCompose={() => {}}
      />
    </ThemeProvider>,
  );
  const frame = lastFrame() ?? "";
  unmount();
  return frame;
}

describe("ThreadPane inline group-event rows", () => {
  it("renders an event between the messages its ROWID falls between", () => {
    const messages = [makeMessage(100), makeMessage(200)];
    const frame = renderPane(messages, [makeEvent(150)]);
    expect(frame).toContain("Alice added Bob");
    const a = frame.indexOf("marker-100");
    const b = frame.indexOf("Alice added Bob");
    const c = frame.indexOf("marker-200");
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });

  it("renders a tail event after the newest message (rename as latest activity)", () => {
    const messages = [makeMessage(100), makeMessage(200)];
    const frame = renderPane(messages, [
      makeEvent(300, { kind: "renamed", newName: "New Crew", actor: null, target: null }),
    ]);
    expect(frame.indexOf("renamed to")).toBeGreaterThan(frame.indexOf("marker-200"));
    expect(frame).toContain("You renamed to");
  });

  it("bottom anchor still shows the newest message with events charged to the budget", () => {
    const messages = Array.from({ length: 30 }, (_, i) => makeMessage(100 + i));
    const events = [makeEvent(125), makeEvent(126), makeEvent(127)];
    const frame = renderPane(messages, events);
    expect(frame).toContain(`marker-${100 + 29}`);
  });

  it("cursor stays on the same message when events are present (cursor-inert)", () => {
    const messages = [makeMessage(100), makeMessage(200), makeMessage(300)];
    const withEvents = renderPane(messages, [makeEvent(150), makeEvent(250)], 1);
    const without = renderPane(messages, [], 1);
    // The selected row shows its ABSOLUTE index as the line number in both.
    expect(withEvents).toContain("marker-200");
    expect(without).toContain("marker-200");
    // Same absolute line number for the cursor row — events shifted nothing.
    const numOf = (frame: string) =>
      frame
        .split("\n")
        .find((l) => l.includes("marker-200"))
        ?.trimStart()
        .slice(0, 3);
    expect(numOf(withEvents)).toEqual(numOf(without));
  });

  it("groups only in practice, but an empty events array renders nothing extra", () => {
    const frame = renderPane([makeMessage(100)], []);
    expect(frame).not.toContain("added");
  });
});
