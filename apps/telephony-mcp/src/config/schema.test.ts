import { describe, expect, it } from "vitest";
import { ConfigError, effectiveCallSettings, parseConfig } from "./schema.js";

function minimalConfig(): Record<string, unknown> {
  return {
    telephony: { fromNumber: "+61255501234" },
    llm: { type: "openai-compatible", model: "openai/gpt-5-mini" },
    voice: { voiceId: "abc123" },
    recipients: {
      george: { number: "+61400111222", recordingPolicy: "preconsented" },
    },
    profiles: {
      default: { systemPrompt: "You are making a phone call on behalf of George." },
    },
  };
}

function base(): Record<string, unknown> {
  const cfg = minimalConfig();
  (cfg.recipients as Record<string, unknown>)["manual-friend"] = {
    number: "+61400333444",
    recordingPolicy: "manual",
  };
  return cfg;
}

describe("config schema", () => {
  it("parses a minimal config and applies documented defaults", () => {
    const cfg = parseConfig(base());
    expect(cfg.server.publicPort).toBe(8790);
    expect(cfg.server.adminPort).toBe(8791);
    expect(cfg.llm.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(cfg.llm.apiKeyRef).toBe("OPENROUTER_API_KEY");
    expect(cfg.voice.language).toBe("en-AU");
    expect(cfg.voice.transcription.provider).toBe("Deepgram");
    expect(cfg.voice.transcription.model).toBe("flux");
    expect(cfg.limits.maxConcurrentCalls).toBe(1);
    expect(cfg.limits.defaultMaxDurationMinutes).toBe(15);
    expect(cfg.telephony.type).toBe("twilio-conversation-relay");
    expect(cfg.disclosure.text).toContain("recorded");
  });

  it("rejects unknown keys (strict at the boundary)", () => {
    const cfg = base();
    (cfg as Record<string, unknown>).surprise = true;
    expect(() => parseConfig(cfg)).toThrow(ConfigError);
  });

  it("rejects non-E.164 numbers", () => {
    const cfg = base();
    (cfg.recipients as Record<string, Record<string, unknown>>).george = {
      number: "0400 111 222",
      recordingPolicy: "never",
    };
    expect(() => parseConfig(cfg)).toThrow(/E\.164/);
  });

  it("requires a default profile", () => {
    const cfg = base();
    cfg.profiles = { other: { systemPrompt: "hi" } };
    expect(() => parseConfig(cfg)).toThrow(/default/);
  });

  it("rejects a profile duration above the administrator cap", () => {
    const cfg = base();
    (cfg.profiles as Record<string, Record<string, unknown>>).default = {
      systemPrompt: "hi",
      maxDurationMinutes: 60,
    };
    expect(() => parseConfig(cfg)).toThrow(/hardMaxDurationMinutes/);
  });

  it("accepts reserved telephony adapter ids for staging", () => {
    const cfg = base();
    (cfg.telephony as Record<string, unknown>).type = "twilio-media-streams";
    expect(parseConfig(cfg).telephony.type).toBe("twilio-media-streams");
  });

  it("allows a keyless LLM (Ollama)", () => {
    const cfg = base();
    cfg.llm = {
      type: "openai-compatible",
      baseUrl: "http://localhost:11434/v1",
      model: "llama3.2",
      apiKeyRef: null,
    };
    const parsed = parseConfig(cfg);
    expect(parsed.llm.apiKeyRef).toBeNull();
  });

  it("applies profile duration within the cap and merges voice overrides", () => {
    const cfg = base();
    (cfg.profiles as Record<string, unknown>).slow = {
      systemPrompt: "hi",
      maxDurationMinutes: 18,
      voice: { speed: 0.8 },
    };
    cfg.limits = { hardMaxDurationMinutes: 20 };
    const parsed = parseConfig(cfg);
    const s = effectiveCallSettings(parsed, "slow");
    expect(s.maxDurationSec).toBe(18 * 60);
    expect(s.voice.speed).toBe(0.8);
    expect(s.voice.voiceId).toBe("abc123");
    // profile without its own duration uses the default (15), also under the cap
    expect(effectiveCallSettings(parsed, "default").maxDurationSec).toBe(15 * 60);
    expect(() => effectiveCallSettings(parsed, "missing")).toThrow(ConfigError);
  });
});
