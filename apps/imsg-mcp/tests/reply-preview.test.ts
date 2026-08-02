import { describe, expect, it } from "vitest";
import { formatMessage } from "../src/mcp-format.js";
import { formatReplyPreview, replyKindNoun } from "../src/reply-preview.js";
import type { Message } from "../src/types.js";

describe("formatReplyPreview", () => {
  it("labels a voice note with its transcript", () => {
    expect(
      formatReplyPreview({
        replyToGuid: "g",
        replyToKind: "voice-note",
        replyToText: "see you at 5",
      }),
    ).toBe('voice note: "see you at 5"');
  });

  it("labels a voice note without a transcript", () => {
    expect(
      formatReplyPreview({ replyToGuid: "g", replyToKind: "voice-note", replyToText: null }),
    ).toBe("voice note");
  });

  it("labels image/video/file kinds when there's no text", () => {
    expect(formatReplyPreview({ replyToGuid: "g", replyToKind: "image", replyToText: null })).toBe(
      "image",
    );
    expect(formatReplyPreview({ replyToGuid: "g", replyToKind: "video", replyToText: null })).toBe(
      "video",
    );
    expect(formatReplyPreview({ replyToGuid: "g", replyToKind: "file", replyToText: null })).toBe(
      "file",
    );
  });

  it("returns plain text when present", () => {
    expect(formatReplyPreview({ replyToGuid: "g", replyToText: "hi there" })).toBe("hi there");
  });

  it("uses the fallback text only when the context has none", () => {
    expect(formatReplyPreview({ replyToGuid: "g", replyToText: null }, "looked up")).toBe(
      "looked up",
    );
    expect(formatReplyPreview({ replyToGuid: "g", replyToText: "own" }, "looked up")).toBe("own");
  });

  it("returns null when nothing is known", () => {
    expect(formatReplyPreview({ replyToGuid: "g" })).toBeNull();
    expect(formatReplyPreview(undefined)).toBeNull();
  });

  it("replyKindNoun maps kinds", () => {
    expect(replyKindNoun("voice-note")).toBe("voice note");
    expect(replyKindNoun(undefined)).toBe("message");
  });
});

describe("formatMessage genmoji annotation", () => {
  const base: Message = {
    id: 1,
    guid: "g1",
    text: null,
    handle: "+15550001234",
    isFromMe: false,
    date: new Date("2026-06-01T12:00:00Z"),
    dateRead: null,
    dateDelivered: null,
    isRead: true,
    isDelivered: true,
    chatId: "c",
    service: "iMessage",
    isReaction: false,
    isReply: false,
    isEdited: false,
    isRetracted: false,
    hasAttachments: true,
    attachments: [
      {
        filename: "g.png",
        mimeType: "image/png",
        transferName: null,
        totalBytes: 1,
        emojiDescription: "a smiling cactus",
      },
    ],
  };

  it("surfaces the Apple Genmoji description", () => {
    expect(formatMessage(base)).toContain('[genmoji: "a smiling cactus"]');
  });

  it("omits the tag when no attachment has a description", () => {
    const noEmoji: Message = {
      ...base,
      attachments: [
        { filename: "p.jpg", mimeType: "image/jpeg", transferName: null, totalBytes: 1 },
      ],
    };
    expect(formatMessage(noEmoji)).not.toContain("genmoji");
  });
});
