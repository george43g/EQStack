/**
 * ConversationItem render: emoji-safe truncation.
 *
 * Pre-fix bug: long emoji-prefixed display names like "🎉🎉🎉🎉🎉🎉🎉🎉
 * Birthday Crew" were truncated with `name.slice(0, n)` which counts
 * UTF-16 code units. Half an emoji = lone surrogate = the terminal shows
 * a replacement character (U+FFFD) or a stray box.
 *
 * Post-fix: `truncateToWidth` walks the string with Intl.Segmenter and
 * never splits inside a grapheme cluster.
 */

import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { ConversationItem, truncateSlugForRow } from "../src/tui/components/ConversationItem.js";
import { makeTheme } from "../src/tui/theme.js";
import { ThemeProvider } from "../src/tui/themes/ThemeContext.js";
import type { Conversation } from "../src/types.js";

function mkConvo(displayName: string, overrides: Partial<Conversation> = {}): Conversation {
  return {
    chatIdentifier: "+15555550100",
    threadSlug: "test~imsg~aaaa",
    displayName,
    serviceType: "iMessage",
    isGroupChat: false,
    unreadCount: 0,
    lastMessageDate: new Date("2026-05-29T12:00:00Z"),
    lastMessageSnippet: "hello",
    ...overrides,
  };
}

function mount(c: Conversation, width = 40) {
  return render(
    <ThemeProvider value={makeTheme()}>
      <ConversationItem conversation={c} selected={false} width={width} />
    </ThemeProvider>,
  );
}

describe("ConversationItem — emoji-safe truncation", () => {
  it("never produces a lone surrogate (mid-emoji split) when truncating", () => {
    const c = mkConvo("🎉🎉🎉🎉🎉🎉🎉 Birthday Bash with the entire family and friends");
    const { lastFrame, unmount } = mount(c, 24);
    const frame = lastFrame() ?? "";
    // Scan: no lone surrogate, no replacement character.
    for (let i = 0; i < frame.length; i++) {
      const code = frame.charCodeAt(i);
      if (code === 0xfffd) throw new Error("Frame contains U+FFFD (replacement char)");
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = frame.charCodeAt(i + 1);
        expect(next >= 0xdc00 && next <= 0xdfff).toBe(true);
        i++;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        throw new Error(`Lone low surrogate at ${i}`);
      }
    }
    unmount();
  });

  it("renders short emoji names verbatim", () => {
    const c = mkConvo("🎉Hi");
    const { lastFrame, unmount } = mount(c, 60);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("🎉Hi");
    unmount();
  });

  it("CJK names truncate cleanly without splitting a char", () => {
    const c = mkConvo("中文测试用户名超长的群聊名称");
    const { lastFrame, unmount } = mount(c, 24);
    const frame = lastFrame() ?? "";
    // No U+FFFD.
    expect(frame).not.toContain("�");
    unmount();
  });

  it("snippet row also avoids mid-emoji splits", () => {
    const c = mkConvo("Alice", {
      lastMessageSnippet: "🎉🎉🎉🎉🎉🎉🎉 we're going out tonight at 8pm",
    });
    const { lastFrame, unmount } = mount(c, 30);
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("�");
    unmount();
  });
});

describe("truncateSlugForRow", () => {
  it("returns short slugs unchanged", () => {
    expect(truncateSlugForRow("mal~imsg~8ac8", 40)).toBe("mal~imsg~8ac8");
  });

  it("squeezes the name part but preserves the ~svc~hash tail", () => {
    const slug = "sarah-redhead-kittens-best-tits-ever~imsg~d607";
    const out = truncateSlugForRow(slug, 30);
    expect(out.endsWith("~imsg~d607")).toBe(true);
    expect(out).toContain("…");
    expect(out.length).toBeLessThanOrEqual(30);
  });

  it("falls back to plain truncation for non-slug strings", () => {
    const out = truncateSlugForRow("x".repeat(50), 20);
    expect(out.length).toBeLessThanOrEqual(20);
  });
});
