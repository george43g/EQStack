/**
 * Stage 3 — app-config: the widened schema (interpret block), credentials
 * (chmod 600), and interpret-config resolution (config + credentials + env).
 *
 * Isolated by pointing HOME at a temp dir (so credentials.json + the
 * $HOME/.config path land inside it) and clearing XDG so config resolution
 * falls to $HOME/.config/imsg-mcp/config.json.
 */
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AppConfigSchema,
  credentialsPath,
  InterpretConfigSchema,
  loadTuiConfig,
  readCredentials,
  resolveInterpretConfig,
  setCredential,
  writeCredentials,
  writeTuiConfig,
} from "../src/app-config.js";

// NOTE: mutate process.env keys IN PLACE — never `process.env = {...}`. A whole
// reassignment swaps the magic env object for a plain one, after which
// `process.env.HOME = …` no longer reaches the real OS env that `os.homedir()`
// reads (it would keep pointing at the first test's temp dir → cross-test leak).
const ENV_KEYS = [
  "HOME",
  "XDG_CONFIG_HOME",
  "IMSG_TRANSCRIBE_PROVIDER",
  "IMSG_TRANSCRIBE_API_KEY",
  "IMSG_TRANSCRIBE_MODEL",
  "IMSG_TUI_THEME",
  "IMSG_TUI_ACCENT",
] as const;
const saved: Record<string, string | undefined> = {};
let tmpHome: string;

function configPath(): string {
  return join(tmpHome, ".config", "imsg-mcp", "config.json");
}

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  tmpHome = join(tmpdir(), `imsg-app-config-${process.pid}-${Date.now()}-${Math.random()}`);
  mkdirSync(tmpHome, { recursive: true });
  process.env.HOME = tmpHome;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.IMSG_TRANSCRIBE_PROVIDER;
  delete process.env.IMSG_TRANSCRIBE_API_KEY;
  delete process.env.IMSG_TRANSCRIBE_MODEL;
  delete process.env.IMSG_TUI_THEME;
  delete process.env.IMSG_TUI_ACCENT;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("InterpretConfigSchema", () => {
  it("fills free-first defaults from an empty object", () => {
    const c = InterpretConfigSchema.parse({});
    expect(c.auto).toBe("free");
    expect(c.inlineTranscripts).toBe(true);
    expect(c.exportConfirmThreshold).toBe(25);
    expect(c.chains).toEqual({ audio: ["apple", "local"], image: [], video: [] });
    expect(c.providers).toEqual([]);
    expect(c.nudge).toEqual({ enabled: true, tier2SyncNow: false, timeoutSeconds: 30 });
  });

  it("round-trips (parse → serialize → parse)", () => {
    const input = {
      auto: "all" as const,
      chains: { audio: ["apple", "local", "provider:or"], image: ["provider:or"], video: [] },
      providers: [
        { name: "or", preset: "openrouter" as const, models: { vision: "google/gemini" } },
      ],
      nudge: { enabled: false, tier2SyncNow: true, timeoutSeconds: 45 },
    };
    const first = InterpretConfigSchema.parse(input);
    const second = InterpretConfigSchema.parse(JSON.parse(JSON.stringify(first)));
    expect(second).toEqual(first);
  });

  it("rejects a provider with neither preset nor baseUrl", () => {
    expect(() => InterpretConfigSchema.parse({ providers: [{ name: "x" }] })).toThrow();
  });
});

describe("AppConfigSchema back-compat", () => {
  it("accepts a flat theme-only config (no interpret block)", () => {
    const c = AppConfigSchema.parse({ theme: "powerline", accentColor: "#FF6B35" });
    expect(c.theme).toBe("powerline");
    expect(c.interpret).toBeUndefined();
  });
});

describe("loadTuiConfig graceful degradation", () => {
  it("keeps a valid theme when the interpret block is malformed", () => {
    mkdirSync(join(tmpHome, ".config", "imsg-mcp"), { recursive: true });
    writeFileSync(
      configPath(),
      JSON.stringify({ theme: "powerline", accentColor: "#FF6B35", interpret: { auto: "bogus" } }),
    );
    const r = loadTuiConfig();
    expect(r.config.theme).toBe("powerline");
    expect(r.config.accentColor).toBe("#FF6B35");
    expect(r.config.interpret).toBeUndefined();
    expect(r.warnings.length).toBeGreaterThan(0);
  });
});

describe("credentials (chmod 600)", () => {
  it("writes credentials.json readable/writable only by owner", () => {
    writeCredentials({ openrouter: "sk-secret" });
    const mode = statSync(credentialsPath()).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(readCredentials()).toEqual({ openrouter: "sk-secret" });
  });

  it("setCredential adds and clears entries", () => {
    setCredential("a", "k1");
    setCredential("b", "k2");
    expect(readCredentials()).toEqual({ a: "k1", b: "k2" });
    setCredential("a", "");
    expect(readCredentials()).toEqual({ b: "k2" });
  });

  it("returns {} for a missing or corrupt file", () => {
    expect(readCredentials()).toEqual({});
    mkdirSync(join(tmpHome, ".imsg-mcp"), { recursive: true });
    writeFileSync(credentialsPath(), "{ not json");
    expect(readCredentials()).toEqual({});
  });
});

describe("resolveInterpretConfig", () => {
  it("merges credentials into providers by name", () => {
    writeTuiConfig({
      theme: "safe",
      accentColor: "#1982FC",
      interpret: {
        auto: "all",
        inlineTranscripts: true,
        exportConfirmThreshold: 25,
        chains: { audio: ["apple", "local"], image: ["provider:or"], video: [] },
        providers: [{ name: "or", preset: "openrouter" }],
        nudge: { enabled: true, tier2SyncNow: false, timeoutSeconds: 30 },
      },
    });
    setCredential("or", "sk-router");
    const r = resolveInterpretConfig();
    expect(r.auto).toBe("all");
    expect(r.providers.find((p) => p.name === "or")?.apiKey).toBe("sk-router");
    expect(r.chains.image).toEqual(["provider:or"]);
    expect(r.inlineTranscripts).toBe(true);
  });

  it("uses free-first defaults when no config exists", () => {
    const r = resolveInterpretConfig();
    expect(r.auto).toBe("free");
    expect(r.chains.audio).toEqual(["apple", "local"]);
    expect(r.providers).toEqual([]);
  });

  it("maps legacy IMSG_TRANSCRIBE_* env to an implicit env provider + audio chain", () => {
    process.env.IMSG_TRANSCRIBE_PROVIDER = "openai";
    process.env.IMSG_TRANSCRIBE_API_KEY = "sk-legacy";
    process.env.IMSG_TRANSCRIBE_MODEL = "whisper-1";
    const r = resolveInterpretConfig();
    const env = r.providers.find((p) => p.name === "env");
    expect(env).toBeDefined();
    expect(env?.apiKey).toBe("sk-legacy");
    expect(env?.baseUrl).toBe("https://api.openai.com/v1");
    expect(env?.models?.transcribe).toBe("whisper-1");
    expect(r.chains.audio).toContain("provider:env");
  });

  it("does not add the env provider when a chain already has a cloud link", () => {
    writeTuiConfig({
      theme: "safe",
      accentColor: "#1982FC",
      interpret: {
        auto: "all",
        inlineTranscripts: true,
        exportConfirmThreshold: 25,
        chains: { audio: ["apple", "local", "provider:or"], image: [], video: [] },
        providers: [{ name: "or", preset: "openrouter" }],
        nudge: { enabled: true, tier2SyncNow: false, timeoutSeconds: 30 },
      },
    });
    process.env.IMSG_TRANSCRIBE_PROVIDER = "openai";
    process.env.IMSG_TRANSCRIBE_API_KEY = "sk-legacy";
    const r = resolveInterpretConfig();
    // env provider is still registered, but the audio chain is untouched.
    expect(r.providers.some((p) => p.name === "env")).toBe(true);
    expect(r.chains.audio).toEqual(["apple", "local", "provider:or"]);
  });
});
