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
  AgentPlatformPort,
  SecretProvider,
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

const OutboundCallResponse = z.object({
  success: z.boolean(),
  message: z.string(),
  conversation_id: z.string().min(1).nullish(),
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
 * The agent body for create AND update (PATCH takes the same partial shape).
 * Every recording-relevant field is sent explicitly, never left to EL's
 * default: `record_voice` false is what keeps an unrecorded call unrecorded.
 */
export function agentRequestBody(brief: AgentBrief): Record<string, unknown> {
  const tts: Record<string, unknown> = { voice_id: brief.voice.voiceId, speed: brief.voice.speed };
  if (brief.voice.stability !== null) tts.stability = brief.voice.stability;
  if (brief.voice.similarityBoost !== null) tts.similarity_boost = brief.voice.similarityBoost;
  return {
    name: brief.name,
    conversation_config: {
      agent: {
        // Empty = the agent waits for the callee to speak first.
        first_message: brief.firstMessage ?? "",
        language: brief.language,
        prompt: {
          prompt: brief.prompt,
          // The agent's only way to hang up; we have no endpoint to do it for it.
          built_in_tools: {
            end_call: {
              type: "system",
              name: "end_call",
              params: { system_tool_type: "end_call" },
            },
          },
        },
      },
      tts,
      conversation: { max_duration_seconds: brief.maxDurationSec },
    },
    platform_settings: { privacy: { record_voice: brief.recordVoice } },
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

  async placeOutboundCall(req: AgentOutboundCallRequest): Promise<{ conversationId: string }> {
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
    return { conversationId: parsed.conversation_id };
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
