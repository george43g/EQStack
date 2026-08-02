/**
 * Lock in render correctness for two narrow TUI components that were
 * silently broken before the live audit:
 *
 * 1. DevStats — when the engine label is "Rust parser + TS DB" (longer than
 *    the panel width), the value used to wrap interleaved with the label
 *    text ("EngiRust parser" / "e   + TS DB"). Stacking label-above-value
 *    keeps the full value on its own row.
 *
 * 2. SendViaModal — the modal must render the title, handle, and every app
 *    on separate rows. Before the fix, lack of an opaque backgroundColor
 *    let the underlying sidebar bleed through and the title collided with
 *    the Handle line.
 */
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { DevStats } from "../src/tui/components/DevStats.js";
import { SendViaModal } from "../src/tui/components/SendViaModal.js";
import type { DevStatsData } from "../src/tui/hooks/useDevStats.js";
import { makeTheme } from "../src/tui/theme.js";
import { ThemeProvider } from "../src/tui/themes/ThemeContext.js";
import type { ChatAppDef } from "../src/url-schemes.js";

const stats: DevStatsData = {
  engine: "Rust parser + TS DB",
  cpuPercent: 6,
  memMB: 264,
  pid: 12345,
  uptime: "1h26m",
  lastQueryMs: 22,
  eventLoopP99Ms: 28,
  lastActivityAgo: "1h",
};

describe("DevStats engine label", () => {
  it("keeps the engine label on its own row (no interleaving with the value)", () => {
    const { lastFrame, unmount } = render(
      <ThemeProvider value={makeTheme()}>
        <DevStats stats={stats} width={20} />
      </ThemeProvider>,
    );
    const frame = lastFrame() ?? "";
    // The engine value may wrap across lines (Ink line-wrap on narrow column),
    // but the words must appear in order and `Engine` label must be on its
    // own row — never interleaved with the value.
    const compact = frame.replace(/\s+/g, " ");
    // Allow box borders + whitespace between words — Ink wraps long lines
    // on the narrow column and our regex must not over-constrain that.
    expect(compact).toMatch(/Engine[│\s]+Rust parser \+ TS[│\s]+DB/);
    // Regression check: the broken render produced "EngiRust parser" — the
    // label text spliced into the middle of the value. Never want to see that.
    expect(frame).not.toMatch(/EngiRust/);
    expect(frame).not.toMatch(/Engir/i);
    unmount();
  });

  it("renders short fields (CPU, Mem, PID) without truncation", () => {
    const { lastFrame, unmount } = render(
      <ThemeProvider value={makeTheme()}>
        <DevStats stats={stats} width={20} />
      </ThemeProvider>,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("CPU");
    expect(frame).toContain("6%");
    expect(frame).toContain("264MB");
    expect(frame).toContain("12345");
    expect(frame).toContain("28ms"); // lag
    unmount();
  });
});

// Real-world shape: 6 apps with FaceTime + FaceTime Audio (which share
// `/System/Applications/FaceTime.app` in src/url-schemes.ts). The live audit
// found this exact combination dropped one row from the rendered modal.
const apps: ChatAppDef[] = [
  {
    name: "Messages",
    appPath: "/System/Applications/Messages.app",
    buildUri: () => "imessage://",
    supportsBody: false,
  },
  {
    name: "FaceTime",
    appPath: "/System/Applications/FaceTime.app",
    buildUri: () => "facetime://",
    supportsBody: false,
  },
  {
    name: "FaceTime Audio",
    appPath: "/System/Applications/FaceTime.app",
    buildUri: () => "facetime-audio://",
    supportsBody: false,
  },
  {
    name: "Signal",
    appPath: "/Applications/Signal.app",
    buildUri: () => "sgnl://",
    supportsBody: false,
  },
  {
    name: "WhatsApp",
    appPath: "/Applications/WhatsApp.app",
    buildUri: () => "whatsapp://",
    supportsBody: true,
  },
  {
    name: "SMS",
    appPath: "/System/Applications/Messages.app",
    buildUri: () => "sms:",
    supportsBody: true,
  },
];

describe("SendViaModal", () => {
  it("renders the title, the handle, and every app on distinct rows", () => {
    const { lastFrame, unmount } = render(
      <ThemeProvider value={makeTheme()}>
        <SendViaModal handle="+61421106651" apps={apps} />
      </ThemeProvider>,
    );
    const frame = lastFrame() ?? "";
    // Title text intact.
    expect(frame).toContain("Send via external app");
    // Handle text intact AND on its own line (no overlap residue like the
    // orphan `p` from the previous bug).
    expect(frame).toMatch(/Handle: \+61421106651\b/);
    // All apps with sequential numbers — the live render previously dropped
    // FaceTime (showing 1, 3, 4, 5, 6 instead of 1-6). Every entry should
    // be visible.
    expect(frame).toContain("1: Messages");
    expect(frame).toContain("2: FaceTime");
    expect(frame).toContain("3: FaceTime Audio");
    expect(frame).toContain("4: Signal");
    expect(frame).toContain("5: WhatsApp");
    expect(frame).toContain("6: SMS");
    // Footer with launch hint.
    expect(frame).toContain("1-9: launch");
    unmount();
  });

  it("renders gracefully when no apps are installed", () => {
    const { lastFrame, unmount } = render(
      <ThemeProvider value={makeTheme()}>
        <SendViaModal handle="+15555550100" apps={[]} />
      </ThemeProvider>,
    );
    expect(lastFrame() ?? "").toContain("No compatible apps installed.");
    unmount();
  });
});
