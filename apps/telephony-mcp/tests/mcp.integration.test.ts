/**
 * MCP integration — the current registerTool surface end-to-end over the
 * SDK's in-memory transport, backed by a REAL gateway (fake telephony +
 * scripted LLM). Validates schemas, annotations, the two-stage approval
 * gate, idempotent retry, pagination, and concurrent history reads while a
 * call is live.
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminClient } from "../src/client/admin-client.js";
import type { Config } from "../src/config/schema.js";
import { type Gateway, startGateway } from "../src/gateway/gateway.js";
import { buildMcpServer } from "../src/mcp/server.js";
import { SqliteStore } from "../src/stores/sqlite-store.js";
import {
  FakeSecrets,
  FakeTelephony,
  fakeSecretValues,
  MemoryRecordingStore,
  ScriptedLlm,
  tempStateDir,
  testConfig,
} from "./helpers.js";

const ADMIN_PORT = 18891;

let cfg: Config;
let gateway: Gateway;
let telephony: FakeTelephony;
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
  cfg = testConfig({
    server: { publicBaseUrl: "https://gw.test.invalid", publicPort: 18890, adminPort: ADMIN_PORT },
  });
  telephony = new FakeTelephony();
  gateway = await startGateway(cfg, {
    secrets: new FakeSecrets(fakeSecretValues()),
    telephony,
    llm: new ScriptedLlm([]),
    recordings: new MemoryRecordingStore(),
  });
  const server = buildMcpServer({
    cfg,
    admin: new AdminClient(ADMIN_PORT),
    openReadStore: () => new SqliteStore(join(stateDir, "voice-mcp.sqlite3"), { readonly: true }),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterAll(async () => {
  await client.close();
  await gateway.close();
  rmSync(stateDir, { recursive: true, force: true });
});

describe("tool surface", () => {
  it("registers the full tool set with safety annotations", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "voice_prepare_call",
        "voice_start_call",
        "voice_end_call",
        "voice_play_disclosure",
        "voice_say",
        "voice_set_recording",
        "voice_list_calls",
        "voice_get_call",
        "voice_get_events",
        "voice_get_transcript",
        "voice_search_calls",
        "voice_get_recording_metadata",
        "voice_delete_recording",
      ].sort(),
    );
    const start = tools.find((t) => t.name === "voice_start_call");
    expect(start?.annotations?.destructiveHint).toBe(true);
    expect(start?.annotations?.openWorldHint).toBe(true);
    expect(start?.annotations?.idempotentHint).toBe(false);
    expect(start?.description).toMatch(/PAID/);
    const list = tools.find((t) => t.name === "voice_list_calls");
    expect(list?.annotations?.readOnlyHint).toBe(true);
    const del = tools.find((t) => t.name === "voice_delete_recording");
    expect(del?.annotations?.destructiveHint).toBe(true);
  });

  it("lists voice:// resources", async () => {
    const { resourceTemplates } = await client.listResourceTemplates();
    const uris = resourceTemplates.map((r) => r.uriTemplate);
    expect(uris).toContain("voice://calls/{callId}");
    expect(uris).toContain("voice://calls/{callId}/transcript");
    expect(uris).toContain("voice://calls/{callId}/events");
  });
});

describe("direct mode over MCP", () => {
  it("prepare accepts mode: direct and echoes it in the request", async () => {
    const result = await client.callTool({
      name: "voice_prepare_call",
      arguments: { recipient: "george", objective: "talk directly", mode: "direct" },
    });
    const { request } = toolJson<{ request: { mode: string } }>(result);
    expect(request.mode).toBe("direct");
  });

  it("voice_say without a live session is a tool error, not a crash", async () => {
    const result = await client.callTool({
      name: "voice_say",
      arguments: { callId: "no-such-call", text: "hello?" },
    });
    expect(result.isError).toBe(true);
  });
});

describe("two-stage approval gate", () => {
  let requestId: string;
  let callId: string;

  it("prepare returns an expiring request and dials nothing", async () => {
    const result = await client.callTool({
      name: "voice_prepare_call",
      arguments: { recipient: "george", objective: "confirm the plumber quote" },
    });
    const { request } = toolJson<{
      request: { id: string; numberSuffix: string; expiresAtMs: number };
    }>(result);
    requestId = request.id;
    expect(request.numberSuffix).toBe("1222");
    expect(telephony.log.calls).toHaveLength(0);
    expect(toolText(result)).not.toContain("+61400111222");
  });

  it("start_call rejects a missing/false confirm at the schema layer", async () => {
    const missing = await client.callTool({ name: "voice_start_call", arguments: { requestId } });
    expect((missing as { isError?: boolean }).isError).toBe(true);
    expect(toolText(missing)).toMatch(/validation|confirm/i);
    const explicit = await client.callTool({
      name: "voice_start_call",
      arguments: { requestId, confirm: false },
    });
    expect((explicit as { isError?: boolean }).isError).toBe(true);
    expect(toolText(explicit)).toMatch(/expected true/i);
    expect(telephony.log.calls).toHaveLength(0);
  });

  it("start_call dials once; retries return the same call", async () => {
    const first = await client.callTool({
      name: "voice_start_call",
      arguments: { requestId, confirm: true },
    });
    const { call } = toolJson<{ call: { id: string } }>(first);
    callId = call.id;
    expect(telephony.log.calls).toHaveLength(1);
    const retry = await client.callTool({
      name: "voice_start_call",
      arguments: { requestId, confirm: true },
    });
    expect(toolJson<{ call: { id: string } }>(retry).call.id).toBe(callId);
    expect(telephony.log.calls).toHaveLength(1);
  });

  it("unknown recipients come back as tool errors, not dials", async () => {
    const result = await client.callTool({
      name: "voice_prepare_call",
      arguments: { recipient: "stranger", objective: "x" },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(toolText(result)).toMatch(/allowlisted/);
  });

  it("history reads work while the call is live (concurrent reader)", async () => {
    const listResult = await client.callTool({ name: "voice_list_calls", arguments: {} });
    const { calls } = toolJson<{ calls: Array<{ id: string; status: string }> }>(listResult);
    expect(calls.some((c) => c.id === callId)).toBe(true);

    const getResult = await client.callTool({ name: "voice_get_call", arguments: { callId } });
    const got = toolJson<{ call: { id: string } }>(getResult);
    expect(got.call.id).toBe(callId);

    const events = await client.callTool({
      name: "voice_get_events",
      arguments: { callId, afterSeq: 0, limit: 1 },
    });
    const page = toolJson<{ events: Array<{ seq: number }>; nextCursor: number }>(events);
    expect(page.events).toHaveLength(1);
    expect(page.nextCursor).toBe(page.events[0]?.seq);
  });

  it("set_recording honors consent policy over MCP", async () => {
    // live call is for a preconsented recipient; toggling off then on is allowed
    const off = await client.callTool({
      name: "voice_set_recording",
      arguments: { callId, enabled: false },
    });
    expect((off as { isError?: boolean }).isError).not.toBe(true);
    expect(telephony.log.recordingStops).toHaveLength(1);
  });

  it("end_call hangs up", async () => {
    await client.callTool({ name: "voice_end_call", arguments: { callId, reason: "test over" } });
    const result = await client.callTool({ name: "voice_get_call", arguments: { callId } });
    expect(toolJson<{ call: { status: string } }>(result).call.status).toBe("completed");
  });

  it("delete_recording refuses without exact confirm literal", async () => {
    const refused = await client.callTool({
      name: "voice_delete_recording",
      arguments: { recordingSid: "REx", scope: "local", confirm: false },
    });
    expect((refused as { isError?: boolean }).isError).toBe(true);
    expect(toolText(refused)).toMatch(/expected true/i);
    const bad = await client.callTool({
      name: "voice_delete_recording",
      arguments: { recordingSid: "REmissing", scope: "local", confirm: true },
    });
    expect((bad as { isError?: boolean }).isError).toBe(true); // unknown recording
  });

  it("search + transcript tools respond over MCP", async () => {
    const search = await client.callTool({
      name: "voice_search_calls",
      arguments: { query: "plumber" },
    });
    const found = toolJson<{ calls: Array<{ id: string }> }>(search);
    expect(found.calls.some((c) => c.id === callId)).toBe(true);
    const transcript = await client.callTool({
      name: "voice_get_transcript",
      arguments: { callId },
    });
    expect(toolJson<{ transcript: unknown[] }>(transcript).transcript).toEqual([]);
  });

  it("reads a voice:// resource", async () => {
    const res = await client.readResource({ uri: `voice://calls/${callId}` });
    const text = (res.contents[0] as { text?: string }).text ?? "";
    expect(JSON.parse(text)).toMatchObject({ id: callId });
    expect(text).not.toContain("+61400111222");
  });
});
