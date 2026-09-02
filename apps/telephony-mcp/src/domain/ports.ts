/**
 * Ports — the seams between domain logic and the outside world. v1 ships
 * `twilio-conversation-relay` + `openai-compatible`; `elevenlabs-managed`
 * and `twilio-media-streams` are reserved adapter ids (config-accepted,
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
