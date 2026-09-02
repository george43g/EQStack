/**
 * Shared Zod contracts — the single home for every schema that was previously
 * duplicated across the MCP tool definitions, the admin route bodies, and the
 * CLI's hand-validation (INV-5/INV-6; Phase B step 2).
 *
 * Domain mirrors are pinned to the domain interfaces with `z.ZodType<T>` so a
 * drift between the interface and its schema is a compile error, not a runtime
 * surprise (INV-8).
 */
import { z } from "zod";
import { RecordingPolicySchema } from "../config/schema.js";
import type { CallPlan } from "../domain/call-requests.js";
import type {
  CallEvent,
  CallRecord,
  CallRequest,
  RecordingMeta,
  TurnTiming,
  Utterance,
} from "../domain/types.js";
import { CALL_MODES, LEGACY_MODE_ALIASES, normalizeCallMode } from "../domain/types.js";

// ── Input primitives ───────────────────────────────────────────────────────

export const CallIdSchema = z.string().min(1).describe("Call id");
export const RequestIdSchema = z.string().min(1).describe("Call request id");
export const RecordingSidSchema = z
  .string()
  .regex(/^[A-Za-z0-9]+$/, "provider recording id (alphanumeric)");
export const RecordingScopeSchema = z.enum(["local", "provider", "both"]);
export const SayTextSchema = z.string().min(1).max(2000).describe("Text to speak, verbatim");
export const ObjectiveSchema = z
  .string()
  .min(1)
  .describe("What the call should achieve — becomes the model's objective");
export const ConfirmSchema = z
  .literal(true)
  .describe("Must be exactly true — explicit confirmation");
export const LimitSchema = z.number().int().min(1).max(100);
export const EventLimitSchema = z.number().int().min(1).max(500);
export const BeforeMsSchema = z.number().int().positive();
export const AfterSeqSchema = z.number().int().min(0);
export const WaitMsSchema = z
  .number()
  .int()
  .min(0)
  .max(55_000)
  .describe("Long-poll timeout in ms (requires the gateway to be running)");
export const EndReasonSchema = z.string().min(1).max(500);
export const SearchQuerySchema = z.string().min(1);

/**
 * Mode input: the D-34 taxonomy plus the legacy "llm" alias for one
 * deprecation window; always normalized to a canonical member on parse.
 */
export const CallModeInputSchema = z
  .enum([...CALL_MODES, ...(Object.keys(LEGACY_MODE_ALIASES) as ["llm"])])
  .transform((m) => normalizeCallMode(m))
  .describe(
    "Conversation driver. 'byo-model' (default; legacy alias 'llm'): the configured LLM conducts the call from the objective. 'direct': YOU (the MCP host) are the conversational brain — loop get_call_events { waitMs } for turn.user, then reply with say_on_call. 'delegate'/'consult' are reserved for the ElevenLabs modes and refuse until implemented.",
  );

export const CallModeSchema = z.enum(CALL_MODES);

// ── Domain mirrors (compile-pinned to the interfaces) ──────────────────────

export const CallStatusSchema = z.enum([
  "created",
  "initiated",
  "ringing",
  "answered",
  "completed",
  "failed",
]);

export const CallRecordSchema: z.ZodType<CallRecord> = z.object({
  id: z.string(),
  providerCallId: z.string().nullable(),
  requestId: z.string(),
  recipientAlias: z.string(),
  numberSuffix: z.string(),
  profile: z.string(),
  objective: z.string(),
  status: CallStatusSchema,
  recordingEnabled: z.boolean(),
  recordingPolicy: RecordingPolicySchema,
  maxDurationSec: z.number(),
  createdAtMs: z.number(),
  updatedAtMs: z.number(),
  endedAtMs: z.number().nullable(),
  endReason: z.string().nullable(),
});

export const CallRequestSchema: z.ZodType<CallRequest> = z.object({
  id: z.string(),
  recipientAlias: z.string(),
  numberSuffix: z.string(),
  objective: z.string(),
  context: z.string().nullable(),
  profile: z.string(),
  mode: CallModeSchema,
  recordingEnabled: z.boolean(),
  maxDurationSec: z.number(),
  createdAtMs: z.number(),
  startedCallId: z.string().nullable(),
});

export const UtteranceSchema: z.ZodType<Utterance> = z.object({
  id: z.number(),
  callId: z.string(),
  turn: z.number(),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  tsMs: z.number(),
  interrupted: z.boolean(),
});

export const CallEventSchema: z.ZodType<CallEvent> = z.object({
  id: z.number(),
  callId: z.string(),
  seq: z.number(),
  tsMs: z.number(),
  type: z.string(),
  data: z.record(z.unknown()),
});

export const TurnTimingSchema: z.ZodType<TurnTiming> = z.object({
  callId: z.string(),
  turn: z.number(),
  endOfTurnMs: z.number().nullable(),
  firstModelTokenMs: z.number().nullable(),
  firstTokenToTwilioMs: z.number().nullable(),
  interruptedAtMs: z.number().nullable(),
});

export const RecordingMetaSchema: z.ZodType<RecordingMeta> = z.object({
  providerRecordingId: z.string(),
  callId: z.string(),
  durationSec: z.number().nullable(),
  channels: z.number(),
  encryptedPath: z.string().nullable(),
  sizeBytes: z.number().nullable(),
  deletedLocal: z.boolean(),
  deletedProvider: z.boolean(),
  createdAtMs: z.number(),
});

export const CallPlanSchema: z.ZodType<CallPlan> = z.object({
  recipientAlias: z.string(),
  numberSuffix: z.string(),
  displayName: z.string().nullable(),
  source: z.enum(["config", "adhoc"]),
  objective: z.string(),
  context: z.string().nullable(),
  profile: z.string(),
  mode: CallModeSchema,
  recordingEnabled: z.boolean(),
  recordingPolicy: RecordingPolicySchema,
  maxDurationSec: z.number(),
});
