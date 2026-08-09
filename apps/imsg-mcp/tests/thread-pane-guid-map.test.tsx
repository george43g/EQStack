import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { ThreadPane } from "../src/tui/components/ThreadPane.js";
import { makeTheme } from "../src/tui/theme.js";
import { ThemeProvider } from "../src/tui/themes/ThemeContext.js";
import type { Conversation, Message } from "../src/types.js";

function makeMessage(id: number, text: string, replyToGuid?: string): Message {
  return {
    id,
    guid: `guid-${id}`,
    text,
    handle: "+15555550002",
    isFromMe: false,
    // Same day for every message — date separators would eat viewport rows.
    date: new Date(`2026-05-01T12:${String(id).padStart(2, "0")}:00Z`),
    dateRead: null,
    dateDelivered: null,
    isRead: true,
    isDelivered: true,
    chatId: "iMessage;-;+15555550002",
    service: "iMessage",
    isReaction: false,
    isReply: replyToGuid !== undefined,
    isEdited: false,
    isRetracted: false,
    hasAttachments: false,
    // replyToText deliberately missing — forces the guid-map runtime lookup.
    ...(replyToGuid !== undefined && { replyTo: { replyToGuid } }),
  };
}

const conversation: Conversation = {
  chatId: "iMessage;-;+15555550002",
  chatIdentifier: "+15555550002",
  displayName: "Kayla",
  rawIdentifier: "+15555550002",
  participants: ["+15555550002"],
  lastMessageDate: new Date("2026-05-01T12:00:00Z"),
  lastMessageSnippet: null,
  unreadCount: 0,
  threadSlug: "kayla~imsg~aaaa",
  isGroupChat: false,
  serviceType: "iMessage",
};

function paneElement(messages: Message[]) {
  const theme = makeTheme();
  return (
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
        height={20}
        mode="normal"
        onChangeCompose={() => {}}
        onSubmitCompose={() => {}}
      />
    </ThemeProvider>
  );
}

describe("ThreadPane guid map (incremental reply-lookup regression)", () => {
  it("resolves a reply's missing text from the loaded message set", () => {
    const messages = [makeMessage(0, "orig-target!"), makeMessage(1, "a reply", "guid-0")];
    const { lastFrame, unmount } = render(paneElement(messages));

    expect(lastFrame() ?? "").toContain("↩ orig-target!");
    unmount();
  });

  it("append keeps lookups working for both old and new messages", () => {
    const initial = [makeMessage(0, "orig-target!"), makeMessage(1, "a reply", "guid-0")];
    const { lastFrame, rerender, unmount } = render(paneElement(initial));
    expect(lastFrame() ?? "").toContain("↩ orig-target!");

    // Poller-style append: same items, new tail — the map must gain the new
    // entries without losing the old ones.
    const appended = [
      ...initial,
      makeMessage(2, "new-target!"),
      makeMessage(3, "reply to new", "guid-2"),
    ];
    rerender(paneElement(appended));

    const frame = lastFrame() ?? "";
    expect(frame).toContain("↩ new-target!"); // new tail entry added
    expect(frame).toContain("↩ orig-target!"); // old entry preserved
    unmount();
  });

  it("a prepend/reset still resolves correctly (full rebuild path)", () => {
    // The reply targets guid-4, which is NOT loaded yet — the lookup misses
    // and MessageBubble renders its placeholder.
    const initial = [makeMessage(5, "middle msg"), makeMessage(6, "reply to older", "guid-4")];
    const { lastFrame, rerender, unmount } = render(paneElement(initial));
    expect(lastFrame() ?? "").toContain("(replied to earlier message)");

    // loadOlderMessages-style prepend replaces the array with a new head —
    // the append fast-path must NOT fire; a full rebuild picks up guid-4.
    const prepended = [makeMessage(4, "older-target!"), ...initial];
    rerender(paneElement(prepended));

    expect(lastFrame() ?? "").toContain("↩ older-target!");
    unmount();
  });
});
