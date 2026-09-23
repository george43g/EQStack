/**
 * ElevenLabs agent platform (Phase Q, D-75) over plain fetch — the same
 * shape as the Twilio adapter. `@elevenlabs/elevenlabs-js` was considered and
 * rejected: 25 MB / 22k files to reach four endpoints, and INV-6 needs our
 * own Zod parse on every response regardless.
 *
 * Wire field names were taken from the official SDK's serialization types
 * (v2.68.0, `serialization/types/*` + `serialization/resources/
 * conversationalAi/…`), not guessed. Response schemas are Zod's default
 * STRIP mode: unknown fields are accepted (EL adds fields freely) but never
 * carried into our domain objects. That matters beyond tidiness — EL echoes
 * `conversation_initiation_client_data` and `metadata.phone_call`, which carry
 * the callee's full number; `.passthrough()` would smuggle it past INV-11.
 *
 * INV-11: the full E.164 appears only in the outbound-call request body.
 * Error text from EL is redacted before it becomes an Error message, because
 * a validation error can echo the request back.
 * INV-12: the API key resolves by NAME on each request, through the
 * SecretProvider (its own cache applies); a missing key is an error that
 * names the variable, never a value.
 */
import { redactValue } from "@george43g/robustness";
import { z } from "zod";
import type {
  AgentBrief,
  AgentConversation,
  AgentOutboundCallRequest,
  AgentOutboundCallResult,
  AgentPlatformPort,
  ConsultToolSpec,
  SecretProvider,
  SupportedVoiceSpec,
} from "../../domain/ports.js";
import { AGENT_CONVERSATION_STATUSES } from "../../domain/ports.js";

export class ElevenLabsApiError extends Error {
  constructor(
    /** HTTP status; 0 when the request never reached EL (e.g. missing key). */
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface ElevenLabsOptions {
  apiKeyRef: string;
  secrets: SecretProvider;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

// ── Response contracts (INV-6) — strict on what we read, strip the rest ─────

const CreateAgentResponse = z.object({ agent_id: z.string().min(1) });

const UpdateAgentResponse = z.object({ agent_id: z.string().min(1) });

/** A Twilio call SID. Anything else is dropped, never persisted or put in a URL. */
export const TWILIO_CALL_SID = /^CA[0-9a-fA-F]{32}$/;

/**
 * The call SID's wire name is `callSid` — camelCase, unlike every other field
 * here: the SDK's serializer (v2.59.0 and v2.68.0,
 * `serialization/types/TwilioOutboundCallResponse`) renames `conversation_id`
 * but not `callSid`. `call_sid` (the conversation-history spelling) is
 * accepted too, in case EL normalises it.
 */
const OutboundCallResponse = z.object({
  success: z.boolean(),
  message: z.string(),
  conversation_id: z.string().min(1).nullish(),
  callSid: z.string().nullish(),
  call_sid: z.string().nullish(),
});

const TranscriptItem = z.object({
  role: z.enum(["user", "agent"]),
  message: z.string().nullish(),
  time_in_call_secs: z.number(),
  interrupted: z.boolean().nullish(),
});

const ConversationResponse = z.object({
  conversation_id: z.string().min(1),
  status: z.enum(AGENT_CONVERSATION_STATUSES),
  transcript: z.array(TranscriptItem),
  metadata: z.object({
    termination_reason: z.string().nullish(),
    call_duration_secs: z.number(),
  }),
  has_audio: z.boolean(),
});

/**
 * The consult tool (Phase R, D-90) as an inline EL webhook tool. Every field
 * name and enum value is from SDK v2.68.0's serializers, byte-checked from the
 * published tarball: `serialization/types/WebhookToolConfigInput.js`
 * (response_timeout_secs 5–300, pre_tool_speech, tool_call_sound[_behavior],
 * execution_mode, interruption_mode, tool_error_handling_mode, api_schema),
 * `WebhookToolApiSchemaConfigInput.js` (url, method, request_headers,
 * request_body_schema), `ConvAiDynamicVariable.js` (a header value
 * `{ variable_name }`), and `LiteralJsonSchemaProperty.js`, whose value
 * sources are mutually exclusive — `description` (the LLM writes it) OR
 * `dynamic_variable` (EL fills it) — which is why the two id properties carry
 * no description: the LLM never writes the conversation id or call SID.
 *
 * The bearer never appears here: the header names the `secret__` variable and
 * EL substitutes the per-call value, keeping it from the LLM.
 */
export function consultToolBody(spec: ConsultToolSpec): Record<string, unknown> {
  // Meeting (PHASE-GC § 3): the same webhook, addressed. `enum` on a literal
  // property is in SDK v2.68.0 `LiteralJsonSchemaProperty` (enum: string[]),
  // alongside `description` — the LLM writes it, so it needs both.
  const addressed = spec.addressees !== undefined;
  return {
    type: "webhook",
    name: spec.name,
    description: spec.description,
    response_timeout_secs: spec.responseTimeoutSecs,
    pre_tool_speech: spec.preToolSpeech,
    tool_call_sound: spec.toolCallSound,
    tool_call_sound_behavior: spec.toolCallSoundBehavior,
    execution_mode: spec.executionMode,
    interruption_mode: spec.interruptionMode,
    tool_error_handling_mode: spec.toolErrorHandlingMode,
    api_schema: {
      url: spec.url,
      method: "POST",
      content_type: "application/json",
      request_headers: { Authorization: { variable_name: spec.bearerVariable } },
      request_body_schema: {
        type: "object",
        required: addressed
          ? ["agent", "question", "conversation_id"]
          : ["question", "conversation_id"],
        properties: {
          ...(addressed
            ? {
                agent: {
                  type: "string",
                  description:
                    'The agent to ask: its ask_agent name exactly as the roster gives it (e.g. "executive").',
                  enum: spec.addressees,
                },
              }
            : {}),
          question: {
            type: "string",
            description: addressed
              ? "One self-contained question for that agent's real counterpart, with everything they need to answer (they cannot hear the call)."
              : "One self-contained question for the originator, with everything they need to decide (they cannot hear the call).",
          },
          collect_question_id: {
            type: "string",
            description:
              "Only to collect an answer that came back 'pending' earlier: the question_id you were given. Leave empty when asking a new question.",
          },
          conversation_id: { type: "string", dynamic_variable: "system__conversation_id" },
          call_sid: { type: "string", dynamic_variable: "system__call_sid" },
        },
      },
    },
  };
}

/**
 * The agent body for create AND update (PATCH takes the same partial shape).
 * Every recording-relevant field is sent explicitly, never left to EL's
 * default: `record_voice` false is what keeps an unrecorded call unrecorded.
 */
/** EL's built-in hang-up, as a system tool. The agent's only way to end a call itself. */
export const END_CALL_TOOL = {
  type: "system",
  name: "end_call",
  params: { system_tool_type: "end_call" },
} as const;

/**
 * Extra system tools (meeting briefs). Wire shape from SDK v2.68.0:
 * `SystemToolConfigInput` {type: "system", name, params} and
 * `SystemToolConfigInputParams`, a union discriminated on
 * `system_tool_type` whose `skip_turn` member is `SkipTurnToolConfig` — an
 * empty object. So the whole params body is the discriminant, exactly as
 * END_CALL_TOOL's is (`EndCallToolConfig` is empty too).
 */
export const SYSTEM_TOOLS = {
  skip_turn: { type: "system", name: "skip_turn", params: { system_tool_type: "skip_turn" } },
} as const;

/** EL multi-voice entries (SDK v2.68.0 `SupportedVoice`; same mapping as the preview agent). */
export function supportedVoicesBody(voices: SupportedVoiceSpec[]): Record<string, unknown>[] {
  return voices.map((v) => {
    const out: Record<string, unknown> = {
      label: v.label,
      voice_id: v.voiceId,
      description: v.description,
      speed: v.speed,
    };
    if (v.stability !== null) out.stability = v.stability;
    if (v.similarityBoost !== null) out.similarity_boost = v.similarityBoost;
    return out;
  });
}

export function agentRequestBody(brief: AgentBrief): Record<string, unknown> {
  const tts: Record<string, unknown> = { voice_id: brief.voice.voiceId, speed: brief.voice.speed };
  if (brief.voice.stability !== null) tts.stability = brief.voice.stability;
  if (brief.voice.similarityBoost !== null) tts.similarity_boost = brief.voice.similarityBoost;
  // Meeting-only fields (PHASE-GC Step 4). Each is absent from every other
  // brief, so delegate and consult bodies stay byte-identical (pinned).
  if (brief.supportedVoices) tts.supported_voices = supportedVoicesBody(brief.supportedVoices);
  const extraTools = (brief.extraSystemTools ?? []).map((name) => SYSTEM_TOOLS[name]);
  const platformSettings: Record<string, unknown> = {
    privacy: { record_voice: brief.recordVoice },
  };
  // AuthSettings.enable_auth (SDK v2.68.0 AgentPlatformSettingsRequestModel.auth).
  if (brief.enableAuth !== undefined) platformSettings.auth = { enable_auth: brief.enableAuth };
  return {
    name: brief.name,
    conversation_config: {
      agent: {
        // Empty = the agent waits for the callee to speak first.
        first_message: brief.firstMessage ?? "",
        language: brief.language,
        prompt: {
          prompt: brief.prompt,
          // EL has no endpoint that hangs up for it; without the optional
          // Twilio hang-up (O-30) this tool is the only way the call ends early.
          built_in_tools: { end_call: END_CALL_TOOL },
          // Consult agents only (D-92): a delegate body stays byte-identical.
          // end_call rides in `tools` too: when a body carries a `tools` list,
          // EL keeps only that list and drops `built_in_tools` — measured
          // 2026-09-23, the first consult agent could not hang up.
          // A meeting's skip_turn rides in `tools` for the same reason.
          ...(brief.consultTool || extraTools.length > 0
            ? {
                tools: [
                  ...(brief.consultTool ? [consultToolBody(brief.consultTool)] : []),
                  END_CALL_TOOL,
                  ...extraTools,
                ],
              }
            : {}),
        },
      },
      tts,
      // TurnConfig.turn_eagerness (SDK v2.68.0 ConversationalConfig.turn).
      ...(brief.turnEagerness ? { turn: { turn_eagerness: brief.turnEagerness } } : {}),
      conversation: { max_duration_seconds: brief.maxDurationSec },
    },
    platform_settings: platformSettings,
  };
}

export function parseOrThrow<T extends z.ZodTypeAny>(
  schema: T,
  json: unknown,
  what: string,
): z.infer<T> {
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.join(".") || "(root)";
    throw new ElevenLabsApiError(
      200,
      `ElevenLabs ${what} returned an unexpected shape: ${where}: ${issue?.message ?? "invalid"}`,
    );
  }
  return parsed.data;
}

export class ElevenLabsAgentPlatform implements AgentPlatformPort {
  readonly id = "elevenlabs-managed";
  private base: string;
  private fetchImpl: typeof fetch;

  constructor(private opts: ElevenLabsOptions) {
    this.base = (opts.baseUrl ?? "https://api.elevenlabs.io").replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Shared with the voice-preview client (elevenlabs-preview.ts): one key path, one redaction path. */
  protected async request(
    method: "GET" | "POST" | "PATCH",
    path: string,
    /** Path without ids, for error messages. */
    label: string,
    body?: unknown,
  ): Promise<unknown> {
    const apiKey = await this.opts.secrets.get(this.opts.apiKeyRef);
    if (!apiKey) {
      throw new ElevenLabsApiError(
        0,
        `missing ElevenLabs API key: ${this.opts.apiKeyRef} (env or opkeep keychain cache)`,
      );
    }
    const headers: Record<string, string> = { "xi-api-key": apiKey, Accept: "application/json" };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const res = await this.fetchImpl(`${this.base}${path}`, init);
    if (!res.ok) {
      // Scrub the key before truncating (an echo must not survive a cut), then
      // redact numbers: a validation error can echo the request back.
      const text = (await res.text().catch(() => "")).split(apiKey).join("[redacted]");
      throw new ElevenLabsApiError(
        res.status,
        `ElevenLabs ${method} ${label} → ${res.status}: ${String(redactValue(text.slice(0, 300)))}`,
      );
    }
    const text = await res.text();
    if (!text) return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ElevenLabsApiError(res.status, `ElevenLabs ${method} ${label} returned non-JSON`);
    }
  }

  async createAgent(brief: AgentBrief): Promise<{ agentId: string }> {
    const json = await this.request(
      "POST",
      "/v1/convai/agents/create",
      "/v1/convai/agents/create",
      agentRequestBody(brief),
    );
    return { agentId: parseOrThrow(CreateAgentResponse, json, "create agent").agent_id };
  }

  async updateAgent(agentId: string, brief: AgentBrief): Promise<void> {
    const json = await this.request(
      "PATCH",
      `/v1/convai/agents/${encodeURIComponent(agentId)}`,
      "/v1/convai/agents/{agent_id}",
      agentRequestBody(brief),
    );
    parseOrThrow(UpdateAgentResponse, json, "update agent");
  }

  async placeOutboundCall(req: AgentOutboundCallRequest): Promise<AgentOutboundCallResult> {
    const json = await this.request(
      "POST",
      "/v1/convai/twilio/outbound-call",
      "/v1/convai/twilio/outbound-call",
      {
        agent_id: req.agentId,
        agent_phone_number_id: req.phoneNumberId,
        to_number: req.to,
        conversation_initiation_client_data: { dynamic_variables: req.dynamicVariables },
      },
    );
    const parsed = parseOrThrow(OutboundCallResponse, json, "outbound call");
    if (!parsed.success || !parsed.conversation_id) {
      throw new ElevenLabsApiError(
        200,
        `ElevenLabs did not start the call: ${String(redactValue(parsed.message.slice(0, 300)))}`,
      );
    }
    const sid = parsed.callSid ?? parsed.call_sid ?? null;
    return {
      conversationId: parsed.conversation_id,
      phoneLegSid: sid !== null && TWILIO_CALL_SID.test(sid) ? sid : null,
    };
  }

  async getConversation(conversationId: string): Promise<AgentConversation> {
    const json = await this.request(
      "GET",
      `/v1/convai/conversations/${encodeURIComponent(conversationId)}`,
      "/v1/convai/conversations/{conversation_id}",
    );
    const c = parseOrThrow(ConversationResponse, json, "get conversation");
    return {
      conversationId: c.conversation_id,
      status: c.status,
      transcript: c.transcript.map((t) => ({
        role: t.role,
        text: t.message ?? null,
        timeInCallSecs: t.time_in_call_secs,
        interrupted: t.interrupted ?? false,
      })),
      terminationReason: c.metadata.termination_reason ?? null,
      callDurationSecs: c.metadata.call_duration_secs,
      hasAudio: c.has_audio,
    };
  }
}
