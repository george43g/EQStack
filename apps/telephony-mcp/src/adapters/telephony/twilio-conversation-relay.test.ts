import { describe, expect, it } from "vitest";
import type { OutboundCallSpec } from "../../domain/ports.js";
import {
  buildConversationRelayTwiml,
  buildVoiceString,
  TwilioApiError,
  TwilioConversationRelayAdapter,
} from "./twilio-conversation-relay.js";

function spec(overrides: Partial<OutboundCallSpec> = {}): OutboundCallSpec {
  return {
    to: "+61400111222",
    from: "+61255501234",
    relayWsUrl: "wss://gw.test.invalid/relay/tok123",
    statusCallbackUrl: "https://gw.test.invalid/twilio/status",
    recordingStatusCallbackUrl: "https://gw.test.invalid/twilio/recording",
    record: false,
    timeLimitSec: 900,
    voice: {
      ttsProvider: "ElevenLabs",
      voiceId: "voice123",
      model: "flash_v2_5",
      speed: 1,
      stability: 0.7,
      similarity: 0.8,
      language: "en-AU",
      transcription: { provider: "Deepgram", model: "flux" },
    },
    greeting: 'Hi — this is George\'s assistant & "helper"',
    ...overrides,
  };
}

describe("ElevenLabs voice string", () => {
  it("includes model and settings when stability/similarity are set", () => {
    expect(buildVoiceString(spec().voice)).toBe("voice123-flash_v2_5-1.0_0.7_0.8");
  });
  it("omits the settings suffix when not configured", () => {
    const v = { ...spec().voice };
    delete (v as Record<string, unknown>).stability;
    delete (v as Record<string, unknown>).similarity;
    expect(buildVoiceString(v)).toBe("voice123-flash_v2_5");
  });
});

describe("ConversationRelay TwiML", () => {
  it("renders the relay element with voice, language, and Deepgram Flux STT", () => {
    const xml = buildConversationRelayTwiml(spec());
    expect(xml).toContain('url="wss://gw.test.invalid/relay/tok123"');
    expect(xml).toContain('ttsProvider="ElevenLabs"');
    expect(xml).toContain('voice="voice123-flash_v2_5-1.0_0.7_0.8"');
    expect(xml).toContain('language="en-AU"');
    expect(xml).toContain('transcriptionProvider="Deepgram"');
    expect(xml).toContain('speechModel="flux"');
    expect(xml).toContain('interruptible="speech"');
  });

  it("XML-escapes attribute values (greeting with quotes/ampersand)", () => {
    const xml = buildConversationRelayTwiml(spec());
    expect(xml).toContain("&amp;");
    expect(xml).toContain("&quot;helper&quot;");
    expect(xml).not.toMatch(/welcomeGreeting="[^"]*"[^"]*""/);
  });

  it("omits welcomeGreeting when no greeting is set", () => {
    const xml = buildConversationRelayTwiml(spec({ greeting: undefined }));
    expect(xml).not.toContain("welcomeGreeting");
  });
});

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init: init ?? {} });
    return handler(u, init ?? {});
  }) as typeof fetch;
  return { fn, calls };
}

const creds = { accountSid: "AC123", apiKey: "SK123", apiSecret: "shh" };

describe("TwilioConversationRelayAdapter REST calls", () => {
  it("creates a call with inline TwiML, status callbacks, and time limit", async () => {
    const { fn, calls } = fakeFetch(
      () => new Response(JSON.stringify({ sid: "CA999" }), { status: 201 }),
    );
    const adapter = new TwilioConversationRelayAdapter(creds, fn);
    const result = await adapter.createCall(spec());
    expect(result.providerCallId).toBe("CA999");
    const call = calls[0];
    expect(call?.url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC123/Calls.json");
    const body = new URLSearchParams(String(call?.init.body));
    expect(body.get("To")).toBe("+61400111222");
    expect(body.get("Twiml")).toContain("<ConversationRelay");
    expect(body.get("TimeLimit")).toBe("900");
    expect(body.getAll("StatusCallbackEvent")).toEqual([
      "initiated",
      "ringing",
      "answered",
      "completed",
    ]);
    expect(body.get("Record")).toBeNull(); // record:false → no recording params
    const headers = (call?.init.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from("SK123:shh").toString("base64")}`);
  });

  it("adds dual-channel recording params when record is on", async () => {
    const { fn, calls } = fakeFetch(
      () => new Response(JSON.stringify({ sid: "CA1000" }), { status: 201 }),
    );
    const adapter = new TwilioConversationRelayAdapter(creds, fn);
    await adapter.createCall(spec({ record: true }));
    const body = new URLSearchParams(String(calls[0]?.init.body));
    expect(body.get("Record")).toBe("true");
    expect(body.get("RecordingChannels")).toBe("dual");
    expect(body.get("RecordingStatusCallback")).toBe("https://gw.test.invalid/twilio/recording");
  });

  it("surfaces provider errors with status and body excerpt", async () => {
    const { fn: errFetch } = fakeFetch(() => new Response('{"message":"nope"}', { status: 400 }));
    const adapter = new TwilioConversationRelayAdapter(creds, errFetch);
    await expect(adapter.createCall(spec())).rejects.toThrow(TwilioApiError);
  });

  it("ends a call by setting status completed", async () => {
    const { fn, calls } = fakeFetch(() => new Response("{}", { status: 200 }));
    const adapter = new TwilioConversationRelayAdapter(creds, fn);
    await adapter.endCall("CA42");
    expect(calls[0]?.url).toContain("/Calls/CA42.json");
    expect(new URLSearchParams(String(calls[0]?.init.body)).get("Status")).toBe("completed");
  });

  it("requests dual-channel audio when fetching a recording", async () => {
    const { fn, calls } = fakeFetch(() => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    const adapter = new TwilioConversationRelayAdapter(creds, fn);
    const bytes = await adapter.fetchRecording("RE1");
    expect(bytes.length).toBe(3);
    expect(calls[0]?.url).toContain("/Recordings/RE1.wav?RequestedChannels=2");
  });
});
