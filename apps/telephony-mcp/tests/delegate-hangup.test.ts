/**
 * O-30 through the real gateway wiring: `agentPlatform.twilioHangup` in config
 * → startGateway builds the Twilio hang-up → end_call over MCP posts to the
 * SUBACCOUNT with the subaccount key. The platform is the fake and `fetch` is
 * a recording fake that only this adapter reaches (INV-14: no network).
 * Every SID and secret here is fake.
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
  FakeAgentPlatform,
  FakeSecrets,
  FakeTelephony,
  fakeCallSid,
  fakeSecretValues,
  MemoryRecordingStore,
  ScriptedLlm,
  TEST_PHONE_NUMBER_ID,
  tempStateDir,
  testConfig,
} from "./helpers.js";

const PUBLIC_PORT = 19190;
const ADMIN_PORT = 19191;
const SUBACCOUNT = `AC${"1".repeat(32)}`;
const KEY_SID = `SK${"2".repeat(32)}`;
const SECRET = "fake-subaccount-secret-for-gateway-test";

let gateway: Gateway;
let client: Client;
let stateDir: string;
const seen: Array<{ url: string; body: string; auth: string }> = [];

function toolText(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content;
  return content.map((c) => c.text ?? "").join("");
}

beforeAll(async () => {
  stateDir = tempStateDir();
  const cfg: Config = testConfig({
    server: {
      publicBaseUrl: "https://gw.test.invalid",
      publicPort: PUBLIC_PORT,
      adminPort: ADMIN_PORT,
    },
    agentPlatform: {
      type: "elevenlabs-managed",
      phoneNumberId: TEST_PHONE_NUMBER_ID,
      pollIntervalMs: 60_000,
      twilioHangup: { accountSid: SUBACCOUNT, apiKeySid: KEY_SID },
    },
  });
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({
      url: String(url),
      body: String(init?.body ?? ""),
      auth: String(((init?.headers ?? {}) as Record<string, string>).Authorization),
    });
    return new Response(JSON.stringify({ status: "completed" }), { status: 200 });
  }) as typeof fetch;
  gateway = await startGateway(cfg, {
    secrets: new FakeSecrets({
      ...fakeSecretValues(),
      TWILIO_API_KEY_ELEVENLABS_SUBACCOUNT_CALLS_RW: SECRET,
    }),
    telephony: new FakeTelephony(),
    llm: new ScriptedLlm([]),
    recordings: new MemoryRecordingStore(),
    agentPlatform: new FakeAgentPlatform(),
    fetchImpl,
  });
  const admin = new AdminClient(ADMIN_PORT);
  const server = buildMcpServer({
    cfg,
    admin,
    openReadStore: () =>
      new SqliteStore(join(stateDir, "telephony-mcp.sqlite3"), { readonly: true }),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "delegate-hangup-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterAll(async () => {
  await client.close();
  await gateway.close();
  rmSync(stateDir, { recursive: true, force: true });
});

describe("end_call on a delegate call, configured (O-30)", () => {
  it("hangs up at the subaccount over MCP, and the feed says so without closing the call", async () => {
    const placed = await client.callTool({
      name: "place_call",
      arguments: { to: "george", objective: "book Thursday", mode: "delegate" },
    });
    expect(placed.isError).toBeFalsy();
    const callId = (JSON.parse(toolText(placed)) as { call: { id: string } }).call.id;
    expect(seen).toHaveLength(0); // dialing never touches Twilio directly

    const ended = await client.callTool({ name: "end_call", arguments: { callId } });
    expect(ended.isError).toBeFalsy();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(
      `https://api.twilio.com/2010-04-01/Accounts/${SUBACCOUNT}/Calls/${fakeCallSid(2)}.json`,
    );
    expect(seen[0]?.body).toBe("Status=completed");
    expect(seen[0]?.auth).toBe(`Basic ${Buffer.from(`${KEY_SID}:${SECRET}`).toString("base64")}`);

    const types = gateway.service.store.getEvents(callId).map((e) => e.type);
    expect(types).toContain("call.hangup_requested");
    expect(types).not.toContain("call.ended"); // the poller writes it from the platform
    expect(toolText(ended)).not.toContain(SECRET);
  });
});
