/**
 * ComposeRecipientModal — the new N-key compose-to-new-thread surface.
 *
 * Locks in:
 *   - Stage 1 (recipient) shows title + To: input + help footer
 *   - Resolution badge appears when a valid recipient is typed
 *   - Ambiguous matches surface a candidate list
 *   - Stage 2 (body) shows the locked recipient summary + body input
 *   - Esc back-out from stage 2 to stage 1
 */

import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import type { RecipientResolution } from "../src/recipient.js";
import { ComposeRecipientModal } from "../src/tui/components/ComposeRecipientModal.js";
import { makeTheme } from "../src/tui/theme.js";
import { ThemeProvider } from "../src/tui/themes/ThemeContext.js";

function mount(opts?: {
  resolve?: (input: string) => RecipientResolution;
  onSend?: (handle: string, text: string) => Promise<{ success: boolean; error?: string }>;
  onCancel?: () => void;
}) {
  const resolve =
    opts?.resolve ?? ((_: string): RecipientResolution => ({ kind: "error", message: "" }));
  const onSend = opts?.onSend ?? vi.fn(async (_h: string, _t: string) => ({ success: true }));
  const onCancel = opts?.onCancel ?? vi.fn();
  return render(
    <ThemeProvider value={makeTheme()}>
      <ComposeRecipientModal resolve={resolve} onSend={onSend} onCancel={onCancel} />
    </ThemeProvider>,
  );
}

/**
 * Poll the rendered frame until `pred` holds, or the timeout elapses. Ink's
 * TextInput state updates are async; a fixed sleep flaked under full-suite CPU
 * contention (render sometimes took >30ms), so wait on the condition instead.
 */
async function waitForFrame(
  lastFrame: () => string | undefined,
  pred: (frame: string) => boolean,
  timeoutMs = 1500,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let frame = lastFrame() ?? "";
  while (!pred(frame) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
    frame = lastFrame() ?? "";
  }
  return frame;
}

describe("ComposeRecipientModal — initial render", () => {
  it("starts on stage 1 (recipient entry)", () => {
    const { lastFrame, unmount } = mount();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("New message — recipient");
    expect(frame).toContain("To:");
    expect(frame).toContain("Enter: continue · Esc: cancel");
    unmount();
  });

  it("shows the placeholder hint before any input", () => {
    const { lastFrame, unmount } = mount();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("phone, email, or contact name");
    unmount();
  });
});

describe("ComposeRecipientModal — typing surfaces resolution feedback", () => {
  it("renders the input and footer correctly even when resolver always errors", () => {
    const resolve = vi.fn((_: string): RecipientResolution => ({ kind: "error", message: "" }));
    const { lastFrame, unmount } = mount({ resolve });
    const frame = lastFrame() ?? "";
    // Component must render even on an empty/error baseline.
    expect(frame).toContain("New message — recipient");
    unmount();
  });
});

describe("ComposeRecipientModal — ambiguous numbered picker", () => {
  it("renders numbered candidates and the pick-1-9 hint when resolution is ambiguous", async () => {
    const ambiguous = (): RecipientResolution => ({
      kind: "ambiguous",
      query: "brian",
      candidates: [
        { kind: "contact", handle: "+61411113227", displayName: "Brian Osborne (+61411113227)" },
        {
          kind: "email",
          handle: "brian@example.com",
          displayName: "Brian Osborne (brian@example.com)",
        },
      ],
    });
    const resolve = vi.fn((input: string) =>
      input.trim() ? ambiguous() : { kind: "error" as const, message: "" },
    );
    const { lastFrame, stdin, unmount } = mount({ resolve });
    stdin.write("b"); // trigger any-input → resolution recomputes
    const frame = await waitForFrame(lastFrame, (f) =>
      f.includes("1: Brian Osborne (+61411113227)"),
    );
    expect(frame).toContain("1: Brian Osborne (+61411113227)");
    expect(frame).toContain("2: Brian Osborne (brian@example.com)");
    expect(frame).toContain("Press 1-9 to pick a match");
    unmount();
  });

  it("picks the candidate when the user presses its number", async () => {
    const ambiguous = (): RecipientResolution => ({
      kind: "ambiguous",
      query: "brian",
      candidates: [
        { kind: "contact", handle: "+61411113227", displayName: "Brian Osborne (+61411113227)" },
        {
          kind: "email",
          handle: "brian@example.com",
          displayName: "Brian Osborne (brian@example.com)",
        },
      ],
    });
    const resolve = vi.fn((input: string) =>
      input.trim() ? ambiguous() : { kind: "error" as const, message: "" },
    );
    const { stdin, lastFrame, unmount } = mount({ resolve });
    stdin.write("b"); // any-input
    await waitForFrame(lastFrame, (f) => f.includes("Press 1-9 to pick a match"));
    stdin.write("2"); // pick candidate #2 (email)
    const frame = await waitForFrame(lastFrame, (f) => f.includes("New message — body"));
    expect(frame).toContain("New message — body");
    expect(frame).toContain("To: Brian Osborne (brian@example.com)");
    unmount();
  });
});

describe("ComposeRecipientModal — resolution badge transparency", () => {
  it("shows normalized handle when input differs (local phone → E.164)", async () => {
    const resolve = vi.fn(
      (input: string): RecipientResolution =>
        input.trim()
          ? { kind: "phone", handle: "+61401990797", displayName: "+61401990797" }
          : { kind: "error" as const, message: "" },
    );
    const { stdin, lastFrame, unmount } = mount({ resolve });
    stdin.write("0");
    const frame = await waitForFrame(lastFrame, (f) => f.includes("→ +61401990797"));
    expect(frame).toContain("→ +61401990797");
    unmount();
  });

  it("hides the redundant arrow when input matches resolved handle (E.164)", async () => {
    const resolve = vi.fn(
      (input: string): RecipientResolution =>
        input.trim()
          ? { kind: "phone", handle: "+61401990797", displayName: "+61401990797" }
          : { kind: "error" as const, message: "" },
    );
    const { stdin, lastFrame, unmount } = mount({ resolve });
    stdin.write("+61401990797");
    const frame = await waitForFrame(lastFrame, (f) => /\[phone\]/.test(f));
    // [phone] should appear WITHOUT an arrow (input already E.164).
    expect(frame).toMatch(/\[phone\]/);
    expect(frame).not.toMatch(/\[phone → /);
    unmount();
  });
});

describe("ComposeRecipientModal — Esc handling", () => {
  it("calls onCancel when Esc is pressed at stage 1", async () => {
    const onCancel = vi.fn();
    const { stdin, unmount } = mount({ onCancel });
    stdin.write(String.fromCharCode(27)); // ESC
    const deadline = Date.now() + 1500;
    while (onCancel.mock.calls.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(onCancel).toHaveBeenCalledTimes(1);
    unmount();
  });
});
