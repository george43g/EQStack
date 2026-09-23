/**
 * Phase Q end to end through the real surfaces: a real gateway (fake
 * telephony, FAKE agent platform — INV-14) and the MCP adapter over the SDK's
 * in-memory transport. Proves the Scope §1/§3 claims: delegate is a MODE on
 * the existing place_call, not a tool (the golden count stays 13); the host's
 * loop is unchanged (place_call → get_call_events → get_transcript); and the
 * refusals arrive as tool errors / HTTP 409 naming the mode.
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminApiError, AdminClient } from "../src/client/admin-client.js";
import { COMMAND_NAMES } from "../src/commands/specs.js";
import type { Config } from "../src/config/schema.js";
import { type Gateway, startGateway } from "../src/gateway/gateway.js";
import { buildMcpServer } from "../src/mcp/server.js";
import { SqliteStore } from "../src/stores/sqlite-store.js";
import {
  delegateConfig,
  FakeAgentPlatform,
  FakeSecrets,
  FakeTelephony,
  fakeSecretValues,
  MemoryRecordingStore,
  ScriptedLlm,
  said,
  tempStateDir,
} from "./helpers.js";

const PUBLIC_PORT = 19090;
const ADMIN_PORT = 19091;

let cfg: Config;
let gateway: Gateway;
let telephony: FakeTelephony;
let platform: FakeAgentPlatform;
let admin: AdminClient;
let client: Client;
let stateDir: string;

function toolText(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content;
  return content.map((c) => c.text ?? "").join("");
}

function toolJson<T>(result: unknown): T {
  return JSON.parse(toolText(result)) as T;
}

beforeAll(async () => {
  stateDir = tempStateDir();
  cfg = delegateConfig({
    server: {
      publicBaseUrl: "https://gw.test.invalid",
      publicPort: PUBLIC_PORT,
      adminPort: ADMIN_PORT,
    },
  });
  telephony = new FakeTelephony();
  platform = new FakeAgentPlatform();
  gateway = await startGateway(cfg, {
    secrets: new FakeSecrets(fakeSecretValues()),
    telephony,
    llm: new ScriptedLlm([]),
    recordings: new MemoryRecordingStore(),
    agentPlatform: platform,
  });
  admin = new AdminClient(ADMIN_PORT);
  const server = buildMcpServer({
    cfg,
    admin,
    openReadStore: () =>
      new SqliteStore(join(stateDir, "telephony-mcp.sqlite3"), { readonly: true }),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "delegate-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterAll(async () => {
  await client.close();
  await gateway.close();
  rmSync(stateDir, { recursive: true, force: true });
});

describe("delegate is a mode, not a tool (Scope §1, INV-1/INV-5)", () => {
  it("delegate added no tool (the count moved 13 → 16 only for the voice-preview trio, then 17 for consult's answer_consult, then 18 for start_meeting — a meeting is a consult variant, not a mode, D-104)", async () => {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(18);
    expect(tools.map((t) => t.name)).not.toContain("delegate_call");
    expect(tools.map((t) => t.name).sort()).toEqual([...COMMAND_NAMES].sort());
    const place = tools.find((t) => t.name === "place_call");
    if (!place) throw new Error("place_call missing");
    const props = (place.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props)).toContain("acknowledgeThirdPartyRecording");
  });
});

describe("the host's loop, unchanged", () => {
  let callId: string;
  let conversationId: string;

  it("place_call dryRun over MCP shows the agent + brief and creates nothing at the platform", async () => {
    platform.forbidMutations = true;
    const result = await client.callTool({
      name: "place_call",
      arguments: { to: "george", objective: "book Thursday", mode: "delegate", dryRun: true },
    });
    platform.forbidMutations = false;
    expect(result.isError).toBeFalsy();
    const out = toolJson<{
      plan: { mode: string; recordingEnabled: boolean; notices: string[] };
      agent: { action: string; brief: { prompt: string } };
    }>(result);
    expect(out.plan.mode).toBe("delegate");
    expect(out.agent.action).toBe("create");
    expect(out.agent.brief.prompt).toContain("do NOT guess");
    // preconsented default does not stretch to ElevenLabs without an acknowledgement
    expect(out.plan.recordingEnabled).toBe(false);
    expect(out.plan.notices[0]).toMatch(/ElevenLabs, a third party/);
    expect(platform.log.created).toHaveLength(0);
    expect(toolText(result)).not.toContain("+61400111222");
  });

  it("place_call dials through the platform; the result discloses a third-party recording", async () => {
    const result = await client.callTool({
      name: "place_call",
      arguments: {
        to: "george",
        objective: "book Thursday",
        mode: "delegate",
        record: true,
        acknowledgeThirdPartyRecording: true,
      },
    });
    expect(result.isError).toBeFalsy();
    const out = toolJson<{
      call: { id: string; providerCallId: string; recordingEnabled: boolean };
      agent: { name: string };
      notices: string[];
    }>(result);
    callId = out.call.id;
    conversationId = out.call.providerCallId;
    expect(out.call.recordingEnabled).toBe(true);
    expect(out.agent.name).toBe("eqstack-default-recorded");
    expect(out.notices[0]).toMatch(/recorded by ElevenLabs, a third party/);
    expect(telephony.log.calls).toHaveLength(0);
    expect(toolText(result)).not.toContain("+61400111222");
  });

  it("say_on_call is a tool error naming the mode; REST says 409", async () => {
    const result = await client.callTool({
      name: "say_on_call",
      arguments: { callId, text: "hello?" },
    });
    expect(result.isError).toBe(true);
    expect(toolText(result)).toMatch(/say_on_call is refused on a 'delegate' call/);
    const err: unknown = await admin.say(callId, "hi").then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AdminApiError);
    expect((err as AdminApiError).status).toBe(409);
  });

  it("get_call_events long-poll wakes on a polled turn; get_transcript reads the words", async () => {
    platform.script(conversationId, {
      status: "in-progress",
      transcript: [said("agent", "Hi, it's George's assistant."), said("user", "Oh, hello.")],
    });
    const waiting = client.callTool({
      name: "get_call_events",
      arguments: { callId, afterSeq: 1, waitMs: 5_000 },
    });
    setTimeout(() => void gateway.service.delegatePoller(callId)?.pollOnce(), 50);
    const events = toolJson<{ events: Array<{ type: string }> }>(await waiting).events;
    expect(events.map((e) => e.type)).toContain("call.answered");

    platform.script(conversationId, {
      status: "done",
      transcript: [said("agent", "Hi, it's George's assistant."), said("user", "Oh, hello.")],
      terminationReason: "remote party hung up",
      hasAudio: true,
    });
    await gateway.service.delegatePoller(callId)?.pollOnce();
    const all = toolJson<{ events: Array<{ type: string; data: Record<string, unknown> }> }>(
      await client.callTool({ name: "get_call_events", arguments: { callId } }),
    ).events;
    const ended = all.find((e) => e.type === "call.ended");
    expect(ended?.data).toMatchObject({ reason: "remote party hung up", platformHasAudio: true });

    const transcript = toolJson<{ transcript: Array<{ role: string; text: string }> }>(
      await client.callTool({ name: "get_transcript", arguments: { callId } }),
    ).transcript;
    expect(transcript).toHaveLength(2);
    expect(transcript[0]?.text).toBe("Hi, it's George's assistant.");
    // Callee speech exits marked untrusted, exactly as in the other modes.
    expect(transcript[1]?.text).toContain("Oh, hello.");
    expect(transcript[1]?.text).not.toBe("Oh, hello.");
  });

  it("the concurrency slot is free again once the platform reports done", async () => {
    const health = await admin.health();
    expect(health.activeCalls).toBe(0);
  });
});
