/**
 * Ports — the seams between domain logic and the outside world. v1 ships
 * `twilio-conversation-relay` + `openai-compatible`, plus (Phase Q) the
 * `elevenlabs-managed` AgentPlatformPort for `delegate` calls. D-75 reversed
 * the Phase B reservation of `elevenlabs-managed` as a TelephonyAdapter id:
 * that id now names an agent platform, configured under `agentPlatform`.
 * `twilio-media-streams` stays a reserved telephony id (config-accepted,
 * construction-refused).
 */
import type { VoiceConfig } from "../config/schema.js";
import type {
  CallEvent,
  CallRecord,
  CallRequest,
  CallStatus,
  RecordingMeta,
  TurnTiming,
  Utterance,
} from "./types.js";

export interface Clock {
  nowMs(): number;
}

export interface IdProvider {
  /** Entity ids (calls, requests). */
  newId(): string;
  /** Unguessable relay-path tokens. */
  newToken(): string;
}

export const systemClock: Clock = { nowMs: () => Date.now() };

export interface OutboundCallSpec {
  /** Full E.164 — flows config → adapter only; never stored or logged. */
  to: string;
  from: string;
  relayWsUrl: string;
  statusCallbackUrl: string;
  recordingStatusCallbackUrl: string;
  record: boolean;
  timeLimitSec: number;
  voice: VoiceConfig;
  greeting: string | undefined;
}

export interface TelephonyAdapter {
  readonly id: string;
  createCall(spec: OutboundCallSpec): Promise<{ providerCallId: string }>;
  endCall(providerCallId: string): Promise<void>;
  /** Start dual-channel recording on a live call (manual-consent flow). */
  startRecording(providerCallId: string, recordingStatusCallbackUrl: string): Promise<void>;
  stopRecording(providerCallId: string): Promise<void>;
  fetchRecording(providerRecordingId: string): Promise<Uint8Array>;
  deleteRecording(providerRecordingId: string): Promise<void>;
}

// ── Agent platform (Phase Q, D-75) ────────────────────────────────────────
//
// In a mode whose spec has `mediaPathOffDevice`, a third-party agent platform
// holds the phone leg end to end: we brief an agent, start the call, and poll
// the conversation back into our event store. There is no media stream, relay
// token or webhook on our side (INV-7, INV-10).

/**
 * Everything an agent is provisioned from. Pure data, built by
 * `buildBrief` (src/domain/agent-brief.ts) and hashed there, so provisioning
 * is idempotent: an unchanged brief never touches the platform twice.
 * Carries no phone number (INV-11) — the callee reaches only the call request.
 */
export interface AgentBrief {
  /** Deterministic workspace name: `eqstack-<profile>[-recorded]`. */
  name: string;
  /** Harness preamble + profile.systemPrompt + the per-call objective template. */
  prompt: string;
  /** Spoken as soon as the callee answers; null = the agent waits for them. */
  firstMessage: string | null;
  /** ISO 639-1 language the agent speaks and transcribes ("en"). */
  language: string;
  voice: {
    voiceId: string;
    speed: number;
    stability: number | null;
    similarityBoost: number | null;
  };
  /** The platform ends the call itself at this cap (we cannot hang up — see PHASE-Q). */
  maxDurationSec: number;
  /**
   * Whether the PLATFORM records the audio (D-76). Recording is an agent-level
   * setting fixed at call start, which is why a recorded call uses its own agent.
   */
  recordVoice: boolean;
}

export interface AgentOutboundCallRequest {
  agentId: string;
  /** The platform's id for its own number (EL `phnum_…`). Never logged. */
  phoneNumberId: string;
  /** Full E.164 — flows config → adapter only; never stored or logged (INV-11). */
  to: string;
  /** Per-call values the agent prompt references (objective, context). No numbers. */
  dynamicVariables: Record<string, string>;
}

/** Conversation lifecycle, as the platform reports it. `done`/`failed` are terminal. */
export const AGENT_CONVERSATION_STATUSES = [
  "initiated",
  "in-progress",
  "processing",
  "done",
  "failed",
] as const;
export type AgentConversationStatus = (typeof AGENT_CONVERSATION_STATUSES)[number];

export interface AgentTranscriptItem {
  role: "user" | "agent";
  /** Null for non-speech entries (tool calls); those never become utterances. */
  text: string | null;
  timeInCallSecs: number;
  interrupted: boolean;
}

/** The parsed, number-free view of one conversation (INV-6: Zod-parsed at the adapter). */
export interface AgentConversation {
  conversationId: string;
  status: AgentConversationStatus;
  transcript: AgentTranscriptItem[];
  terminationReason: string | null;
  callDurationSecs: number | null;
  /** True when the platform holds audio for this conversation (a D-76 recording). */
  hasAudio: boolean;
}

/**
 * The agent-platform seam. Deliberately lower-level than the phase file's
 * sketch: `ensureAgent` is create/update + OUR sqlite mapping, so the
 * "ensure" half lives in the call service (the adapter never touches the
 * store), and there is no `endConversation` because ElevenLabs exposes no
 * endpoint that hangs up a live conversation (PHASE-Q § Implementation notes).
 * Hanging up goes around the platform instead, to the carrier that holds the
 * phone leg — `PhoneLegHangupPort` (O-30) — which is why `placeOutboundCall`
 * returns the leg's carrier id alongside the conversation id.
 * Phase R adds `registerMcpServer` here — never a second client.
 */
export interface AgentPlatformPort {
  readonly id: string;
  createAgent(brief: AgentBrief): Promise<{ agentId: string }>;
  /** Throws an error carrying `status: 404` when the agent no longer exists. */
  updateAgent(agentId: string, brief: AgentBrief): Promise<void>;
  placeOutboundCall(req: AgentOutboundCallRequest): Promise<AgentOutboundCallResult>;
  getConversation(conversationId: string): Promise<AgentConversation>;
}

export interface AgentOutboundCallResult {
  /** The platform's conversation id — what `CallRecord.providerCallId` holds. */
  conversationId: string;
  /**
   * The carrier's id for the phone leg the platform placed (a Twilio `CA…`
   * call SID), or null when the platform did not return a well-formed one.
   * Only a `PhoneLegHangupPort` uses it.
   */
  phoneLegSid: string | null;
}

/**
 * Hangs up the phone leg of a call whose media path is off-device (O-30):
 * the platform holds the conversation but not the carrier, so the carrier can
 * end it. Resolves `already-ended` when the carrier says the leg is no longer
 * live, so a repeated end_call is idempotent; throws on anything else.
 */
export interface PhoneLegHangupPort {
  readonly id: string;
  hangUp(phoneLegSid: string): Promise<"ended" | "already-ended">;
}

/** One row of the `agent_profiles` table: which platform agent serves a brief key. */
export interface AgentProfileRecord {
  /** `<profile>` or `<profile>+recorded` (see agentKey in agent-brief.ts). */
  agentKey: string;
  agentId: string;
  briefHash: string;
  updatedAtMs: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmStreamRequest {
  messages: ChatMessage[];
  model: string;
  fallbackModel: string | undefined;
  signal: AbortSignal;
  /** Called if the primary model failed before any token and fallback engaged. */
  onFallback?: (fromModel: string, toModel: string, reason: string) => void;
}

export interface LlmAdapter {
  readonly id: string;
  /** Yields text deltas. Returns cleanly on abort; throws on unrecoverable failure. */
  stream(req: LlmStreamRequest): AsyncGenerator<string, void, unknown>;
}

export interface SecretProvider {
  /** Resolve a secret by variable name (env first, then keychain). Null = absent. */
  get(name: string): Promise<string | null>;
}

export interface EventStore {
  createCallRequest(req: CallRequest): void;
  getCallRequest(id: string): CallRequest | null;
  markRequestStarted(id: string, callId: string): void;

  createCall(call: CallRecord): void;
  getCall(id: string): CallRecord | null;
  getCallByProviderId(providerCallId: string): CallRecord | null;
  setProviderCallId(id: string, providerCallId: string): void;
  /** Off-device calls only: the carrier id of the phone leg (O-30). Never on CallRecord. */
  setPhoneLegSid(id: string, phoneLegSid: string): void;
  getPhoneLegSid(id: string): string | null;
  updateCallStatus(
    id: string,
    status: CallStatus,
    opts?: { endedAtMs?: number; endReason?: string },
  ): void;
  setRecordingEnabled(id: string, enabled: boolean): void;
  listCalls(opts?: { limit?: number; beforeMs?: number; status?: CallStatus }): CallRecord[];
  activeCallCount(): number;

  appendEvent(callId: string, type: string, data: Record<string, unknown>): CallEvent;
  getEvents(callId: string, afterSeq?: number, limit?: number): CallEvent[];
  getGlobalEvents(afterId?: number, limit?: number): CallEvent[];
  /** Returns false when the provider key was already seen (replay/duplicate). */
  recordProviderEvent(callId: string, providerKey: string): boolean;

  addUtterance(u: Omit<Utterance, "id">): Utterance;
  getTranscript(callId: string): Utterance[];
  searchTranscripts(query: string, limit?: number): Array<Utterance & { callId: string }>;
  searchCalls(query: string, limit?: number): CallRecord[];

  upsertRecording(meta: RecordingMeta): void;
  getRecording(providerRecordingId: string): RecordingMeta | null;
  getRecordingsForCall(callId: string): RecordingMeta[];
  markRecordingDeleted(providerRecordingId: string, scope: "local" | "provider"): void;

  upsertTiming(t: Pick<TurnTiming, "callId" | "turn"> & Partial<TurnTiming>): void;
  stampDeliveredIfUnset(callId: string, turn: number, ms: number): void;
  getTimings(callId: string): TurnTiming[];

  getAgentProfile(agentKey: string): AgentProfileRecord | null;
  upsertAgentProfile(record: AgentProfileRecord): void;

  close(): void;
}

export interface RecordingStore {
  /** Encrypts and persists; returns { path, sizeBytes } of the ciphertext file. */
  store(
    providerRecordingId: string,
    plain: Uint8Array,
  ): Promise<{ path: string; sizeBytes: number }>;
  /** Decrypts into memory (export/playback paths wrap this). */
  load(providerRecordingId: string): Promise<Uint8Array>;
  deleteLocal(providerRecordingId: string): Promise<boolean>;
  hasLocal(providerRecordingId: string): boolean;
}
