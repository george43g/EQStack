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
 * Who conducts the conversation (D-34 taxonomy, four modes):
 *   direct     — the MCP host IS the conversational brain: it waits for each
 *                turn.user event and answers verbatim via say_on_call.
 *   delegate   — a briefed ElevenLabs agent runs the whole call off-device.
 *   consult    — delegate, plus the EL agent may call back into our MCP
 *                mid-call and speak the answer.
 *   byo-model  — our gateway streams a configured model's replies (today's
 *                implemented LLM loop; the legacy persisted name is "llm").
 *
 * Adding a mode is adding a CALL_MODES member plus a CALL_MODE_SPECS row —
 * never a new string comparison. Session code branches on spec predicates.
 */
export const CALL_MODES = ["direct", "delegate", "consult", "byo-model"] as const;
export type CallMode = (typeof CALL_MODES)[number];

/** Legacy persisted/input values accepted for one deprecation window. */
export const LEGACY_MODE_ALIASES: Readonly<Record<string, CallMode>> = { llm: "byo-model" };

export interface CallModeSpec {
  /** Does OUR gateway run an LLM loop for each turn? */
  gatewayDrivesTurns: boolean;
  /** Does the MCP host answer each turn via say_on_call? */
  hostAnswersTurns: boolean;
  /** Does ElevenLabs own the call leg (laptop out of the media path — INV-7)? */
  mediaPathOffDevice: boolean;
  /** May the call re-enter our MCP mid-turn (the consult loop)? */
  supportsConsult: boolean;
  /** False until the mode's phase ships; construction is refused meanwhile. */
  implemented: boolean;
}

export const CALL_MODE_SPECS: Record<CallMode, CallModeSpec> = {
  direct: {
    gatewayDrivesTurns: false,
    hostAnswersTurns: true,
    mediaPathOffDevice: false,
    supportsConsult: false,
    implemented: true,
  },
  delegate: {
    gatewayDrivesTurns: false,
    hostAnswersTurns: false,
    mediaPathOffDevice: true,
    supportsConsult: false,
    implemented: false,
  },
  consult: {
    gatewayDrivesTurns: false,
    hostAnswersTurns: false,
    mediaPathOffDevice: true,
    supportsConsult: true,
    implemented: false,
  },
  "byo-model": {
    gatewayDrivesTurns: true,
    hostAnswersTurns: false,
    mediaPathOffDevice: false,
    supportsConsult: false,
    implemented: true,
  },
};

/**
 * Normalize a raw persisted/input mode value: maps legacy aliases, degrades
 * unknown values (a newer DB read by an older binary) to "byo-model" instead
 * of type-lying via a cast. Pure — callers compare in/out to decide to warn.
 */
export function normalizeCallMode(raw: unknown): CallMode {
  if (typeof raw === "string") {
    if ((CALL_MODES as readonly string[]).includes(raw)) return raw as CallMode;
    const alias = LEGACY_MODE_ALIASES[raw];
    if (alias) return alias;
  }
  return "byo-model";
}

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
  /** Set once the one-shot dial creates the call — retries return this call instead of redialing. */
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
