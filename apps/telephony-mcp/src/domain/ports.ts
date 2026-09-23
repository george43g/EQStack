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
import type { PreviewAgentSpec, PreviewToolCall, PreviewVoiceState } from "./voice-preview.js";

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
 * Phase R adds `registerMcpServer` here — never a second client.
 */
export interface AgentPlatformPort {
  readonly id: string;
  createAgent(brief: AgentBrief): Promise<{ agentId: string }>;
  /** Throws an error carrying `status: 404` when the agent no longer exists. */
  updateAgent(agentId: string, brief: AgentBrief): Promise<void>;
  placeOutboundCall(req: AgentOutboundCallRequest): Promise<{ conversationId: string }>;
  getConversation(conversationId: string): Promise<AgentConversation>;
}

/**
 * The voice-preview seam (src/domain/voice-preview.ts). Separate from
 * AgentPlatformPort because it never dials and never touches the call DB:
 * the preview agent is found by its workspace NAME, and the agent itself is
 * where George's adjustments live between sessions — so there is no sqlite
 * mapping and nothing for `serve` to own.
 */
export interface VoicePreviewPort {
  /** Newest agent whose name matches exactly, with its per-label voice settings; null if none. */
  findPreviewAgent(name: string): Promise<{ agentId: string; voices: PreviewVoiceState[] } | null>;
  createPreviewAgent(spec: PreviewAgentSpec): Promise<{ agentId: string }>;
  updatePreviewAgent(agentId: string, spec: PreviewAgentSpec): Promise<void>;
  /** The platform's hosted mic/speaker page for this agent. */
  talkUrl(agentId: string): string;
  /** Newest first. */
  listPreviewConversations(
    agentId: string,
    limit: number,
  ): Promise<
    Array<{ conversationId: string; status: AgentConversationStatus; startedAtSecs: number }>
  >;
  /** Status + the tool calls, in transcript order (empty until the platform finishes it). */
  getPreviewConversation(conversationId: string): Promise<{
    conversationId: string;
    status: AgentConversationStatus;
    toolCalls: PreviewToolCall[];
  }>;
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
