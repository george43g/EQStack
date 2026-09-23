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
  AgentPreviewSchema,
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
    "Place a REAL, PAID phone call to a REAL person. `to` is a configured recipient alias OR any raw E.164 number (+<country><number>) — dialing is not gated (aliases are nicknames + defaults, never permissions). Ad-hoc numbers start unrecorded (recordingPolicy 'manual'). Use dryRun: true to preview the resolved plan without dialing (for mode 'delegate' it also shows the ElevenLabs agent and brief, and creates nothing there). Identical retries inside the dedupe window return the already-created call instead of dialing twice. In mode 'delegate' a recording would be made and held by ElevenLabs, a third party: record: true then also needs acknowledgeThirdPartyRecording: true, and the result's `notices` say where the recording lives.",
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
    acknowledgeThirdPartyRecording: z
      .boolean()
      .optional()
      .describe(
        "Set true to accept that this call's recording is made and held by a third party (mode 'delegate': ElevenLabs), not in telephony-mcp's encrypted local store. Required with record: true on such calls unless config consent.autoApproveThirdPartyDisclosures is set",
      ),
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
    /** Delegate calls: the platform agent that will hold (dryRun) or holds the call. */
    agent: AgentPreviewSchema.optional(),
    /** Consent surface for a dialed call (dryRun carries the same in plan.notices). */
    notices: z.array(z.string()).optional(),
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
  description:
    "Hang up a live call immediately. Refused on 'delegate' calls: ElevenLabs holds the line and exposes no API to hang up a live conversation — the agent ends the call itself (its end_call tool) or at the profile's max duration, and get_call_events then delivers call.ended.",
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
    "Speak the configured recording-disclosure line into the live call. NEVER invoked automatically — this is the manual step before enabling recording for a 'manual'-policy recipient. Refused on 'delegate' calls, where the ElevenLabs agent does all the speaking.",
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
    "Speak the given text verbatim (TTS) into the live call. This is the reply path for 'direct'-mode calls: wait for the callee's next utterance (get_call_events with waitMs), read it, then answer with this tool. Keep replies short and conversational — they are spoken aloud on a real phone line. Refused when the call has no live session (not answered yet, or ended), and on 'delegate' calls, where the ElevenLabs agent does the talking.",
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
    "Enable or disable recording on a live call. Enabling is refused for 'never'-policy recipients; for 'manual' recipients, play the disclosure first (play_disclosure) — this tool does not do it for you. Refused on 'delegate' calls: ElevenLabs fixes recording when the call starts (choose it with place_call's record).",
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

// ── Voice-profile preview (src/domain/voice-preview.ts) ───────────────────
//
// These run in the calling process, not through the admin API: they never
// touch the call DB (INV-9) or a phone line. See LOCAL_COMMANDS.

const ConversationRefSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, "an ElevenLabs conversation id (conv_…) or 'latest'")
  .describe("Preview session: an ElevenLabs conversation id (conv_…), or 'latest' (default)");

const PreviewVoiceOutSchema = z.object({
  label: z.string(),
  name: z.string(),
  voiceId: z.string(),
  accent: z.string(),
  gender: z.string(),
  speed: z.number(),
  stability: z.number().nullable(),
  similarityBoost: z.number().nullable(),
  why: z.string(),
});

const VoiceAdjustmentSchema = z.object({
  label: z.string(),
  speed: z.number().optional(),
  stability: z.number().optional(),
  similarityBoost: z.number().optional(),
  note: z.string().optional(),
});

const VoiceSettingsSchema = z.object({
  voiceId: z.string(),
  speed: z.number().nullable(),
  stability: z.number().nullable(),
  similarityBoost: z.number().nullable(),
});

export const previewVoices = {
  name: "preview_voices",
  description:
    "Set up (or refresh) the voice-audition agent and return the link George opens to talk to it — ElevenLabs' hosted talk-to page, on his laptop's mic and speakers, NOT a phone call and no Twilio charge. The agent plays up to 9 candidate voices (Australian, British, American; male and female; calmer to livelier), takes spoken requests like 'slower' or 'more relaxed', and records the voice he names. Idempotent: re-running keeps adjustments already applied unless reset. A session cannot change a voice while it runs (measured), so after a session that asked for changes, call again with applyFrom: 'latest' and have him reconnect to hear them. Costs ElevenLabs agent minutes while he talks.",
  input: z.object({
    candidates: z
      .number()
      .int()
      .min(1)
      .max(9)
      .optional()
      .describe("How many candidate voices to audition (default 9, the platform maximum)"),
    reset: z
      .boolean()
      .optional()
      .describe("Discard earlier adjustments and go back to the catalogue settings"),
    applyFrom: ConversationRefSchema.optional().describe(
      "Fold the changes requested in this finished session ('latest' or conv_…) into the voices",
    ),
  }),
  output: z.object({
    agentId: z.string(),
    agentName: z.string(),
    action: z.enum(["create", "update"]),
    talkUrl: z.string(),
    hostVoice: z.string(),
    voices: z.array(PreviewVoiceOutSchema),
    applied: z.array(VoiceAdjustmentSchema),
    appliedFrom: z.string().nullable(),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  timeoutMs: 60_000,
} satisfies CommandSpec;

export const reviewVoicePreview = {
  name: "review_voice_preview",
  description:
    "Read what George asked for in a finished voice-audition session: the adjustments (per candidate, new absolute settings plus his words) and the voices he named, with the profile name each becomes. ElevenLabs only releases a session's record once it is 'done' (a few seconds after he hangs up); before that `finished` is false and the lists are empty.",
  input: z.object({ conversation: ConversationRefSchema.optional() }),
  output: z.object({
    conversationId: z.string(),
    status: z.string(),
    finished: z.boolean(),
    adjustments: z.array(VoiceAdjustmentSchema),
    saves: z.array(
      z.object({
        label: z.string(),
        spokenName: z.string(),
        profileName: z.string(),
        voice: VoiceSettingsSchema.extend({ label: z.string() }),
        includesUnheardChange: z.boolean(),
      }),
    ),
    rejected: z.array(z.string()),
  }),
  annotations: { ...READ_ONLY, openWorldHint: true },
  timeoutMs: 30_000,
} satisfies CommandSpec;

export const saveVoiceProfile = {
  name: "save_voice_profile",
  description:
    "Write a voice George chose into config.json as a named call profile (a copy of the base profile — prompt, greeting, limits — with the chosen voice id, speed, stability and similarity). Either from a finished audition session's naming (default: the latest session), or explicitly with label + name. Refuses to replace an existing profile unless overwrite is true; validates the whole config first; writes atomically and leaves a timestamped backup. Use dryRun: true to see the profile without writing. A running `tel serve` needs a restart to see the new profile.",
  input: z.object({
    conversation: ConversationRefSchema.optional(),
    label: z
      .string()
      .min(1)
      .max(32)
      .optional()
      .describe("Save this candidate explicitly (e.g. 'Hannah') instead of reading a session"),
    name: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe(
        "Profile name (spoken form is fine: 'Harbour' → harbour). Required with label; overrides a session's name",
      ),
    base: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*$/)
      .optional()
      .describe("Profile to copy prompt/greeting/limits from (default 'default')"),
    overwrite: z.boolean().optional().describe("Replace a profile of the same name"),
    dryRun: z.boolean().optional().describe("Show what would be written; write nothing"),
  }),
  output: z.object({
    configPath: z.string(),
    dryRun: z.boolean(),
    saved: z.array(
      z.object({
        name: z.string(),
        label: z.string(),
        base: z.string(),
        voice: z.object({
          voiceId: z.string(),
          speed: z.number(),
          stability: z.number().nullable(),
          similarity: z.number().nullable(),
        }),
        replaced: z.boolean(),
        includesUnheardChange: z.boolean(),
        backupPath: z.string().nullable(),
      }),
    ),
    rejected: z.array(z.string()),
    notices: z.array(z.string()),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  timeoutMs: 30_000,
} satisfies CommandSpec;

/**
 * Mutating commands that run in the calling process instead of through the
 * admin API. The only admissible reason: the command never touches the call
 * DB (INV-9) — the parity test lets these, and only these, skip a REST row.
 */
export const LOCAL_COMMANDS: readonly string[] = [previewVoices.name, saveVoiceProfile.name];

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
  previewVoices,
  reviewVoicePreview,
  saveVoiceProfile,
] as const;

export const COMMAND_NAMES = ALL_COMMANDS.map((c) => c.name);
