import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { ThreadPane } from "../src/tui/components/ThreadPane.js";
import { makeTheme } from "../src/tui/theme.js";
import { ThemeProvider } from "../src/tui/themes/ThemeContext.js";
import type { Conversation, Message } from "../src/types.js";

function makeMessage(id: number, text: string, isFromMe = false): Message {
  return {
    id,
    guid: `guid-${id}`,
    text,
    handle: isFromMe ? "+15555550001" : "+15555550002",
    isFromMe,
    date: new Date(`2026-05-${String(id + 1).padStart(2, "0")}T12:00:00Z`),
    dateRead: null,
    dateDelivered: null,
    isRead: true,
    isDelivered: true,
    chatId: "iMessage;-;+15555550002",
    service: "iMessage",
    isReaction: false,
    isReply: false,
    isEdited: false,
    isRetracted: false,
    hasAttachments: false,
  };
}

const conversation: Conversation = {
  chatId: "iMessage;-;+15555550002",
  chatIdentifier: "+15555550002",
  displayName: "Kayla",
  rawIdentifier: "+15555550002",
  participants: ["+15555550002"],
  lastMessageDate: new Date("2026-05-15T12:00:00Z"),
  lastMessageSnippet: null,
  unreadCount: 0,
  threadSlug: "kayla~imsg~aaaa",
  isGroupChat: false,
  serviceType: "iMessage",
};

function makeMessages(count: number): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < count; i++) {
    // Each message has a unique marker. Short enough to fit even when truncated.
    out.push(makeMessage(i, `m${i}!`, i % 2 === 0));
  }
  return out;
}

describe("ThreadPane bottom-anchor (last-message clip regression)", () => {
  it("shows the last message marker when cursor is at end of a long thread", () => {
    const theme = makeTheme();
    const messages = makeMessages(25);
    const lastMarker = `m${messages.length - 1}!`;

    const { lastFrame, unmount } = render(
      <ThemeProvider value={theme}>
        <ThreadPane
          conversation={conversation}
          messages={messages}
          pending={[]}
          resolvedNames={[]}
          scrollOffset={0}
          selectedMsgIdx={messages.length - 1}
          selectionAnchor={null}
          gapMarkers={[]}
          focused={true}
          width={80}
          height={15}
          mode="normal"
          onChangeCompose={() => {}}
          onSubmitCompose={() => {}}
        />
      </ThemeProvider>,
    );

    const frame = lastFrame() ?? "";
    // The last message MUST be in the rendered frame. Before the bottom-anchor
    // fix, viewport math left the last 1-3 messages past Ink's overflow="hidden"
    // and they were silently clipped.
    expect(frame).toContain(lastMarker);

    // Older messages near the start of the thread should NOT be visible —
    // proves the viewport is anchored near the bottom, not just rendering
    // everything past the height bound.
    expect(frame).not.toContain("m0!");

    unmount();
  });

  it("shows the last message even when prior messages are tall (date separators)", () => {
    const theme = makeTheme();
    // Date separators are inserted whenever the previous message is on a
    // different day. Each makeMessage uses a different day, so every message
    // gets a date separator above it — making bubbles ~2 rows tall.
    const messages = makeMessages(12);
    const lastMarker = `m${messages.length - 1}!`;

    const { lastFrame, unmount } = render(
      <ThemeProvider value={theme}>
        <ThreadPane
          conversation={conversation}
          messages={messages}
          pending={[]}
          resolvedNames={[]}
          scrollOffset={0}
          selectedMsgIdx={messages.length - 1}
          selectionAnchor={null}
          gapMarkers={[]}
          focused={true}
          width={80}
          height={12}
          mode="normal"
          onChangeCompose={() => {}}
          onSubmitCompose={() => {}}
        />
      </ThemeProvider>,
    );

    expect(lastFrame() ?? "").toContain(lastMarker);
    unmount();
  });

  it("still anchors on cursor when in the middle of the thread", () => {
    const theme = makeTheme();
    const messages = makeMessages(25);
    const cursorIdx = 10;

    const { lastFrame, unmount } = render(
      <ThemeProvider value={theme}>
        <ThreadPane
          conversation={conversation}
          messages={messages}
          pending={[]}
          resolvedNames={[]}
          scrollOffset={0}
          selectedMsgIdx={cursorIdx}
          selectionAnchor={null}
          gapMarkers={[]}
          focused={true}
          width={80}
          height={15}
          mode="normal"
          onChangeCompose={() => {}}
          onSubmitCompose={() => {}}
        />
      </ThemeProvider>,
    );

    const frame = lastFrame() ?? "";
    // The cursor message must be visible.
    expect(frame).toContain(`m${cursorIdx}!`);
    // The last message (m24!) should NOT be visible — cursor anchor still wins
    // for mid-thread positions.
    expect(frame).not.toContain(`m${messages.length - 1}!`);
    unmount();
  });
});
