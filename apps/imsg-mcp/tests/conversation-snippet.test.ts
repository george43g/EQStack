import { describe, expect, it } from "vitest";
import {
  isMetadataOnlySnippet,
  normalizeRichMetadataText,
  normalizeSnippetText,
  pickConversationSnippet,
} from "../src/conversation-snippet.js";

describe("conversation snippet selection", () => {
  it("prefers raw message text before parsed or summary fallbacks", () => {
    expect(
      pickConversationSnippet({
        rawText: "Direct text",
        parsedText: "Parsed fallback",
        summaryText: "Summary fallback",
      }),
    ).toBe("Direct text");
  });

  it("falls back to parsed text when the raw text is empty", () => {
    expect(
      pickConversationSnippet({
        rawText: null,
        parsedText: "Parsed fallback",
        summaryText: "Summary fallback",
      }),
    ).toBe("Parsed fallback");
  });

  it("normalizes attachment markers and invalid replacement characters", () => {
    expect(normalizeSnippetText("\uFFFC\uFFFD")).toBe("(image/attachment)");
  });

  it("strips typedstream prefix markers from snippet text", () => {
    expect(normalizeSnippetText("#I'm on my way! Follow my Uber trip:")).toBe(
      "I'm on my way! Follow my Uber trip:",
    );
  });

  it("detects raw URL metadata snippets", () => {
    expect(isMetadataOnlySnippet("$https://trip.uber.com/A6ksBinqE5Fx12WHttpURL/")).toBe(true);
    expect(isMetadataOnlySnippet("I'm on my way! Follow my Uber trip:")).toBe(false);
  });

  it("normalizes URL balloon metadata into a usable URL", () => {
    expect(normalizeRichMetadataText("$https://trip.uber.com/A6ksBinqE5Fx12WHttpURL/")).toBe(
      "https://trip.uber.com/A6ksBinqE5Fx12W",
    );
  });
});
