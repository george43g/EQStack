/**
 * Word-wrap regression tests for the thread pane.
 *
 * Long single-line messages used to render with wrap="truncate" — anything
 * past the pane width was silently replaced with "…" (drawer-only recovery).
 * MessageBubble now wraps the body text and ThreadPane's lineHeight()
 * budgets the wrap rows so the bottom-anchored window stays clip-free.
 */
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
    date: new Date("2026-05-10T12:00:00Z"),
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
  lastMessageDate: new Date("2026-05-10T12:00:00Z"),
  lastMessageSnippet: null,
  unreadCount: 0,
  threadSlug: "kayla~imsg~aaaa",
  isGroupChat: false,
  serviceType: "iMessage",
};

function renderPane(messages: Message[], width = 80, height = 20) {
  const theme = makeTheme();
  return render(
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
        width={width}
        height={height}
        mode="normal"
        onChangeCompose={() => {}}
        onSubmitCompose={() => {}}
      />
    </ThemeProvider>,
  );
}

describe("ThreadPane word wrap", () => {
  it("renders a long single-line message in full across wrapped rows (no … truncation)", () => {
    // ~160 chars — far wider than an 80-col pane. Distinct first and last
    // words prove both ends of the text survived.
    const long =
      "alpha the quick brown fox jumps over the lazy dog again and again while the " +
      "meeting ran long and nobody wrote anything down until the very final omega";
    const { lastFrame, unmount } = renderPane([makeMessage(1, long)]);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("alpha");
    expect(frame).toContain("omega");
    expect(frame).not.toContain("…");
    unmount();
  });

  it("keeps the last message visible when a tall wrapped message precedes it", () => {
    const wall =
      "wallstart " +
      "word ".repeat(120) + // ~600 chars → many wrapped rows at width 80
      "wallend";
    const messages = [makeMessage(1, wall), makeMessage(2, "closing-marker!", true)];
    const { lastFrame, unmount } = renderPane(messages, 80, 14);
    const frame = lastFrame() ?? "";
    // Bottom anchor must still surface the final message even though the
    // previous one now consumes many rows.
    expect(frame).toContain("closing-marker!");
    unmount();
  });

  it("wraps embedded newlines without truncating any line", () => {
    const multi =
      "first-line\nsecond-line is much longer and also should be fully present ok\nthird";
    const { lastFrame, unmount } = renderPane([makeMessage(1, multi)]);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("first-line");
    // Wrap point is width-dependent — assert the words survived, not the layout.
    for (const word of ["second-line", "fully", "present", "ok", "third"]) {
      expect(frame).toContain(word);
    }
    expect(frame).not.toContain("…");
    unmount();
  });
});
