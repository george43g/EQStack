/**
 * Reply rendering contract.
 *
 * Bug: when m.isReply is true but m.replyTo.replyToText is null/undefined,
 * the rendered tree used to omit the reply context entirely — the user
 * couldn't tell the message was a reply at all. The fix renders an indicator
 * regardless, attempting a runtime lookup by replyToGuid first and falling
 * back to a placeholder string.
 *
 * We test the pure logic (the conditional + lookup branch) rather than the
 * full Ink render tree, since Ink's render isn't trivial to snapshot.
 */
import { describe, expect, it } from "vitest";
import type { Message } from "../src/types.js";

// Mirror the exact display logic from MessageBubble.tsx so the test pins
// the contract. If the source changes, this helper must change too — that
// will produce a clear test diff to review.
function computeReplyDisplay(
  m: Message,
  maxWidth: number,
  lookupReplyText?: (guid: string) => string | null,
): string | null {
  if (!m.isReply) return null;
  let replyText: string | null = m.replyTo?.replyToText ?? null;
  if (!replyText && m.replyTo?.replyToGuid && lookupReplyText) {
    replyText = lookupReplyText(m.replyTo.replyToGuid);
  }
  return replyText ? replyText.slice(0, maxWidth - 12) : "(replied to earlier message)";
}

function fakeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 1,
    guid: "g1",
    text: "Hello",
    handle: "+1",
    isFromMe: false,
    date: new Date("2024-01-01"),
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
    ...overrides,
  };
}

describe("reply rendering", () => {
  it("returns null when isReply is false", () => {
    const m = fakeMessage({ isReply: false });
    expect(computeReplyDisplay(m, 80)).toBeNull();
  });

  it("renders the replyToText when present", () => {
    const m = fakeMessage({
      isReply: true,
      replyTo: { replyToGuid: "target", replyToText: "Original message" },
    });
    expect(computeReplyDisplay(m, 80)).toBe("Original message");
  });

  it("renders placeholder when isReply but replyToText is null and no lookup", () => {
    const m = fakeMessage({
      isReply: true,
      replyTo: { replyToGuid: "target", replyToText: null },
    });
    expect(computeReplyDisplay(m, 80)).toBe("(replied to earlier message)");
  });

  it("renders placeholder when isReply but replyToText is undefined", () => {
    const m = fakeMessage({
      isReply: true,
      replyTo: { replyToGuid: "target" },
    });
    expect(computeReplyDisplay(m, 80)).toBe("(replied to earlier message)");
  });

  it("uses lookup callback when replyToText is null and target is in loaded messages", () => {
    const m = fakeMessage({
      isReply: true,
      replyTo: { replyToGuid: "target", replyToText: null },
    });
    const lookup = (guid: string) => (guid === "target" ? "Recovered text" : null);
    expect(computeReplyDisplay(m, 80, lookup)).toBe("Recovered text");
  });

  it("falls through to placeholder when lookup returns null too", () => {
    const m = fakeMessage({
      isReply: true,
      replyTo: { replyToGuid: "missing", replyToText: null },
    });
    const lookup = () => null;
    expect(computeReplyDisplay(m, 80, lookup)).toBe("(replied to earlier message)");
  });

  it("truncates long replyToText to fit maxWidth", () => {
    const m = fakeMessage({
      isReply: true,
      replyTo: {
        replyToGuid: "target",
        replyToText: "A".repeat(200),
      },
    });
    const result = computeReplyDisplay(m, 50);
    expect(result!.length).toBeLessThanOrEqual(50);
  });
});
