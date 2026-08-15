/**
 * Eviction placeholder rendering (swarm finding: "eviction path unverified").
 *
 * When loaded history crosses `IMSG_TUI_MSG_HARD_CAP` the reducer evicts the
 * middle of the array and records a gap marker, so the user is told history is
 * missing rather than silently shown a discontinuity. `boundMessagesIfNeeded`
 * is well covered by bounded-memory-window.test.ts — the RENDER was not, and
 * during the swarm drive no UI path ever reached it, so the placeholder had
 * never actually been seen.
 *
 * It is harder to reach by hand than it looks: after a prepend the cursor
 * tracks the same logical message, so the kept regions (cursor ±300 and the
 * last 200) OVERLAP and keep everything until the total exceeds roughly
 * cursor + 500. Driving the real TUI with the cap lowered to 400 loaded 601
 * messages and still evicted nothing — correctly. Hence a component test.
 */
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { ThreadPane } from "../src/tui/components/ThreadPane.js";
import { makeTheme } from "../src/tui/theme.js";
import { ThemeProvider } from "../src/tui/themes/ThemeContext.js";
import type { Conversation, Message } from "../src/types.js";

const conversation: Conversation = {
  chatId: "iMessage;-;+15550001111",
  chatIdentifier: "+15550001111",
  displayName: "Someone",
  rawIdentifier: "+15550001111",
  participants: ["+15550001111"],
  lastMessageDate: new Date("2026-05-10T12:00:00Z"),
  lastMessageSnippet: null,
  unreadCount: 0,
  threadSlug: "someone~imsg~a1b2",
  isGroupChat: false,
  serviceType: "iMessage",
};

function msg(id: number): Message {
  return {
    id,
    guid: `g-${id}`,
    text: `message ${id}`,
    handle: "+15550001111",
    isFromMe: false,
    // Same day for every message so date separators don't crowd the output.
    date: new Date(Date.UTC(2026, 4, 10, 12, 0, id % 60)),
    dateRead: null,
    dateDelivered: null,
    isRead: true,
    isDelivered: true,
    chatId: "iMessage;-;+15550001111",
    service: "iMessage",
    isReaction: false,
    isReply: false,
    isEdited: false,
    isRetracted: false,
    hasAttachments: false,
  } as unknown as Message;
}

function draw(
  messages: Message[],
  gapMarkers: Array<{ atIdx: number; oldestId: number; newestId: number; count: number }>,
  selectedMsgIdx = 0,
) {
  return render(
    <ThemeProvider value={makeTheme({ preset: "safe" })}>
      <ThreadPane
        conversation={conversation}
        messages={messages}
        pending={[]}
        resolvedNames={["Someone"]}
        scrollOffset={0}
        selectedMsgIdx={selectedMsgIdx}
        selectionAnchor={null}
        gapMarkers={gapMarkers}
        focused={true}
        width={80}
        height={24}
        mode="browse"
        onChangeCompose={() => {}}
        onSubmitCompose={() => {}}
      />
    </ThemeProvider>,
  );
}

describe("eviction gap placeholder", () => {
  const messages = Array.from({ length: 12 }, (_, i) => msg(i + 1));

  it("tells the user history was evicted, with the count", () => {
    const { lastFrame } = draw(messages, [{ atIdx: 3, oldestId: 100, newestId: 400, count: 1234 }]);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("older messages evicted");
    // Thousands separator — a raw "1234" in a wall of ids is easy to misread.
    expect(frame).toContain("1,234");
  });

  it("says how to get the history back, not just that it's gone", () => {
    const { lastFrame } = draw(messages, [{ atIdx: 3, oldestId: 1, newestId: 2, count: 5 }]);
    expect(lastFrame()).toContain("scroll back to reload");
  });

  it("renders nothing when there are no gaps — the overwhelmingly common case", () => {
    const { lastFrame } = draw(messages, []);
    expect(lastFrame()).not.toContain("evicted");
  });

  it("renders a marker per evicted region", () => {
    const { lastFrame } = draw(messages, [
      { atIdx: 2, oldestId: 1, newestId: 2, count: 7 },
      { atIdx: 6, oldestId: 3, newestId: 4, count: 9 },
    ]);
    const frame = lastFrame() ?? "";
    const markers = frame.split("\n").filter((l) => l.includes("evicted")).length;
    expect(markers).toBe(2);
  });

  it("does not render a marker whose index is outside the visible window", () => {
    // atIdx far beyond the loaded array — a stale marker must not throw or
    // draw a phantom row.
    const { lastFrame } = draw(messages, [{ atIdx: 999, oldestId: 1, newestId: 2, count: 3 }]);
    expect(lastFrame()).not.toContain("evicted");
  });
});
