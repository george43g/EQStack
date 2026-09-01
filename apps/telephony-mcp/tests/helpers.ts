/**
 * Shared test doubles. Nothing in here touches the network, the keychain, or
 * a real phone — default tests are free and offline.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Config, parseConfig } from "../src/config/schema.js";
import type {
  Clock,
  IdProvider,
  LlmAdapter,
  LlmStreamRequest,
  OutboundCallSpec,
  RecordingStore,
  SecretProvider,
  TelephonyAdapter,
} from "../src/domain/ports.js";

export class FixedClock implements Clock {
  constructor(public now = 1_754_000_000_000) {}
  nowMs(): number {
    return this.now;
  }
  advance(ms: number): void {
    this.now += ms;
  }
}

export function seqIds(prefix = "id"): IdProvider {
  let n = 0;
  return {
    newId: () => `${prefix}-${++n}`,
    newToken: () => `token${++n}abcdef1234567890abcdef1234567890`,
  };
}

export function testConfig(overrides: Record<string, unknown> = {}): Config {
  return parseConfig({
    server: { publicBaseUrl: "https://gw.test.invalid", publicPort: 18790, adminPort: 18791 },
    telephony: { fromNumber: "+61255501234" },
    llm: { type: "openai-compatible", model: "primary-model", fallbackModel: "fallback-model" },
    voice: { voiceId: "voice123", stability: 0.7, similarity: 0.8 },
    recipients: {
      george: { number: "+61400111222", recordingPolicy: "preconsented" },
      friend: { number: "+61400333444", recordingPolicy: "manual" },
      private: { number: "+61400555666", recordingPolicy: "never" },
    },
    profiles: {
      default: {
        systemPrompt: "You are calling on behalf of George.",
        greeting: "Hi, this is George's assistant.",
      },
    },
    ...overrides,
  });
}

export function tempStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "voice-mcp-test-"));
  process.env.TEL_STATE_DIR = dir;
  return dir;
}

export class FakeSecrets implements SecretProvider {
  constructor(private values: Record<string, string>) {}
  async get(name: string): Promise<string | null> {
    return this.values[name] ?? null;
  }
}

export const TEST_TWILIO_AUTH_TOKEN = "test-auth-token-0123456789abcdef";

export function fakeSecretValues(): Record<string, string> {
  return {
    TWILIO_ACCOUNT_SID: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    TWILIO_API_KEY: "SKxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    TWILIO_API_SECRET: "secret",
    TWILIO_AUTH_TOKEN: TEST_TWILIO_AUTH_TOKEN,
    OPENROUTER_API_KEY: "sk-or-v1-testkey000000000000",
  };
}

export interface FakeTelephonyLog {
  calls: OutboundCallSpec[];
  ended: string[];
  recordingStarts: string[];
  recordingStops: string[];
  deletedRecordings: string[];
}

export class FakeTelephony implements TelephonyAdapter {
  readonly id = "fake";
  log: FakeTelephonyLog = {
    calls: [],
    ended: [],
    recordingStarts: [],
    recordingStops: [],
    deletedRecordings: [],
  };
  failNextCreate: string | null = null;
  recordingBytes = new Uint8Array(Buffer.from("RIFFfakewavdata"));
  private n = 0;

  async createCall(spec: OutboundCallSpec): Promise<{ providerCallId: string }> {
    if (this.failNextCreate) {
      const msg = this.failNextCreate;
      this.failNextCreate = null;
      throw new Error(msg);
    }
    this.log.calls.push(spec);
    return { providerCallId: `CAfake${String(++this.n).padStart(4, "0")}` };
  }
  async endCall(providerCallId: string): Promise<void> {
    this.log.ended.push(providerCallId);
  }
  async startRecording(providerCallId: string): Promise<void> {
    this.log.recordingStarts.push(providerCallId);
  }
  async stopRecording(providerCallId: string): Promise<void> {
    this.log.recordingStops.push(providerCallId);
  }
  async fetchRecording(): Promise<Uint8Array> {
    return this.recordingBytes;
  }
  async deleteRecording(providerRecordingId: string): Promise<void> {
    this.log.deletedRecordings.push(providerRecordingId);
  }
}

export interface ScriptedTurn {
  tokens: string[];
  /** ms between tokens (lets tests interrupt mid-stream). */
  tokenDelayMs?: number;
  /** Throw before the first token (exercises fallback in the adapter path). */
  failBeforeFirstToken?: boolean;
}

export class ScriptedLlm implements LlmAdapter {
  readonly id = "scripted";
  aborts = 0;
  requests: LlmStreamRequest[] = [];
  constructor(public turns: ScriptedTurn[]) {}

  async *stream(req: LlmStreamRequest): AsyncGenerator<string, void, unknown> {
    this.requests.push(req);
    const turn = this.turns.shift();
    if (!turn) return;
    if (turn.failBeforeFirstToken) throw new Error("scripted LLM failure");
    for (const token of turn.tokens) {
      if (req.signal.aborted) {
        this.aborts += 1;
        return;
      }
      if (turn.tokenDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, turn.tokenDelayMs));
        if (req.signal.aborted) {
          this.aborts += 1;
          return;
        }
      }
      yield token;
    }
  }
}

export class MemoryRecordingStore implements RecordingStore {
  files = new Map<string, Uint8Array>();
  async store(id: string, plain: Uint8Array): Promise<{ path: string; sizeBytes: number }> {
    this.files.set(id, plain);
    return { path: `/memory/${id}.enc`, sizeBytes: plain.length };
  }
  async load(id: string): Promise<Uint8Array> {
    const f = this.files.get(id);
    if (!f) throw new Error("missing recording");
    return f;
  }
  async deleteLocal(id: string): Promise<boolean> {
    return this.files.delete(id);
  }
  hasLocal(id: string): boolean {
    return this.files.has(id);
  }
}
