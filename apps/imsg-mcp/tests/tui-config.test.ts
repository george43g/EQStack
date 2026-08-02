import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadTuiConfig, resolveTuiConfig } from "../src/tui-config.js";

const ORIG_ENV = { ...process.env };
let tmpHome: string;

beforeEach(() => {
  tmpHome = join(tmpdir(), `imsg-tui-config-${process.pid}-${Date.now()}`);
  mkdirSync(tmpHome, { recursive: true });
  // Force XDG path to point inside the temp dir so we don't touch the
  // real ~/.config when tests run on a developer machine.
  process.env.XDG_CONFIG_HOME = tmpHome;
  delete process.env.IMSG_TUI_THEME;
  delete process.env.IMSG_TUI_ACCENT;
});

afterEach(() => {
  process.env = { ...ORIG_ENV };
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("loadTuiConfig", () => {
  it("returns defaults when no file exists", () => {
    const r = loadTuiConfig();
    expect(r.config.theme).toBe("safe");
    expect(r.config.accentColor).toBe("#1982FC");
    expect(r.source).toBeNull();
    expect(r.warnings).toEqual([]);
  });

  it("reads a valid config file", () => {
    const path = join(tmpHome, "imsg-mcp", "config.json");
    mkdirSync(join(tmpHome, "imsg-mcp"));
    writeFileSync(path, JSON.stringify({ theme: "powerline", accentColor: "#FF6B35" }));
    const r = loadTuiConfig();
    expect(r.config.theme).toBe("powerline");
    expect(r.config.accentColor).toBe("#FF6B35");
    expect(r.source).toBe(path);
  });

  it("falls back to defaults + warning on schema violation", () => {
    const path = join(tmpHome, "imsg-mcp", "config.json");
    mkdirSync(join(tmpHome, "imsg-mcp"));
    writeFileSync(path, JSON.stringify({ theme: "neon", accentColor: "not-hex" }));
    const r = loadTuiConfig();
    expect(r.config.theme).toBe("safe");
    expect(r.config.accentColor).toBe("#1982FC");
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it("falls back on malformed JSON", () => {
    const path = join(tmpHome, "imsg-mcp", "config.json");
    mkdirSync(join(tmpHome, "imsg-mcp"));
    writeFileSync(path, "{ not valid json");
    const r = loadTuiConfig();
    expect(r.config.theme).toBe("safe");
    expect(r.warnings.length).toBeGreaterThan(0);
  });
});

describe("resolveTuiConfig — precedence (CLI > env > config > default)", () => {
  it("default wins when nothing is set", () => {
    const r = resolveTuiConfig();
    expect(r.theme).toBe("safe");
    expect(r.origin.theme).toBe("default");
    expect(r.accentColor).toBe("#1982FC");
  });

  it("config file beats default", () => {
    const path = join(tmpHome, "imsg-mcp", "config.json");
    mkdirSync(join(tmpHome, "imsg-mcp"));
    writeFileSync(path, JSON.stringify({ theme: "powerline", accentColor: "#FF6B35" }));
    const r = resolveTuiConfig();
    expect(r.origin.theme).toBe("config");
    expect(r.theme).toBe("powerline");
  });

  it("env beats config", () => {
    const path = join(tmpHome, "imsg-mcp", "config.json");
    mkdirSync(join(tmpHome, "imsg-mcp"));
    writeFileSync(path, JSON.stringify({ theme: "powerline", accentColor: "#FF6B35" }));
    process.env.IMSG_TUI_THEME = "safe";
    const r = resolveTuiConfig();
    expect(r.origin.theme).toBe("env");
    expect(r.theme).toBe("safe");
  });

  it("CLI beats everything", () => {
    process.env.IMSG_TUI_ACCENT = "#FF6B35";
    const r = resolveTuiConfig({ cliAccent: "#00FF88" });
    expect(r.origin.accentColor).toBe("cli");
    expect(r.accentColor).toBe("#00FF88");
  });

  it("invalid env value is ignored with a warning", () => {
    process.env.IMSG_TUI_ACCENT = "not-a-hex";
    const r = resolveTuiConfig();
    expect(r.accentColor).toBe("#1982FC");
    expect(r.warnings.some((w) => w.includes("IMSG_TUI_ACCENT"))).toBe(true);
  });
});
