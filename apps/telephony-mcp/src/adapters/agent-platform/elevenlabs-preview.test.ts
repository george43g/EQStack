/**
 * Voice-preview wire contract against a recording fake `fetch` — no network
 * (INV-14). Field names are the ones exercised live on 2026-09-23.
 */
import { describe, expect, it } from "vitest";
import { FakeSecrets } from "../../../tests/helpers.js";
import { buildPreviewSpec, selectCandidates } from "../../domain/voice-preview.js";
import { ElevenLabsApiError } from "./elevenlabs.js";
import {
  ElevenLabsVoicePreview,
  PREVIEW_CALL_LIMITS,
  previewAgentRequestBody,
  TALK_TO_BASE,
} from "./elevenlabs-preview.js";

const KEY = "test-el-key-not-a-real-secret";

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(responses: Array<{ status?: number; json?: unknown }>) {
  const seen: Seen[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const r = responses.shift();
    if (!r) throw new Error("unexpected extra request");
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200 });
  }) as typeof fetch;
  return { impl, seen };
}

function client(fetchImpl: typeof fetch) {
  return new ElevenLabsVoicePreview({
    apiKeyRef: "ELEVENLABS_API_KEY",
    secrets: new FakeSecrets({ ELEVENLABS_API_KEY: KEY }),
    fetchImpl,
  });
}

const spec = buildPreviewSpec(selectCandidates(3));

describe("previewAgentRequestBody", () => {
  const body = previewAgentRequestBody(spec) as {
    name: string;
    conversation_config: {
      agent: {
        first_message: string;
        prompt: { prompt: string; tools: Array<Record<string, unknown>> };
      };
      tts: { voice_id: string; supported_voices: Array<Record<string, unknown>> };
      conversation: { max_duration_seconds: number };
    };
    platform_settings: Record<string, unknown>;
  };

  it("carries every candidate as a labelled supported voice with its own settings", () => {
    expect(body.name).toBe("eqstack-preview-voices");
    expect(body.conversation_config.tts.voice_id).toBe(spec.hostVoiceId);
    expect(body.conversation_config.tts.supported_voices).toEqual(
      spec.voices.map((v) => ({
        label: v.label,
        voice_id: v.voiceId,
        description: v.description,
        speed: v.speed,
        stability: v.stability,
        similarity_boost: v.similarityBoost,
      })),
    );
  });

  it("declares both client tools as fire-and-forget, with the labels as an enum, plus end_call", () => {
    const tools = body.conversation_config.agent.prompt.tools;
    expect(tools.map((t) => t.name)).toEqual(["end_call", "adjust_voice", "save_profile"]);
    for (const t of tools.slice(1)) {
      expect(t.type).toBe("client");
      expect(t.expects_response).toBe(false);
      const params = t.parameters as { properties: { label: { enum: string[] } } };
      expect(params.properties.label.enum).toEqual(["Hannah", "Ollie", "David"]);
    }
  });

  it("is unrecorded, public (for the hosted page), and capped", () => {
    expect(body.platform_settings).toEqual({
      privacy: { record_voice: false },
      auth: { enable_auth: false },
      call_limits: PREVIEW_CALL_LIMITS,
    });
  });
});

describe("ElevenLabsVoicePreview", () => {
  it("findPreviewAgent: exact name match, newest wins, then reads its supported voices", async () => {
    const { impl, seen } = fakeFetch([
      {
        json: {
          agents: [
            { agent_id: "a_old", name: "eqstack-preview-voices", created_at_unix_secs: 1 },
            { agent_id: "a_other", name: "eqstack-preview-voices-2", created_at_unix_secs: 9 },
            { agent_id: "a_new", name: "eqstack-preview-voices", created_at_unix_secs: 5 },
          ],
        },
      },
      {
        json: {
          agent_id: "a_new",
          conversation_config: {
            tts: {
              supported_voices: [
                {
                  label: "Roger",
                  voice_id: "v1",
                  speed: 0.8,
                  stability: null,
                  similarity_boost: 0.7,
                },
              ],
            },
          },
        },
      },
    ]);
    const found = await client(impl).findPreviewAgent("eqstack-preview-voices");
    expect(found).toEqual({
      agentId: "a_new",
      voices: [
        { label: "Roger", voiceId: "v1", speed: 0.8, stability: null, similarityBoost: 0.7 },
      ],
    });
    expect(seen[0]?.url).toBe(
      "https://api.elevenlabs.io/v1/convai/agents?search=eqstack-preview-voices&page_size=30",
    );
    expect(seen[0]?.headers["xi-api-key"]).toBe(KEY);
    expect(seen[1]?.url).toBe("https://api.elevenlabs.io/v1/convai/agents/a_new");
  });

  it("findPreviewAgent: null when no name matches exactly (one request only)", async () => {
    const { impl, seen } = fakeFetch([
      { json: { agents: [{ agent_id: "x", name: "eqstack-preview-voices-old" }] } },
    ]);
    expect(await client(impl).findPreviewAgent("eqstack-preview-voices")).toBeNull();
    expect(seen).toHaveLength(1);
  });

  it("create POSTs and update PATCHes the same body", async () => {
    const { impl, seen } = fakeFetch([{ json: { agent_id: "a1" } }, { json: { agent_id: "a1" } }]);
    const c = client(impl);
    expect(await c.createPreviewAgent(spec)).toEqual({ agentId: "a1" });
    await c.updatePreviewAgent("a1", spec);
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      "POST https://api.elevenlabs.io/v1/convai/agents/create",
      "PATCH https://api.elevenlabs.io/v1/convai/agents/a1",
    ]);
    expect(seen[0]?.body).toEqual(seen[1]?.body);
  });

  it("talkUrl is the hosted talk-to page for the agent", () => {
    expect(client(fakeFetch([]).impl).talkUrl("agent_1")).toBe(`${TALK_TO_BASE}?agent_id=agent_1`);
  });

  it("lists sessions newest first", async () => {
    const { impl, seen } = fakeFetch([
      {
        json: {
          conversations: [
            { conversation_id: "c1", status: "done", start_time_unix_secs: 10 },
            { conversation_id: "c2", status: "in-progress", start_time_unix_secs: 20 },
          ],
          has_more: false,
        },
      },
    ]);
    const list = await client(impl).listPreviewConversations("a1", 5);
    expect(list.map((c) => c.conversationId)).toEqual(["c2", "c1"]);
    expect(seen[0]?.url).toBe(
      "https://api.elevenlabs.io/v1/convai/conversations?agent_id=a1&page_size=5",
    );
  });

  it("getPreviewConversation keeps tool calls in order and carries none of George's words", async () => {
    const { impl } = fakeFetch([
      {
        json: {
          conversation_id: "c1",
          status: "done",
          transcript: [
            { role: "user", message: "make Roger slower", time_in_call_secs: 1 },
            {
              role: "agent",
              message: null,
              time_in_call_secs: 2,
              tool_calls: [
                { tool_name: "adjust_voice", params_as_json: '{"label": "Roger", "speed": 0.8}' },
              ],
            },
            {
              role: "agent",
              time_in_call_secs: 3,
              tool_calls: [
                { tool_name: "save_profile", params_as_json: '{"label":"Roger","name":"Harbour"}' },
              ],
            },
          ],
        },
      },
    ]);
    const conv = await client(impl).getPreviewConversation("c1");
    expect(conv).toEqual({
      conversationId: "c1",
      status: "done",
      toolCalls: [
        { name: "adjust_voice", paramsJson: '{"label": "Roger", "speed": 0.8}' },
        { name: "save_profile", paramsJson: '{"label":"Roger","name":"Harbour"}' },
      ],
    });
    expect(JSON.stringify(conv)).not.toContain("make Roger slower");
  });

  it("an HTTP error names the route and never the key", async () => {
    const { impl } = fakeFetch([{ status: 422, json: { detail: `bad ${KEY}` } }]);
    const err = await client(impl)
      .updatePreviewAgent("a1", spec)
      .then(() => null)
      .catch((e: unknown) => e as ElevenLabsApiError);
    expect(err).toBeInstanceOf(ElevenLabsApiError);
    expect(err?.message).toContain("PATCH /v1/convai/agents/{agent_id} → 422");
    expect(err?.message).not.toContain(KEY);
  });
});
