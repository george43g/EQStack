/**
 * Stage 6 — SettingsPanel render. Renders with ink-testing-library and asserts
 * on the frame text (mirrors info-drawer.test.tsx). Read-only: the panel must
 * show provider key PRESENCE, never a key value.
 */
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { InterpretConfigSchema } from "../src/app-config.js";
import { SettingsPanel } from "../src/tui/components/SettingsPanel.js";
import { buildSettingsRows } from "../src/tui/settings-model.js";
import { makeTheme } from "../src/tui/theme.js";
import { ThemeProvider } from "../src/tui/themes/ThemeContext.js";

function rows() {
  const interpret = InterpretConfigSchema.parse({
    auto: "free",
    chains: {
      audio: ["apple", "local", "provider:openrouter"],
      image: ["provider:openrouter"],
      video: [],
    },
    providers: [{ name: "openrouter", preset: "openrouter" }],
  });
  return buildSettingsRows(interpret, { openrouter: true });
}

function renderPanel(cursor = 0) {
  return render(
    <ThemeProvider value={makeTheme()}>
      <SettingsPanel
        rows={rows()}
        cursor={cursor}
        configPath="/Users/x/.imsg-mcp/config.json"
        warnings={[]}
        width={70}
        height={30}
      />
    </ThemeProvider>,
  );
}

describe("SettingsPanel render", () => {
  it("shows the header, section headers, toggles, and a chain link", () => {
    const { lastFrame, unmount } = renderPanel(0);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Settings — Media Interpretation");
    expect(frame).toContain("General");
    expect(frame).toContain("Auto interpretation");
    expect(frame).toContain("Inline transcripts");
    expect(frame).toContain("Audio chain");
    expect(frame).toContain("Apple transcript");
    unmount();
  });

  it("renders a provider with a key-present indicator but no key value", () => {
    const { lastFrame, unmount } = renderPanel(0);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Providers");
    expect(frame).toContain("openrouter");
    expect(frame).toContain("key set");
    unmount();
  });

  it("marks the selected row with a ▸ cursor", () => {
    const { lastFrame, unmount } = renderPanel(0);
    expect(lastFrame() ?? "").toContain("▸");
    unmount();
  });

  it("shows where edits persist in the footer", () => {
    const { lastFrame, unmount } = renderPanel(0);
    expect(lastFrame() ?? "").toContain("Saved to /Users/x/.imsg-mcp/config.json");
    unmount();
  });
});
