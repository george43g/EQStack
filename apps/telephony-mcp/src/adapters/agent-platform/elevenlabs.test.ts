/**
 * ElevenLabs adapter wire contract, against a recording fake `fetch` — no
 * network (INV-14). Pins the four endpoints, the xi-api-key header, the
 * request bodies (field names from the official SDK's serialization types),
 * Zod parsing of every response (INV-6), stripping of number-bearing fields
 * (INV-11), redaction of echoed error bodies, and key resolution by name
 * (INV-12).
 */
import { describe, expect, it } from "vitest";
import { FakeSecrets, testConfig } from "../../../tests/helpers.js";
import { buildBrief } from "../../domain/agent-brief.js";
import { agentRequestBody, ElevenLabsAgentPlatform, ElevenLabsApiError } from "./elevenlabs.js";

const KEY = "test-el-key-not-a-real-secret";
const CALLEE = "+61400999888";
/** Obviously fake: the shape of a Twilio call SID, all zeros. */
const FAKE_CALL_SID = `CA${"0".repeat(32)}`;

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(responses: Array<{ status?: number; json?: unknown; text?: string }>) {
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
    const text = r.text ?? JSON.stringify(r.json ?? {});
    return new Response(text, { status: r.status ?? 200 });
  }) as typeof fetch;
  return { impl, seen };
}

function adapter(fetchImpl: typeof fetch, secrets = new FakeSecrets({ ELEVENLABS_API_KEY: KEY })) {
  return new ElevenLabsAgentPlatform({ apiKeyRef: "ELEVENLABS_API_KEY", secrets, fetchImpl });
}

const brief = buildBrief(testConfig(), "default", false);

/** The error a promise rejects with; fails the test if it resolves. */
async function rejection(p: Promise<unknown>): Promise<ElevenLabsApiError> {
  try {
    await p;
  } catch (e) {
    return e as ElevenLabsApiError;
  }
  throw new Error("expected a rejection");
}

describe("request shapes", () => {
  it("createAgent: POST /v1/convai/agents/create with the SDK field names and an explicit record_voice", async () => {
    const { impl, seen } = fakeFetch([{ json: { agent_id: "agent_123" } }]);
    await expect(adapter(impl).createAgent(brief)).resolves.toEqual({ agentId: "agent_123" });
    const req = seen[0] as Seen;
    expect(req.url).toBe("https://api.elevenlabs.io/v1/convai/agents/create");
    expect(req.method).toBe("POST");
    expect(req.headers["xi-api-key"]).toBe(KEY);
    expect(req.body).toEqual(agentRequestBody(brief));
    expect(req.body).toMatchObject({
      name: "eqstack-default",
      conversation_config: {
        agent: {
          first_message: "Hi, this is George's assistant.",
          language: "en",
          prompt: {
            prompt: brief.prompt,
            built_in_tools: {
              end_call: {
                type: "system",
                name: "end_call",
                params: { system_tool_type: "end_call" },
              },
            },
          },
        },
        tts: { voice_id: "voice123", speed: 1, stability: 0.7, similarity_boost: 0.8 },
        conversation: { max_duration_seconds: 900 },
      },
      // EL records by default; unrecorded must be said out loud (D-76).
      platform_settings: { privacy: { record_voice: false } },
    });
  });

  it("updateAgent: PATCH /v1/convai/agents/{id}, id path-encoded, same body", async () => {
    const { impl, seen } = fakeFetch([{ json: { agent_id: "agent/1", name: "x" } }]);
    await adapter(impl).updateAgent("agent/1", { ...brief, recordVoice: true });
    expect(seen[0]?.url).toBe("https://api.elevenlabs.io/v1/convai/agents/agent%2F1");
    expect(seen[0]?.method).toBe("PATCH");
    expect(seen[0]?.body).toMatchObject({ platform_settings: { privacy: { record_voice: true } } });
  });

  it("placeOutboundCall: POST /v1/convai/twilio/outbound-call with dynamic variables", async () => {
    const { impl, seen } = fakeFetch([
      { json: { success: true, message: "ok", conversation_id: "conv_1", callSid: FAKE_CALL_SID } },
    ]);
    const res = await adapter(impl).placeOutboundCall({
      agentId: "agent_1",
      phoneNumberId: "phnum_abc",
      to: CALLEE,
      dynamicVariables: { call_objective: "o", call_context: "c" },
    });
    expect(res).toEqual({ conversationId: "conv_1", phoneLegSid: FAKE_CALL_SID });
    expect(seen[0]?.url).toBe("https://api.elevenlabs.io/v1/convai/twilio/outbound-call");
    expect(seen[0]?.body).toEqual({
      agent_id: "agent_1",
      agent_phone_number_id: "phnum_abc",
      to_number: CALLEE,
      conversation_initiation_client_data: {
        dynamic_variables: { call_objective: "o", call_context: "c" },
      },
    });
  });

  it("placeOutboundCall: the phone-leg SID is read from callSid or call_sid, and dropped unless it is a CA… SID (O-30)", async () => {
    const req = {
      agentId: "agent_1",
      phoneNumberId: "phnum_abc",
      to: CALLEE,
      dynamicVariables: {},
    };
    const ok = { success: true, message: "ok", conversation_id: "conv_1" };
    const { impl } = fakeFetch([
      { json: { ...ok, call_sid: FAKE_CALL_SID } },
      { json: ok },
      { json: { ...ok, callSid: "CA1" } },
      { json: { ...ok, callSid: `${FAKE_CALL_SID}/../Recordings` } },
    ]);
    const a = adapter(impl);
    expect((await a.placeOutboundCall(req)).phoneLegSid).toBe(FAKE_CALL_SID);
    expect((await a.placeOutboundCall(req)).phoneLegSid).toBeNull();
    expect((await a.placeOutboundCall(req)).phoneLegSid).toBeNull();
    expect((await a.placeOutboundCall(req)).phoneLegSid).toBeNull();
  });

  it("getConversation: GET /v1/convai/conversations/{id}", async () => {
    const { impl, seen } = fakeFetch([
      {
        json: {
          conversation_id: "conv_1",
          agent_id: "agent_1",
          status: "in-progress",
          transcript: [],
          metadata: { start_time_unix_secs: 1, call_duration_secs: 3 },
          has_audio: false,
          has_user_audio: false,
          has_response_audio: false,
        },
      },
    ]);
    await adapter(impl).getConversation("conv_1");
    expect(seen[0]?.url).toBe("https://api.elevenlabs.io/v1/convai/conversations/conv_1");
    expect(seen[0]?.method).toBe("GET");
    expect(seen[0]?.body).toBeUndefined();
  });

  it("honours a configured baseUrl", async () => {
    const { impl, seen } = fakeFetch([{ json: { agent_id: "a" } }]);
    await new ElevenLabsAgentPlatform({
      apiKeyRef: "ELEVENLABS_API_KEY",
      secrets: new FakeSecrets({ ELEVENLABS_API_KEY: KEY }),
      fetchImpl: impl,
      baseUrl: "https://api.eu.residency.elevenlabs.io/",
    }).createAgent(brief);
    expect(seen[0]?.url).toBe("https://api.eu.residency.elevenlabs.io/v1/convai/agents/create");
  });
});

describe("response parsing (INV-6) and INV-11 stripping", () => {
  it("maps a conversation to the domain shape and drops every number-bearing field", async () => {
    const { impl } = fakeFetch([
      {
        json: {
          conversation_id: "conv_1",
          agent_id: "agent_1",
          status: "done",
          transcript: [
            { role: "agent", message: "Hello.", time_in_call_secs: 0 },
            { role: "user", message: "Hi.", time_in_call_secs: 2, interrupted: null },
            { role: "agent", message: null, time_in_call_secs: 3, tool_calls: [{}] },
            { role: "agent", message: "Bye!", time_in_call_secs: 5, interrupted: true },
          ],
          metadata: {
            start_time_unix_secs: 1,
            call_duration_secs: 6,
            termination_reason: "end_call tool was called.",
            phone_call: { external_number: CALLEE, agent_number: "+61347130000" },
          },
          conversation_initiation_client_data: {
            dynamic_variables: { system__called_number: CALLEE },
          },
          has_audio: true,
          has_user_audio: true,
          has_response_audio: true,
          some_future_field: { x: 1 },
        },
      },
    ]);
    const c = await adapter(impl).getConversation("conv_1");
    expect(c).toEqual({
      conversationId: "conv_1",
      status: "done",
      transcript: [
        { role: "agent", text: "Hello.", timeInCallSecs: 0, interrupted: false },
        { role: "user", text: "Hi.", timeInCallSecs: 2, interrupted: false },
        { role: "agent", text: null, timeInCallSecs: 3, interrupted: false },
        { role: "agent", text: "Bye!", timeInCallSecs: 5, interrupted: true },
      ],
      terminationReason: "end_call tool was called.",
      callDurationSecs: 6,
      hasAudio: true,
    });
    expect(JSON.stringify(c)).not.toContain(CALLEE.slice(1));
  });

  it("an unknown status is a loud parse error, not a guess", async () => {
    const { impl } = fakeFetch([
      {
        json: {
          conversation_id: "conv_1",
          status: "queued",
          transcript: [],
          metadata: { call_duration_secs: 0 },
          has_audio: false,
        },
      },
    ]);
    await expect(adapter(impl).getConversation("conv_1")).rejects.toThrow(
      /unexpected shape: status/,
    );
  });

  it("outbound success:false (or a null conversation_id) is an error, with the message redacted", async () => {
    const { impl } = fakeFetch([
      { json: { success: false, message: `could not reach ${CALLEE}`, conversation_id: null } },
      { json: { success: true, message: "ok", conversation_id: null } },
    ]);
    const a = adapter(impl);
    const req = { agentId: "a", phoneNumberId: "phnum_x", to: CALLEE, dynamicVariables: {} };
    const err = await rejection(a.placeOutboundCall(req));
    expect(err).toBeInstanceOf(ElevenLabsApiError);
    expect((err as Error).message).toMatch(/did not start the call/);
    expect((err as Error).message).not.toContain(CALLEE);
    await expect(a.placeOutboundCall(req)).rejects.toThrow(/did not start the call/);
  });
});

describe("errors and secrets", () => {
  it("an HTTP error carries its status (404 drives recreate) and an echoed number is redacted", async () => {
    const { impl } = fakeFetch([
      { status: 422, text: JSON.stringify({ detail: [{ msg: "bad", input: CALLEE }] }) },
      { status: 404, text: '{"detail":"agent not found"}' },
    ]);
    const a = adapter(impl);
    const e422 = await rejection(
      a.placeOutboundCall({
        agentId: "a",
        phoneNumberId: "phnum_x",
        to: CALLEE,
        dynamicVariables: {},
      }),
    );
    expect(e422.status).toBe(422);
    expect(e422.message).toMatch(/→ 422/);
    expect(e422.message).not.toContain(CALLEE);
    const e404 = await rejection(a.updateAgent("agent_gone", brief));
    expect(e404.status).toBe(404);
    expect(e404.message).toContain("/v1/convai/agents/{agent_id}");
  });

  it("a missing key fails naming the variable — and no request is made (INV-12)", async () => {
    const { impl, seen } = fakeFetch([]);
    const err = await rejection(adapter(impl, new FakeSecrets({})).createAgent(brief));
    expect(err.status).toBe(0);
    expect(err.message).toBe(
      "missing ElevenLabs API key: ELEVENLABS_API_KEY (env or opkeep keychain cache)",
    );
    expect(seen).toHaveLength(0);
  });

  it("the key never appears in an error message", async () => {
    const { impl } = fakeFetch([{ status: 401, text: `{"detail":"invalid key ${KEY}"}` }]);
    const err = await rejection(adapter(impl).createAgent(brief));
    // EL echoing the key back is hypothetical; if it ever does, the message is scrubbed.
    expect((err as Error).message).toMatch(/→ 401/);
    expect((err as Error).message).not.toContain(KEY);
    expect((err as Error).message).toContain("[redacted]");
  });
});
