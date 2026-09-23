/**
 * ElevenLabs voice-preview client — the same plain-fetch + Zod client as the
 * delegate adapter (D-78: no SDK), reusing its request/redaction path. Wire
 * field names from SDK v2.68.0 serialization types (`SupportedVoice`,
 * `ClientToolConfigInput`, `ConversationHistoryTranscriptToolCallCommonModel
 * Output`, `AgentCallLimits`), and every one of them exercised against the
 * live API on 2026-09-23 before this file was written.
 *
 * The talking half is NOT ours: George talks to the agent on ElevenLabs'
 * hosted talk-to page (`elevenlabs.io/app/talk-to?agent_id=…`) — mic,
 * speaker and live transcript with no code here. `GET agents/{id}/link`
 * returns `token: null` for an agent without auth, and the page then needs
 * only the agent id, so the URL is built rather than fetched.
 */
import { z } from "zod";
import type { AgentConversationStatus, VoicePreviewPort } from "../../domain/ports.js";
import { AGENT_CONVERSATION_STATUSES } from "../../domain/ports.js";
import {
  ADJUST_TOOL,
  type PreviewAgentSpec,
  type PreviewToolCall,
  type PreviewVoiceState,
  SAVE_TOOL,
  SPEED_RANGE,
} from "../../domain/voice-preview.js";
import { ElevenLabsAgentPlatform, parseOrThrow } from "./elevenlabs.js";

export const TALK_TO_BASE = "https://elevenlabs.io/app/talk-to";

/**
 * A public agent costs credits to anyone who has its id, so it is capped:
 * two live sessions at once (a reconnect can overlap the previous session's
 * wind-down) and 40 sessions a day.
 */
export const PREVIEW_CALL_LIMITS = { agent_concurrency_limit: 2, daily_limit: 40 } as const;

const AgentList = z.object({
  agents: z.array(
    z.object({
      agent_id: z.string().min(1),
      name: z.string(),
      created_at_unix_secs: z.number().nullish(),
    }),
  ),
});

const SupportedVoiceWire = z.object({
  label: z.string().min(1),
  voice_id: z.string().min(1),
  speed: z.number().nullish(),
  stability: z.number().nullish(),
  similarity_boost: z.number().nullish(),
});

const AgentDetail = z.object({
  agent_id: z.string().min(1),
  conversation_config: z.object({
    tts: z.object({ supported_voices: z.array(SupportedVoiceWire).nullish() }).nullish(),
  }),
});

const CreateResponse = z.object({ agent_id: z.string().min(1) });

const ConversationList = z.object({
  conversations: z.array(
    z.object({
      conversation_id: z.string().min(1),
      status: z.enum(AGENT_CONVERSATION_STATUSES),
      start_time_unix_secs: z.number(),
    }),
  ),
});

const ConversationToolCalls = z.object({
  conversation_id: z.string().min(1),
  status: z.enum(AGENT_CONVERSATION_STATUSES),
  transcript: z.array(
    z.object({
      tool_calls: z
        .array(z.object({ tool_name: z.string(), params_as_json: z.string() }))
        .nullish(),
    }),
  ),
});

function labelParam(labels: string[]) {
  return { type: "string", description: "The candidate's tag, exactly as listed", enum: labels };
}

/** The agent body for create AND update (PATCH takes the same partial shape). */
export function previewAgentRequestBody(spec: PreviewAgentSpec): Record<string, unknown> {
  const labels = spec.voices.map((v) => v.label);
  const supported_voices = spec.voices.map((v) => {
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
  return {
    name: spec.name,
    conversation_config: {
      agent: {
        first_message: spec.firstMessage,
        language: spec.language,
        prompt: {
          prompt: spec.prompt,
          tools: [
            // The agent's own hang-up (off by default on API-created agents — D-79).
            {
              type: "system",
              name: "end_call",
              description: "",
              params: { system_tool_type: "end_call" },
            },
            {
              type: "client",
              name: ADJUST_TOOL,
              description:
                "Record a change George asked for to one candidate voice. Values are the NEW absolute settings. Heard after he reconnects.",
              // EL acknowledges the call itself; nothing on the page has to answer it.
              expects_response: false,
              parameters: {
                type: "object",
                required: ["label"],
                properties: {
                  label: labelParam(labels),
                  speed: {
                    type: "number",
                    description: `New speed, ${SPEED_RANGE.min} to ${SPEED_RANGE.max}; lower is slower`,
                  },
                  stability: {
                    type: "number",
                    description: "New stability 0 to 1; lower is more expressive, higher steadier",
                  },
                  similarity: {
                    type: "number",
                    description:
                      "New similarity 0 to 1; how closely it sticks to the original voice",
                  },
                  note: { type: "string", description: "What George asked for, in his words" },
                },
              },
            },
            {
              type: "client",
              name: SAVE_TOOL,
              description:
                "Record that George chose a candidate and the name to save it under as one of his call profiles.",
              expects_response: false,
              parameters: {
                type: "object",
                required: ["label", "name"],
                properties: {
                  label: labelParam(labels),
                  name: { type: "string", description: "The name George gave it, as he said it" },
                },
              },
            },
          ],
        },
      },
      tts: { voice_id: spec.hostVoiceId, speed: 1, supported_voices },
      conversation: { max_duration_seconds: spec.maxDurationSec },
    },
    platform_settings: {
      // Nothing George says in an audition is kept as audio.
      privacy: { record_voice: false },
      // Explicit: the hosted page needs a public agent (see the file header).
      auth: { enable_auth: false },
      call_limits: PREVIEW_CALL_LIMITS,
    },
  };
}

export class ElevenLabsVoicePreview extends ElevenLabsAgentPlatform implements VoicePreviewPort {
  async findPreviewAgent(
    name: string,
  ): Promise<{ agentId: string; voices: PreviewVoiceState[] } | null> {
    const list = parseOrThrow(
      AgentList,
      await this.request(
        "GET",
        `/v1/convai/agents?search=${encodeURIComponent(name)}&page_size=30`,
        "/v1/convai/agents",
      ),
      "list agents",
    );
    const match = list.agents
      .filter((a) => a.name === name)
      .sort((a, b) => (b.created_at_unix_secs ?? 0) - (a.created_at_unix_secs ?? 0))[0];
    if (!match) return null;
    const detail = parseOrThrow(
      AgentDetail,
      await this.request(
        "GET",
        `/v1/convai/agents/${encodeURIComponent(match.agent_id)}`,
        "/v1/convai/agents/{agent_id}",
      ),
      "get agent",
    );
    return {
      agentId: detail.agent_id,
      voices: (detail.conversation_config.tts?.supported_voices ?? []).map((v) => ({
        label: v.label,
        voiceId: v.voice_id,
        speed: v.speed ?? null,
        stability: v.stability ?? null,
        similarityBoost: v.similarity_boost ?? null,
      })),
    };
  }

  async createPreviewAgent(spec: PreviewAgentSpec): Promise<{ agentId: string }> {
    const json = await this.request(
      "POST",
      "/v1/convai/agents/create",
      "/v1/convai/agents/create",
      previewAgentRequestBody(spec),
    );
    return { agentId: parseOrThrow(CreateResponse, json, "create agent").agent_id };
  }

  async updatePreviewAgent(agentId: string, spec: PreviewAgentSpec): Promise<void> {
    const json = await this.request(
      "PATCH",
      `/v1/convai/agents/${encodeURIComponent(agentId)}`,
      "/v1/convai/agents/{agent_id}",
      previewAgentRequestBody(spec),
    );
    parseOrThrow(CreateResponse, json, "update agent");
  }

  talkUrl(agentId: string): string {
    return `${TALK_TO_BASE}?agent_id=${encodeURIComponent(agentId)}`;
  }

  async listPreviewConversations(
    agentId: string,
    limit: number,
  ): Promise<
    Array<{ conversationId: string; status: AgentConversationStatus; startedAtSecs: number }>
  > {
    const json = await this.request(
      "GET",
      `/v1/convai/conversations?agent_id=${encodeURIComponent(agentId)}&page_size=${limit}`,
      "/v1/convai/conversations",
    );
    return parseOrThrow(ConversationList, json, "list conversations")
      .conversations.map((c) => ({
        conversationId: c.conversation_id,
        status: c.status,
        startedAtSecs: c.start_time_unix_secs,
      }))
      .sort((a, b) => b.startedAtSecs - a.startedAtSecs);
  }

  async getPreviewConversation(conversationId: string): Promise<{
    conversationId: string;
    status: AgentConversationStatus;
    toolCalls: PreviewToolCall[];
  }> {
    const json = await this.request(
      "GET",
      `/v1/convai/conversations/${encodeURIComponent(conversationId)}`,
      "/v1/convai/conversations/{conversation_id}",
    );
    // STRIP mode: George's words (transcript messages) are not carried out of here.
    const c = parseOrThrow(ConversationToolCalls, json, "get conversation");
    return {
      conversationId: c.conversation_id,
      status: c.status,
      toolCalls: c.transcript.flatMap((t) =>
        (t.tool_calls ?? []).map((tc) => ({ name: tc.tool_name, paramsJson: tc.params_as_json })),
      ),
    };
  }
}
