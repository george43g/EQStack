/**
 * The command surface — ONE definition per operation (INV-5, D-6).
 *
 * Pure metadata + schemas; no handlers and no I/O here. Two bindings consume
 * these specs:
 *   - bind-client.ts   → mcp-kit ToolDefinitions for MCP-stdio / CLI / console
 *                        (mutations proxy the localhost admin API)
 *   - admin-server.ts  → the REST route table parses with the same schemas and
 *                        calls CallService directly (the serve process is the
 *                        single writer — INV-9)
 *
 * Phase C merged `prepare_call`+`start_call` into the one-shot `place_call`
 * (D-5/D-38/D-55): any E.164 dials (D-3), dryRun previews, the keyed dedupe
 * claim replaces the TTL'd two-stage flow. Names follow INV-1/D-2: no
 * prefix, self-describing.
 */
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  AfterSeqSchema,
  BeforeMsSchema,
  CallEventSchema,
  CallIdSchema,
  CallModeInputSchema,
  CallPlanSchema,
  CallRecordSchema,
  ConfirmSchema,
  EndReasonSchema,
  EventLimitSchema,
  LimitSchema,
  ObjectiveSchema,
  RecordingMetaSchema,
  RecordingScopeSchema,
  RecordingSidSchema,
  SayTextSchema,
  SearchQuerySchema,
  TurnTimingSchema,
  UtteranceSchema,
  WaitMsSchema,
} from "./contracts.js";

export interface CommandSpec<
  TInput extends z.ZodTypeAny = z.ZodTypeAny,
  TOutput extends z.ZodTypeAny = z.ZodTypeAny,
> {
  name: string;
  description: string;
  input: TInput;
  output: TOutput;
  annotations: ToolAnnotations;
  timeoutMs?: number;
}

const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export const placeCall = {
  name: "place_call",
  description:
    "Place a REAL, PAID phone call to a REAL person. `to` is a configured recipient alias OR any raw E.164 number (+<country><number>) — dialing is not gated (aliases are nicknames + defaults, never permissions). Ad-hoc numbers start unrecorded (recordingPolicy 'manual'). Use dryRun: true to preview the resolved plan without dialing. Identical retries inside the dedupe window return the already-created call instead of dialing twice.",
  input: z.object({
    to: z.string().min(1).describe("Configured recipient alias OR raw E.164, e.g. +61400000000"),
    objective: ObjectiveSchema,
    context: z.string().optional().describe("Optional extra context from the initiating agent"),
    profile: z.string().optional().describe("Call profile name (default: 'default')"),
    record: z
      .boolean()
      .optional()
      .describe("Request recording on/off (subject to the recipient's recording policy)"),
    mode: CallModeInputSchema.optional(),
    dryRun: z
      .boolean()
      .optional()
      .describe("Preview the resolved plan; nothing is persisted or dialed"),
    idempotencyKey: z
      .string()
      .min(8)
      .max(64)
      .optional()
      .describe("Override the derived dedupe key so retries across host restarts stay safe"),
  }),
  // Single object shape: MCP outputSchema must be a top-level object, so the
  // dryRun/dialed variants share one schema with optional halves.
  output: z.object({
    dryRun: z.boolean(),
    plan: CallPlanSchema.optional(),
    call: CallRecordSchema.optional(),
    deduped: z.boolean().optional(),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
} satisfies CommandSpec;

export const endCall = {
  name: "end_call",
  description: "Hang up a live call immediately.",
  input: z.object({ callId: CallIdSchema, reason: EndReasonSchema.optional() }),
  output: z.object({ ok: z.literal(true) }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
} satisfies CommandSpec;

export const playDisclosure = {
  name: "play_disclosure",
  description:
    "Speak the configured recording-disclosure line into the live call. NEVER invoked automatically — this is the manual step before enabling recording for a 'manual'-policy recipient.",
  input: z.object({ callId: CallIdSchema }),
  output: z.object({ ok: z.literal(true) }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
} satisfies CommandSpec;

export const sayOnCall = {
  name: "say_on_call",
  description:
    "Speak the given text verbatim (TTS) into the live call. This is the reply path for 'direct'-mode calls: wait for the callee's next utterance (get_call_events with waitMs), read it, then answer with this tool. Keep replies short and conversational — they are spoken aloud on a real phone line. Refused when the call has no live session (not answered yet, or ended).",
  input: z.object({ callId: CallIdSchema, text: SayTextSchema }),
  output: z.object({ ok: z.literal(true), spokenChars: z.number().int() }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
} satisfies CommandSpec;

export const setRecording = {
  name: "set_recording",
  description:
    "Enable or disable recording on a live call. Enabling is refused for 'never'-policy recipients; for 'manual' recipients, play the disclosure first (play_disclosure) — this tool does not do it for you.",
  input: z.object({ callId: CallIdSchema, enabled: z.boolean() }),
  output: z.object({ ok: z.literal(true), enabled: z.boolean() }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
} satisfies CommandSpec;

export const listCalls = {
  name: "list_calls",
  description: "List calls, newest first. Paginate with beforeMs (createdAtMs of the last row).",
  input: z.object({ limit: LimitSchema.optional(), beforeMs: BeforeMsSchema.optional() }),
  output: z.object({ calls: z.array(CallRecordSchema) }),
  annotations: READ_ONLY,
} satisfies CommandSpec;

export const getCall = {
  name: "get_call",
  description: "Fetch a call record (status, recording state, timings included).",
  input: z.object({ callId: CallIdSchema }),
  output: z.object({
    call: CallRecordSchema,
    timings: z.array(TurnTimingSchema),
    recordings: z.array(RecordingMetaSchema),
  }),
  annotations: READ_ONLY,
} satisfies CommandSpec;

export const getCallEvents = {
  name: "get_call_events",
  description:
    "Cursor-paginated per-call event feed (afterSeq → next page). With waitMs, long-polls: if no events exist past afterSeq yet, waits up to waitMs for the next one — use ~25000 in direct-mode conversations to wait for the callee's next utterance (turn.user) without busy-polling.",
  input: z.object({
    callId: CallIdSchema,
    afterSeq: AfterSeqSchema.optional(),
    limit: EventLimitSchema.optional(),
    waitMs: WaitMsSchema.optional(),
  }),
  output: z.object({ events: z.array(CallEventSchema), nextCursor: z.number() }),
  annotations: READ_ONLY,
  timeoutMs: 60_000,
} satisfies CommandSpec;

export const getTranscript = {
  name: "get_transcript",
  description: "Finalized utterances for a call, in order, with interruption flags.",
  input: z.object({ callId: CallIdSchema }),
  output: z.object({ transcript: z.array(UtteranceSchema) }),
  annotations: READ_ONLY,
} satisfies CommandSpec;

export const searchCalls = {
  name: "search_calls",
  description: "Full-text search over transcripts and call metadata (FTS5 syntax supported).",
  input: z.object({ query: SearchQuerySchema, limit: LimitSchema.optional() }),
  output: z.object({
    calls: z.array(CallRecordSchema),
    utterances: z.array(UtteranceSchema),
  }),
  annotations: READ_ONLY,
} satisfies CommandSpec;

export const getLatencyReport = {
  name: "get_latency_report",
  description:
    "Per-leg latency percentiles (p50/p90/p99) over the most recent calls, split by mode: direct.pickup/think/egress/turn and byo-model.firstToken[ToTwilio]. Phase F sizes its masking bed and Phase R its response_timeout_secs from this. Optionally scope to one callId.",
  input: z.object({
    lastCalls: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe("How many recent calls (default 50)"),
    callId: CallIdSchema.optional().describe("Scope to one call"),
  }),
  output: z.object({
    calls: z.number().int(),
    turns: z.number().int(),
    legs: z.record(
      z.object({
        n: z.number().int(),
        p50: z.number(),
        p90: z.number(),
        p99: z.number(),
        maxMs: z.number(),
      }),
    ),
  }),
  annotations: READ_ONLY,
} satisfies CommandSpec;

export const getRecordingMetadata = {
  name: "get_recording_metadata",
  description:
    "Recording metadata for a call (ids, duration, size, deletion state). Audio bytes are NEVER returned over MCP — use the tel CLI to play or export locally.",
  input: z.object({ callId: CallIdSchema }),
  output: z.object({ recordings: z.array(RecordingMetaSchema) }),
  annotations: READ_ONLY,
} satisfies CommandSpec;

export const deleteRecording = {
  name: "delete_recording",
  description:
    "Delete a recording locally, at the provider, or both. Requires an explicit scope and confirm: true. Provider deletion is irreversible.",
  input: z.object({
    recordingSid: RecordingSidSchema,
    scope: RecordingScopeSchema.describe("Where to delete"),
    confirm: ConfirmSchema,
  }),
  output: z.object({ deletedLocal: z.boolean(), deletedProvider: z.boolean() }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
} satisfies CommandSpec;

/** Every command, in listing order. The golden pin test asserts these names. */
export const ALL_COMMANDS = [
  placeCall,
  endCall,
  playDisclosure,
  sayOnCall,
  setRecording,
  listCalls,
  getCall,
  getCallEvents,
  getTranscript,
  searchCalls,
  getLatencyReport,
  getRecordingMetadata,
  deleteRecording,
] as const;

export const COMMAND_NAMES = ALL_COMMANDS.map((c) => c.name);
