/**
 * Stage 4 — MessageBubble voice-note interpretation rendering.
 * Renders with ink-testing-library and asserts on the frame text.
 */
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { MessageBubble } from "../src/tui/components/MessageBubble.js";
import { makeTheme } from "../src/tui/theme.js";
import { ThemeProvider } from "../src/tui/themes/ThemeContext.js";
import type { Attachment, Message } from "../src/types.js";

function fakeMessage(over: Partial<Message> = {}): Message {
  return {
    id: 1,
    guid: "g1",
    text: null,
    handle: "+15551234567",
    displayName: "Alex",
    isFromMe: false,
    date: new Date("2024-01-15T10:00:00Z"),
    dateRead: null,
    dateDelivered: null,
    isRead: true,
    isDelivered: true,
    chatId: "c1",
    service: "iMessage",
    isReaction: false,
    isReply: false,
    isEdited: false,
    isRetracted: false,
    hasAttachments: false,
    ...over,
  };
}

const audioAtt: Attachment = {
  rowId: 9,
  filename: "~/Library/Messages/Attachments/x/vm.caf",
  mimeType: "audio/x-caf",
  transferName: "vm.caf",
  totalBytes: 4096,
};

function renderBubble(message: Message) {
  return render(
    <ThemeProvider value={makeTheme()}>
      <MessageBubble message={message} maxWidth={70} isFirstInGroup />
    </ThemeProvider>,
  );
}

describe("MessageBubble — voice-note interpretation", () => {
  it("renders the resolved transcript when interpretedMedia is present", () => {
    const { lastFrame, unmount } = renderBubble(
      fakeMessage({
        hasAttachments: true,
        attachments: [audioAtt],
        interpretedMedia: { kind: "audio", text: "call me back when you can", source: "apple" },
      }),
    );
    expect(lastFrame() ?? "").toContain("call me back when you can");
    unmount();
  });

  it("shows an R-to-transcribe hint for an uninterpreted voice note", () => {
    const { lastFrame, unmount } = renderBubble(
      fakeMessage({ hasAttachments: true, attachments: [audioAtt] }),
    );
    expect(lastFrame() ?? "").toMatch(/R to transcribe/);
    unmount();
  });

  it("renders no voice-note row for a plain text message", () => {
    const { lastFrame, unmount } = renderBubble(fakeMessage({ text: "hello there" }));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("hello there");
    expect(frame).not.toMatch(/transcribe/);
    unmount();
  });

  it("labels an image caption row", () => {
    const { lastFrame, unmount } = renderBubble(
      fakeMessage({
        text: "look",
        hasAttachments: true,
        interpretedMedia: { kind: "image", text: "a golden retriever", source: "provider:or" },
      }),
    );
    expect(lastFrame() ?? "").toContain("a golden retriever");
    unmount();
  });
});
