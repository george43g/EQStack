import type { RecordingPolicy } from "../config/schema.js";

export type CallStatus = "created" | "initiated" | "ringing" | "answered" | "completed" | "failed";

/** Ordering used to reject out-of-order provider callbacks (never downgrade). */
export const CALL_STATUS_RANK: Record<CallStatus, number> = {
  created: 0,
  initiated: 1,
  ringing: 2,
  answered: 3,
  completed: 4,
  failed: 4,
};

export const TERMINAL_STATUSES: ReadonlySet<CallStatus> = new Set(["completed", "failed"]);

export interface CallRecord {
  id: string;
  providerCallId: string | null;
  requestId: string;
  recipientAlias: string;
  /** Last four digits only — the full number never leaves config. */
  numberSuffix: string;
  profile: string;
  objective: string;
  status: CallStatus;
  recordingEnabled: boolean;
  recordingPolicy: RecordingPolicy;
  maxDurationSec: number;
  createdAtMs: number;
  updatedAtMs: number;
  endedAtMs: number | null;
  endReason: string | null;
}

export interface CallEvent {
  /** Global monotonic id — the cross-call event cursor. */
  id: number;
  callId: string;
  /** Per-call sequence — the per-call event cursor. */
  seq: number;
  tsMs: number;
  type: string;
  data: Record<string, unknown>;
}

export interface Utterance {
  id: number;
  callId: string;
  turn: number;
  role: "user" | "assistant";
  text: string;
  tsMs: number;
  interrupted: boolean;
}

export interface RecordingMeta {
  providerRecordingId: string;
  callId: string;
  durationSec: number | null;
  channels: number;
  encryptedPath: string | null;
  sizeBytes: number | null;
  deletedLocal: boolean;
  deletedProvider: boolean;
  createdAtMs: number;
}

/**
 * Who conducts the conversation: "llm" streams the configured model's replies;
 * "direct" records the callee's utterances and waits for the MCP host to
 * answer via voice_say — the host IS the conversational brain.
 */
export type CallMode = "llm" | "direct";

export interface CallRequest {
  id: string;
  recipientAlias: string;
  numberSuffix: string;
  objective: string;
  /** Free-form context the initiating agent chose to pass along. */
  context: string | null;
  profile: string;
  mode: CallMode;
  recordingEnabled: boolean;
  maxDurationSec: number;
  createdAtMs: number;
  expiresAtMs: number;
  /** Set once voice_start_call dials — retries return this call instead of redialing. */
  startedCallId: string | null;
}

export interface TurnTiming {
  callId: string;
  turn: number;
  endOfTurnMs: number | null;
  firstModelTokenMs: number | null;
  firstTokenToTwilioMs: number | null;
  interruptedAtMs: number | null;
}
