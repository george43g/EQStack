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

describe("agentPlatform + consent blocks (Phase Q, D-75/D-76)", () => {
  it("both are optional; consent defaults to asking (never silent by default)", () => {
    const cfg = parseConfig(base());
    expect(cfg.agentPlatform).toBeUndefined();
    expect(cfg.consent.autoApproveThirdPartyDisclosures).toBe(false);
  });

  it("parses an agentPlatform block under D-75's registered name, with defaults", () => {
    const cfg = base();
    (cfg as Record<string, unknown>).agentPlatform = {
      type: "elevenlabs-managed",
      phoneNumberId: "phnum_7001abc",
    };
    const parsed = parseConfig(cfg);
    expect(parsed.agentPlatform).toEqual({
      type: "elevenlabs-managed",
      apiKeyRef: "ELEVENLABS_API_KEY",
      phoneNumberId: "phnum_7001abc",
      baseUrl: "https://api.elevenlabs.io",
      pollIntervalMs: 2000,
    });
  });

  it("rejects a phone number where the phnum_ id belongs, and unknown keys", () => {
    const cfg = base();
    (cfg as Record<string, unknown>).agentPlatform = {
      type: "elevenlabs-managed",
      phoneNumberId: "+61347139984",
    };
    expect(() => parseConfig(cfg)).toThrow(/phnum_/);
    (cfg as Record<string, unknown>).agentPlatform = {
      type: "elevenlabs-managed",
      phoneNumberId: "phnum_1",
      apiKey: "sk_literal",
    };
    expect(() => parseConfig(cfg)).toThrow(ConfigError);
  });

  it("twilioHangup (O-30) is optional, strict, SID-shaped, and takes the secret by NAME only", () => {
    const cfg = base();
    const hangup = { accountSid: `AC${"1".repeat(32)}`, apiKeySid: `SK${"2".repeat(32)}` };
    (cfg as Record<string, unknown>).agentPlatform = {
      type: "elevenlabs-managed",
      phoneNumberId: "phnum_1",
      twilioHangup: hangup,
    };
    expect(parseConfig(cfg).agentPlatform?.twilioHangup).toEqual({
      ...hangup,
      apiSecretRef: "TWILIO_API_KEY_ELEVENLABS_SUBACCOUNT_CALLS_RW",
    });
    const bad = (twilioHangup: Record<string, unknown>) => {
      (cfg as Record<string, unknown>).agentPlatform = {
        type: "elevenlabs-managed",
        phoneNumberId: "phnum_1",
        twilioHangup,
      };
      return () => parseConfig(cfg);
    };
    // A literal secret has nowhere to go (INV-12).
    expect(bad({ ...hangup, apiSecret: "literal" })).toThrow(ConfigError);
    expect(bad({ ...hangup, accountSid: `SK${"1".repeat(32)}` })).toThrow(/account SID/);
    expect(bad({ ...hangup, apiKeySid: `AC${"2".repeat(32)}` })).toThrow(/API key SID/);
    expect(bad({ accountSid: hangup.accountSid })).toThrow(ConfigError);
  });

  it("the Phase B telephony reservation still PARSES, so construction can refuse it with a pointer", () => {
    const cfg = base();
    (cfg.telephony as Record<string, unknown>).type = "elevenlabs-managed";
    expect(parseConfig(cfg).telephony.type).toBe("elevenlabs-managed");
  });
});

describe("agentPlatform.consult + tools listener (Phase R, D-91/D-93)", () => {
  function withConsult(consult: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    return {
      ...base(),
      server: { publicBaseUrl: "https://gw.example.invalid" },
      agentPlatform: { type: "elevenlabs-managed", phoneNumberId: "phnum_7001abc", consult },
      ...extra,
    };
  }

  it("defaults: toolsPort 8792, hold 45 s, cap 3, host idle 90 s, ElevenLabs' US egress IPs", () => {
    const cfg = parseConfig(withConsult({ toolsBaseUrl: "https://tools.example.invalid" }));
    expect(cfg.server.toolsPort).toBe(8792);
    expect(cfg.agentPlatform?.consult).toEqual({
      toolsBaseUrl: "https://tools.example.invalid",
      holdSec: 45,
      maxPendingPerCall: 3,
      hostIdleSec: 90,
      allowedSourceIps: ["34.67.146.145", "34.59.11.47"],
    });
  });

  it("toolsBaseUrl is required and https-only; holdSec keeps holdSec + 15 inside EL's 5..300", () => {
    expect(() => parseConfig(withConsult({}))).toThrow(ConfigError);
    expect(() =>
      parseConfig(withConsult({ toolsBaseUrl: "http://tools.example.invalid" })),
    ).toThrow(/toolsBaseUrl/);
    const at = (holdSec: number) =>
      parseConfig(withConsult({ toolsBaseUrl: "https://tools.example.invalid", holdSec }));
    expect(() => at(4)).toThrow(/holdSec/);
    expect(() => at(286)).toThrow(/holdSec/);
    expect(at(285).agentPlatform?.consult?.holdSec).toBe(285);
  });

  it("allowedSourceIps must be IP addresses; [] is allowed (disables the check, serve warns)", () => {
    expect(() =>
      parseConfig(
        withConsult({ toolsBaseUrl: "https://tools.example.invalid", allowedSourceIps: ["x"] }),
      ),
    ).toThrow(/allowedSourceIps/);
    expect(
      parseConfig(
        withConsult({ toolsBaseUrl: "https://tools.example.invalid", allowedSourceIps: [] }),
      ).agentPlatform?.consult?.allowedSourceIps,
    ).toEqual([]);
  });

  it("the tools host must differ from the Twilio host (D-59/D-91)", () => {
    expect(() => parseConfig(withConsult({ toolsBaseUrl: "https://gw.example.invalid" }))).toThrow(
      /its own hostname/,
    );
  });

  it("tunnel.toolsHostname must match the toolsBaseUrl host (sibling of the hostname check)", () => {
    const tunnel = {
      enabled: true,
      tunnelName: "telephony",
      hostname: "gw.example.invalid",
      toolsHostname: "tools.example.invalid",
    };
    expect(
      parseConfig(withConsult({ toolsBaseUrl: "https://tools.example.invalid" }, { tunnel })).tunnel
        .toolsHostname,
    ).toBe("tools.example.invalid");
    expect(() =>
      parseConfig(
        withConsult(
          { toolsBaseUrl: "https://tools.example.invalid" },
          { tunnel: { ...tunnel, toolsHostname: "other.example.invalid" } },
        ),
      ),
    ).toThrow(/toolsHostname/);
  });
});
