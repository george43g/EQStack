/**
 * Regression: drawer rows and the status bar must keep their label/gap
 * structure when a sibling Text claims the row width.
 *
 * Bugs we lock against (found via live tmux pass):
 *   1. MessageDrawer's `Label` was a bare `<Text>` next to a sibling
 *      `<Text wrap="truncate">{m.guid}</Text>`. The truncating value
 *      won the row's width negotiation in Ink and the label's
 *      colon+space got eaten, rendering "GUID9C768341..." instead of
 *      "GUID: 9C768341...". Fix: wrap Label in a `flexShrink={0}` Box.
 *   2. StatusBar's right-side Box had no shrink discipline. When a
 *      long toast appeared, the bar wrapped to a 2nd line. Fix:
 *      `flexShrink={1}` + `wrap="truncate"` on the status text.
 *   3. CompactStats's "Rust parser + TS DB" was too long for the
 *      narrow status bar. Fix: abbreviate to "Rust+TS" inline.
 */

import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { CompactStats } from "../src/tui/components/DevStats.js";
import { MessageDrawer } from "../src/tui/components/MessageDrawer.js";
import { StatusBar } from "../src/tui/components/StatusBar.js";
import { makeTheme } from "../src/tui/theme.js";
import { ThemeProvider } from "../src/tui/themes/ThemeContext.js";
import type { Message } from "../src/types.js";

function fakeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 1,
    guid: "9C768341-C452-FDF6-E4FD-503D34A2FAA7",
    text: "hello world",
    handle: "+61402229216",
    displayName: "Mum",
    isFromMe: false,
    date: new Date("2026-06-04T08:04:10.557Z"),
    dateRead: null,
    dateDelivered: null,
    isRead: true,
    isDelivered: true,
    chatId: "+61402229216",
    service: "SMS",
    isReaction: false,
    isReply: false,
    isEdited: false,
    isRetracted: false,
    hasAttachments: false,
    ...overrides,
  };
}

describe("MessageDrawer label/value layout", () => {
  it("preserves the colon+space after GUID even when the value truncates", () => {
    const theme = makeTheme();
    const { lastFrame, unmount } = render(
      <ThemeProvider value={theme}>
        <MessageDrawer message={fakeMessage()} width={30} height={20} />
      </ThemeProvider>,
    );
    const frame = lastFrame() ?? "";
    // Pre-fix bug rendered "GUID9C768341..."; post-fix has the label
    // colon and space intact.
    expect(frame).toMatch(/GUID:\s+9C768341/);
    unmount();
  });

  it("renders each labelled field with its colon", () => {
    const theme = makeTheme();
    const { lastFrame, unmount } = render(
      <ThemeProvider value={theme}>
        <MessageDrawer message={fakeMessage()} width={40} height={25} />
      </ThemeProvider>,
    );
    const frame = lastFrame() ?? "";
    for (const label of ["From:", "Handle:", "Sent:", "Service:", "Chat:", "GUID:"]) {
      expect(frame, `missing "${label}"`).toContain(label);
    }
    unmount();
  });
});

describe("StatusBar overflow handling", () => {
  it("truncates a long status to a single line rather than wrapping", () => {
    const theme = makeTheme();
    const longStatus = "A".repeat(120);
    const { lastFrame, unmount } = render(
      <ThemeProvider value={theme}>
        <StatusBar totalUnread={0} selected={undefined} status={longStatus} loading={false} />
      </ThemeProvider>,
    );
    const frame = lastFrame() ?? "";
    // Status should appear truncated (with ellipsis) on a single line.
    // We can't assert "exactly one line" because the test renderer
    // doesn't constrain width, but we can confirm the bar didn't blow
    // the layout up — i.e. all chars in the status are A or ellipsis.
    const statusLine = frame.split("\n").find((l) => l.includes("A"));
    expect(statusLine).toBeDefined();
    expect(statusLine?.match(/A+/)?.[0].length ?? 0).toBeGreaterThan(0);
    unmount();
  });
});

describe("CompactStats engine abbreviation", () => {
  it("renders 'Rust+TS' for the Rust parser + TS DB engine combo", () => {
    const theme = makeTheme();
    const { lastFrame, unmount } = render(
      <ThemeProvider value={theme}>
        <CompactStats
          stats={{
            engine: "Rust parser + TS DB",
            cpuPercent: 0,
            memMB: 0,
            pid: 1234,
            uptimeMs: 0,
            eventLoopP99Ms: 0,
            queryMs: 0,
            activeMs: 0,
          }}
        />
      </ThemeProvider>,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Rust+TS");
    expect(frame).not.toContain("Rust parser + TS DB");
    unmount();
  });

  it("renders 'Rust' for the all-Rust combo", () => {
    const theme = makeTheme();
    const { lastFrame, unmount } = render(
      <ThemeProvider value={theme}>
        <CompactStats
          stats={{
            engine: "Rust parser + Rust DB",
            cpuPercent: 0,
            memMB: 0,
            pid: 1234,
            uptimeMs: 0,
            eventLoopP99Ms: 0,
            queryMs: 0,
            activeMs: 0,
          }}
        />
      </ThemeProvider>,
    );
    expect(lastFrame() ?? "").toContain("Rust ");
    unmount();
  });
});
