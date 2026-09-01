/**
 * TwilioConversationRelayAdapter — outbound calls with inline
 * ConversationRelay TwiML, REST auth via API key/secret. Twilio manages STT,
 * TTS, and interruption; we keep the LLM and history.
 *
 * ElevenLabs voice string format for ConversationRelay:
 *   "<voiceId>" | "<voiceId>-<model>" | "<voiceId>-<model>-<speed>_<stability>_<similarity>"
 */
import type { VoiceConfig } from "../../config/schema.js";
import type { OutboundCallSpec, TelephonyAdapter } from "../../domain/ports.js";

export class TwilioApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface TwilioCredentials {
  accountSid: string;
  apiKey: string;
  apiSecret: string;
}

/** Twilio's ElevenLabs settings parser rejects bare integers ("1"); always emit a decimal point. */
function decimal(n: number): string {
  return Number.isInteger(n) ? n.toFixed(1) : String(n);
}

export function buildVoiceString(v: VoiceConfig): string {
  if (v.stability !== undefined && v.similarity !== undefined) {
    return `${v.voiceId}-${v.model}-${decimal(v.speed)}_${decimal(v.stability)}_${decimal(v.similarity)}`;
  }
  return `${v.voiceId}-${v.model}`;
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function buildConversationRelayTwiml(spec: OutboundCallSpec): string {
  const v = spec.voice;
  const attrs: Record<string, string> = {
    url: spec.relayWsUrl,
    ttsProvider: v.ttsProvider,
    voice: buildVoiceString(v),
    language: v.language,
    transcriptionProvider: v.transcription.provider,
    speechModel: v.transcription.model,
    interruptible: "speech",
  };
  if (spec.greeting) attrs.welcomeGreeting = spec.greeting;
  const attrText = Object.entries(attrs)
    .map(([k, val]) => `${k}="${xmlEscape(val)}"`)
    .join(" ");
  return `<Response><Connect><ConversationRelay ${attrText} /></Connect></Response>`;
}

export class TwilioConversationRelayAdapter implements TelephonyAdapter {
  readonly id = "twilio-conversation-relay";
  private apiBase: string;

  constructor(
    private creds: TwilioCredentials,
    private fetchImpl: typeof fetch = fetch,
    apiBase = "https://api.twilio.com",
  ) {
    this.apiBase = `${apiBase}/2010-04-01/Accounts/${creds.accountSid}`;
  }

  private async request(
    method: "POST" | "GET" | "DELETE",
    path: string,
    form?: Record<string, string | string[]>,
  ): Promise<Response> {
    const auth = Buffer.from(`${this.creds.apiKey}:${this.creds.apiSecret}`).toString("base64");
    const headers: Record<string, string> = { Authorization: `Basic ${auth}` };
    let body: string | undefined;
    if (form) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(form)) {
        if (Array.isArray(v)) for (const item of v) params.append(k, item);
        else params.set(k, v);
      }
      body = params.toString();
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    }
    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = body;
    const res = await this.fetchImpl(`${this.apiBase}${path}`, init);
    if (!res.ok && res.status !== 404) {
      const text = await res.text().catch(() => "");
      throw new TwilioApiError(
        res.status,
        `Twilio ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`,
      );
    }
    return res;
  }

  async createCall(spec: OutboundCallSpec): Promise<{ providerCallId: string }> {
    const form: Record<string, string | string[]> = {
      To: spec.to,
      From: spec.from,
      Twiml: buildConversationRelayTwiml(spec),
      StatusCallback: spec.statusCallbackUrl,
      StatusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      StatusCallbackMethod: "POST",
      TimeLimit: String(spec.timeLimitSec),
    };
    if (spec.record) {
      form.Record = "true";
      form.RecordingChannels = "dual";
      form.RecordingStatusCallback = spec.recordingStatusCallbackUrl;
      form.RecordingStatusCallbackEvent = ["completed"];
    }
    const res = await this.request("POST", "/Calls.json", form);
    const json = (await res.json()) as { sid?: string };
    if (!json.sid) throw new TwilioApiError(res.status, "Twilio create call returned no sid");
    return { providerCallId: json.sid };
  }

  async endCall(providerCallId: string): Promise<void> {
    await this.request("POST", `/Calls/${encodeURIComponent(providerCallId)}.json`, {
      Status: "completed",
    });
  }

  async startRecording(providerCallId: string, recordingStatusCallbackUrl: string): Promise<void> {
    await this.request("POST", `/Calls/${encodeURIComponent(providerCallId)}/Recordings.json`, {
      RecordingChannels: "dual",
      RecordingStatusCallback: recordingStatusCallbackUrl,
      RecordingStatusCallbackEvent: ["completed"],
    });
  }

  async stopRecording(providerCallId: string): Promise<void> {
    // "Twilio.CURRENT" targets the active recording on the call.
    await this.request(
      "POST",
      `/Calls/${encodeURIComponent(providerCallId)}/Recordings/Twilio.CURRENT.json`,
      { Status: "stopped" },
    );
  }

  async fetchRecording(providerRecordingId: string): Promise<Uint8Array> {
    const res = await this.request(
      "GET",
      `/Recordings/${encodeURIComponent(providerRecordingId)}.wav?RequestedChannels=2`,
    );
    if (res.status === 404) {
      throw new TwilioApiError(404, `recording ${providerRecordingId} not found at provider`);
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  async deleteRecording(providerRecordingId: string): Promise<void> {
    await this.request("DELETE", `/Recordings/${encodeURIComponent(providerRecordingId)}.json`);
  }
}
