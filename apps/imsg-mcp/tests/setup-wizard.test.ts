/**
 * Stage 3 — setup wizard PURE functions (no TTY, no inquirer).
 * The interactive runner is a thin shell over these; here we lock the logic.
 */
import { describe, expect, it } from "vitest";
import type { ProviderConfig } from "../src/media-providers.js";
import {
  applyWizardResult,
  brewHintFor,
  buildDoctorLines,
  buildProviderConfig,
  chainRecipes,
  maskKey,
  providerCapabilities,
  suggestChains,
  validateInterpretConfig,
  type WizardResult,
} from "../src/setup-wizard.js";

describe("providerCapabilities", () => {
  it("reads preset capabilities and defaults custom to all-true", () => {
    expect(providerCapabilities({ preset: "openrouter" })).toEqual({
      transcribe: false,
      vision: true,
      audioChat: true,
    });
    expect(providerCapabilities({})).toEqual({ transcribe: true, vision: true, audioChat: true });
  });
});

describe("buildProviderConfig", () => {
  it("strips the apiKey and keeps preset/models", () => {
    const cfg = buildProviderConfig({
      name: "or",
      preset: "openrouter",
      apiKey: "sk-secret",
      models: { vision: "google/gemini" },
    });
    expect(cfg).toEqual({ name: "or", preset: "openrouter", models: { vision: "google/gemini" } });
    expect((cfg as Record<string, unknown>).apiKey).toBeUndefined();
  });

  it("requires a name", () => {
    expect(() => buildProviderConfig({ name: "  ", preset: "openai" })).toThrow(/name/);
  });

  it("requires a preset or baseUrl", () => {
    expect(() => buildProviderConfig({ name: "x" })).toThrow(/preset or/);
  });

  it("requires an accountId for cloudflare", () => {
    expect(() => buildProviderConfig({ name: "cf", preset: "cloudflare" })).toThrow(/accountId/);
    expect(buildProviderConfig({ name: "cf", preset: "cloudflare", accountId: "acc" })).toEqual({
      name: "cf",
      preset: "cloudflare",
      accountId: "acc",
    });
  });

  it("accepts a custom baseUrl", () => {
    expect(buildProviderConfig({ name: "local", baseUrl: "http://localhost:1234/v1" })).toEqual({
      name: "local",
      baseUrl: "http://localhost:1234/v1",
    });
  });
});

describe("chainRecipes", () => {
  const or: ProviderConfig = { name: "or", preset: "openrouter" }; // vision + audioChat
  const hf: ProviderConfig = { name: "hf", preset: "huggingface" }; // vision only

  it("audio recipes gate on audio capability", () => {
    const withOr = chainRecipes("audio", [or]).map((r) => r.chain);
    expect(withOr).toContainEqual(["apple", "local"]);
    expect(withOr).toContainEqual(["apple", "local", "provider:or"]);
    expect(withOr).toContainEqual(["provider:or"]);
    expect(withOr).toContainEqual([]); // off

    // huggingface can't do audio → only free + off recipes.
    const withHf = chainRecipes("audio", [hf]).map((r) => r.chain);
    expect(withHf).toEqual([["apple", "local"], []]);
  });

  it("image recipes list vision providers plus off", () => {
    const recipes = chainRecipes("image", [or, hf]).map((r) => r.chain);
    expect(recipes[0]).toEqual([]); // off is first
    expect(recipes).toContainEqual(["provider:or"]);
    expect(recipes).toContainEqual(["provider:hf"]);
  });
});

describe("suggestChains", () => {
  it("free-first audio, vision provider for image/video", () => {
    const s = suggestChains([{ name: "or", preset: "openrouter" }]);
    expect(s.audio).toEqual(["apple", "local", "provider:or"]);
    expect(s.image).toEqual(["provider:or"]);
    expect(s.video).toEqual(["provider:or"]);
  });

  it("no providers → free audio, empty image/video", () => {
    expect(suggestChains([])).toEqual({ audio: ["apple", "local"], image: [], video: [] });
  });
});

describe("validateInterpretConfig", () => {
  it("flags unknown providers and capability mismatches", () => {
    const warnings = validateInterpretConfig({
      chains: {
        audio: ["provider:hf"], // hf can't do audio
        image: ["provider:ghost"], // unknown
        video: [],
      },
      providers: [{ name: "hf", preset: "huggingface" }],
    });
    expect(warnings.some((w) => w.includes("ghost"))).toBe(true);
    expect(warnings.some((w) => w.includes("audio"))).toBe(true);
  });

  it("no warnings for a well-formed config", () => {
    expect(
      validateInterpretConfig({
        chains: { audio: ["apple", "local"], image: ["provider:or"], video: [] },
        providers: [{ name: "or", preset: "openrouter" }],
      }),
    ).toEqual([]);
  });
});

describe("applyWizardResult", () => {
  const base = { theme: "powerline" as const, accentColor: "#FF6B35" };
  const result: WizardResult = {
    providers: [{ name: "or", preset: "openrouter", apiKey: "sk-secret" }],
    chains: { audio: ["apple", "local"], image: ["provider:or"], video: [] },
    auto: "all",
    inlineTranscripts: false,
    exportConfirmThreshold: 10,
    nudge: { enabled: true, tier2SyncNow: false, timeoutSeconds: 30 },
  };

  it("keeps keys out of config and routes them to credentials", () => {
    const { config, credentials } = applyWizardResult(base, result);
    expect(config.theme).toBe("powerline");
    expect(config.accentColor).toBe("#FF6B35");
    expect(config.interpret?.providers).toEqual([{ name: "or", preset: "openrouter" }]);
    expect(JSON.stringify(config)).not.toContain("sk-secret");
    expect(credentials).toEqual({ or: "sk-secret" });
  });

  it("carries the toggles into the interpret block", () => {
    const { config } = applyWizardResult(base, result);
    expect(config.interpret?.auto).toBe("all");
    expect(config.interpret?.inlineTranscripts).toBe(false);
    expect(config.interpret?.exportConfirmThreshold).toBe(10);
  });
});

describe("brewHintFor + maskKey + buildDoctorLines", () => {
  it("brew hints", () => {
    expect(brewHintFor("yap")).toBe("brew install yap");
    expect(brewHintFor("ffmpeg")).toBe("brew install ffmpeg");
  });

  it("masks keys", () => {
    expect(maskKey("sk-abcdef")).toBe("…cdef");
    expect(maskKey("ab")).toBe("…");
  });

  it("doctor lines flag missing FDA and transcribers", () => {
    const lines = buildDoctorLines(false, {
      yap: false,
      hear: false,
      whisperCli: false,
      ffmpeg: false,
      mpv: false,
    });
    expect(lines[0].ok).toBe(false); // FDA missing
    expect(lines.some((l) => !l.ok && /transcriber/.test(l.text))).toBe(true);
  });
});
