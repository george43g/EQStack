/**
 * Shared test doubles. Nothing in here touches the network, the keychain, or
 * a real phone — default tests are free and offline.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Config, parseConfig } from "../src/config/schema.js";
import type {
  AgentBrief,
  AgentConversation,
  AgentOutboundCallRequest,
  AgentOutboundCallResult,
  AgentPlatformPort,
  AgentTranscriptItem,
  Clock,
  IdProvider,
  LlmAdapter,
  LlmStreamRequest,
  OutboundCallSpec,
  PhoneLegHangupPort,
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

/** A phnum_ id that is obviously fake — the real one lives only in George's config. */
export const TEST_PHONE_NUMBER_ID = "phnum_test0000fake";

/**
 * testConfig plus an agentPlatform block. The long poll interval keeps the
 * background timer out of the way: tests drive `pollOnce()` explicitly.
 * Never pair this with startGateway WITHOUT `agentPlatform: new
 * FakeAgentPlatform()` — the real adapter would reach for the network (INV-14).
 */
export function delegateConfig(overrides: Record<string, unknown> = {}): Config {
  return testConfig({
    agentPlatform: {
      type: "elevenlabs-managed",
      phoneNumberId: TEST_PHONE_NUMBER_ID,
      pollIntervalMs: 60_000,
    },
    ...overrides,
  });
}

/** Documentation-range address (RFC 5737) standing in for an EL egress IP in tests. */
export const TEST_EL_EGRESS_IP = "192.0.2.10";

/**
 * delegateConfig plus agentPlatform.consult (Phase R). `.invalid` hostnames
 * only; the allowlist holds a documentation address so tests choose the
 * CF-Connecting-IP explicitly. Pair with FakeAgentPlatform, never the real
 * adapter (INV-14).
 */
export function consultConfig(
  consult: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {},
): Config {
  return testConfig({
    server: {
      publicBaseUrl: "https://gw.test.invalid",
      publicPort: 18790,
      adminPort: 18791,
      toolsPort: 18792,
    },
    agentPlatform: {
      type: "elevenlabs-managed",
      phoneNumberId: TEST_PHONE_NUMBER_ID,
      pollIntervalMs: 60_000,
      consult: {
        toolsBaseUrl: "https://tools.test.invalid",
        allowedSourceIps: [TEST_EL_EGRESS_IP],
        ...consult,
      },
    },
    ...overrides,
  });
}

/** Obviously fake voice ids for the meeting line-up (never a real EL voice). */
export const MEETING_TEST_VOICES = {
  lily: "voiceLilyTest",
  david: "voiceDavidTest",
  roger: "voiceRogerTest",
} as const;

/**
 * consultConfig plus a meeting block (PHASE-GC): chair `lily`, members
 * `executive` (David) and `eqstack` (Roger) — the proposed line-up (O-41),
 * with fake voice ids. Pair with FakeAgentPlatform only (INV-14).
 */
export function meetingConfig(
  meeting: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {},
  consult: Record<string, unknown> = {},
): Config {
  const base = testConfig();
  return consultConfig(consult, {
    profiles: {
      default: base.profiles.default,
      lily: {
        systemPrompt: "You are calling on behalf of George.",
        voice: { voiceId: MEETING_TEST_VOICES.lily, speed: 1 },
      },
      david: {
        systemPrompt: "You are calling on behalf of George.",
        voice: { voiceId: MEETING_TEST_VOICES.david, speed: 0.95, stability: 0.6 },
      },
      roger: {
        systemPrompt: "You are calling on behalf of George.",
        voice: { voiceId: MEETING_TEST_VOICES.roger, speed: 1.05, similarity: 0.75 },
      },
    },
    meeting: {
      chair: { voiceProfile: "lily" },
      members: {
        executive: {
          label: "Executive",
          displayName: "Executive",
          voiceProfile: "david",
          role: "George's chief of staff: priorities, commitments, coordination",
        },
        eqstack: {
          label: "Eqstack",
          displayName: "EQ Stack",
          voiceProfile: "roger",
          role: "builds the EQ Stack comms apps: imsg, gmail, telephony",
        },
      },
      ...meeting,
    },
    ...overrides,
  });
}

/**
 * Shorten the hold AFTER validation (the schema's 5 s floor is EL's, not a
 * logic rule), so hold-deadline tests run in milliseconds with real timers.
 */
export function withHoldMs(cfg: Config, holdMs: number): Config {
  const consult = cfg.agentPlatform?.consult;
  if (!consult) throw new Error("not a consult config");
  consult.holdSec = holdMs / 1000;
  if (cfg.meeting) cfg.meeting.holdSec = holdMs / 1000;
  return cfg;
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

export class ForbiddenPlatformCall extends Error {}

/** Obviously fake Twilio call SID: `CA` + zeros + a counter. */
export function fakeCallSid(n: number): string {
  return `CA${String(n).padStart(32, "0")}`;
}

/**
 * Offline PhoneLegHangupPort (INV-14): records each hang-up, and can answer
 * `already-ended` or throw, as Twilio would.
 */
export class FakePhoneLegHangup implements PhoneLegHangupPort {
  readonly id = "fake-hangup";
  hungUp: string[] = [];
  /** SIDs the carrier reports as no longer live (Twilio 21220). */
  ended = new Set<string>();
  failNext: string | null = null;

  async hangUp(phoneLegSid: string): Promise<"ended" | "already-ended"> {
    if (this.failNext) {
      const msg = this.failNext;
      this.failNext = null;
      throw new Error(msg);
    }
    this.hungUp.push(phoneLegSid);
    if (this.ended.has(phoneLegSid)) return "already-ended";
    this.ended.add(phoneLegSid);
    return "ended";
  }
}

/**
 * Offline AgentPlatformPort (INV-14). Records every call; `forbidMutations`
 * turns every create/update/dial into a throw, which is how the dryRun pin
 * proves nothing is created on the platform.
 */
export class FakeAgentPlatform implements AgentPlatformPort {
  readonly id = "fake-agent-platform";
  log: {
    created: AgentBrief[];
    updated: Array<{ agentId: string; brief: AgentBrief }>;
    calls: AgentOutboundCallRequest[];
    polls: string[];
  } = { created: [], updated: [], calls: [], polls: [] };
  forbidMutations = false;
  /** Agent ids the platform has "deleted" — updateAgent 404s on them. */
  deletedAgents = new Set<string>();
  failNextPoll: string | null = null;
  failNextCall: string | null = null;
  /** When false, placeOutboundCall returns no phone-leg SID (as EL may). */
  returnPhoneLegSid = true;
  private conversations = new Map<string, AgentConversation>();
  private n = 0;

  private guard(op: string): void {
    if (this.forbidMutations)
      throw new ForbiddenPlatformCall(`${op} called while mutations are forbidden`);
  }

  async createAgent(brief: AgentBrief): Promise<{ agentId: string }> {
    this.guard("createAgent");
    this.log.created.push(brief);
    return { agentId: `agent_fake${++this.n}` };
  }

  async updateAgent(agentId: string, brief: AgentBrief): Promise<void> {
    this.guard("updateAgent");
    if (this.deletedAgents.has(agentId)) {
      throw Object.assign(new Error(`agent ${agentId} not found`), { status: 404 });
    }
    this.log.updated.push({ agentId, brief });
  }

  async placeOutboundCall(req: AgentOutboundCallRequest): Promise<AgentOutboundCallResult> {
    this.guard("placeOutboundCall");
    if (this.failNextCall) {
      const msg = this.failNextCall;
      this.failNextCall = null;
      throw new Error(msg);
    }
    this.log.calls.push(req);
    const conversationId = `conv_fake${++this.n}`;
    this.conversations.set(conversationId, {
      conversationId,
      status: "initiated",
      transcript: [],
      terminationReason: null,
      callDurationSecs: null,
      hasAudio: false,
    });
    return {
      conversationId,
      phoneLegSid: this.returnPhoneLegSid ? fakeCallSid(this.n) : null,
    };
  }

  async getConversation(conversationId: string): Promise<AgentConversation> {
    this.log.polls.push(conversationId);
    if (this.failNextPoll) {
      const msg = this.failNextPoll;
      this.failNextPoll = null;
      throw new Error(msg);
    }
    const c = this.conversations.get(conversationId);
    if (!c)
      throw Object.assign(new Error(`conversation ${conversationId} not found`), { status: 404 });
    return structuredClone(c);
  }

  /** Test driver: move a conversation along (status, transcript, end metadata). */
  script(conversationId: string, patch: Partial<Omit<AgentConversation, "conversationId">>): void {
    const c = this.conversations.get(conversationId);
    if (!c) throw new Error(`no conversation ${conversationId}`);
    this.conversations.set(conversationId, { ...c, ...patch });
  }
}

export function said(role: "user" | "agent", text: string | null, t = 0): AgentTranscriptItem {
  return { role, text, timeInCallSecs: t, interrupted: false };
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
