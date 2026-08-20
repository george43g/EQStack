/**
 * Non-finite pane dimensions must FAIL CLOSED (bounded window), never open.
 *
 * Under ink-testing-library (no TTY), fullscreen-ink's useScreenSize yields
 * non-finite rows; before the guards a NaN line budget reached tui-kit
 * lineWindow 0.5.0, whose break condition (`used + next > NaN`) is always
 * false — the ENTIRE thread rendered. Measured blast: ~65MB of retained
 * React fiber in tui-memory.test and a whole-list render per keystroke. The
 * old hand-rolled walk failed closed by accident; the guards (App screen-size
 * source clamp + ThreadPane budget clamp) make it deliberate. Kit defect
 * reported upstream.
 */
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { ThreadPane } from "../src/tui/components/ThreadPane.js";
import { makeTheme } from "../src/tui/theme.js";
import { ThemeProvider } from "../src/tui/themes/ThemeContext.js";
import type { Conversation, Message } from "../src/types.js";

function makeMessage(id: number): Message {
  return {
    id,
    guid: `guid-${id}`,
    text: `marker-${id}`,
    handle: "+15555550002",
    isFromMe: id % 2 === 0,
    date: new Date(Date.UTC(2026, 4, 1, 0, id)),
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

describe("ThreadPane with non-finite dimensions", () => {
  it("renders a bounded window, not the whole thread", () => {
    const messages = Array.from({ length: 400 }, (_, i) => makeMessage(i));
    const { lastFrame, unmount } = render(
      <ThemeProvider value={makeTheme()}>
        <ThreadPane
          conversation={conversation}
          messages={messages}
          pending={[]}
          resolvedNames={[]}
          scrollOffset={0}
          selectedMsgIdx={-1}
          selectionAnchor={null}
          gapMarkers={[]}
          focused={true}
          width={Number.NaN}
          height={Number.NaN}
          mode="normal"
          onChangeCompose={() => {}}
          onSubmitCompose={() => {}}
        />
      </ThemeProvider>,
    );
    const frame = lastFrame() ?? "";
    unmount();

    // Fail-open renders all 400 markers; the clamped budget fits only a few.
    const rendered = messages.filter((m) => frame.includes(`marker-${m.id}`)).length;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(20);
    // Follow-tail must still hold: the newest message is the one shown.
    expect(frame).toContain("marker-399");
    expect(frame).not.toContain("marker-0 ");
  });
});
