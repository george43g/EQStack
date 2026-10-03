/**
 * D-120 — live meeting rehearsals. `start_meeting {rehearsal: true}` writes the
 * meeting (call row, roster, events) on the running gateway but dials nobody
 * and touches nothing at the agent platform; the convenor asks members with
 * `ask_member`; `end_call` closes it locally. Everything runs over loopback
 * against the fakes (INV-14): FakeTelephony and FakeAgentPlatform record
 * every call, so "no dial" is an exact-zero assertion.
 *
 * The member side runs through the real member MCP surface
 * (`buildMcpServer({surface: "member"})` → AdminClient → admin API), which is
 * the path a real session uses with `tel mcp --surface member`.
 */
import { rmSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AdminClient } from "../src/client/admin-client.js";
import type { Config } from "../src/config/schema.js";
import type { CallEvent } from "../src/domain/types.js";
import {
  ASK_MEMBER_REAL_CALL_REFUSAL,
  type CallService,
  type ConsultResult,
  MEETING_REHEARSAL_NOTICE,
} from "../src/gateway/call-service.js";
import { type Gateway, startGateway } from "../src/gateway/gateway.js";
import { buildMcpServer } from "../src/mcp/server.js";
import { dbPath } from "../src/paths.js";
import { SqliteStore } from "../src/stores/sqlite-store.js";
import {
  FakeAgentPlatform,
  FakePhoneLegHangup,
  FakeSecrets,
  FakeTelephony,
  FixedClock,
  fakeSecretValues,
  MemoryRecordingStore,
  meetingConfig,
  ScriptedLlm,
  tempStateDir,
  until,
} from "./helpers.js";

const PUBLIC_PORT = 19590;
const ADMIN_PORT = 19591;
const TOOLS_PORT = 19592;
const ADMIN = `http://127.0.0.1:${ADMIN_PORT}`;
const SERVER = {
  publicBaseUrl: "https://gw.test.invalid",
  publicPort: PUBLIC_PORT,
  adminPort: ADMIN_PORT,
  toolsPort: TOOLS_PORT,
};
/** testConfig's `george` number — must never appear in anything persisted (INV-11). */
const GEORGE_FULL_NUMBER = "+61400111222";

let dir: string;
let gateway: Gateway | null = null;
let platform: FakeAgentPlatform;
let telephony: FakeTelephony;
let hangup: FakePhoneLegHangup;
let clock: FixedClock;

/**
 * A FakePhoneLegHangup is wired in, so a real meeting's end_call WOULD reach
 * the carrier: the rehearsal's "no hang-up" assertion is not vacuous. Three
 * concurrent calls, so a rehearsal and a real meeting can coexist in a test.
 */
function cfg(): Config {
  return meetingConfig({}, { server: SERVER, limits: { maxConcurrentCalls: 3 } });
}

async function start(): Promise<Gateway> {
  gateway = await startGateway(cfg(), {
    secrets: new FakeSecrets(fakeSecretValues()),
    telephony,
    llm: new ScriptedLlm([]),
    recordings: new MemoryRecordingStore(),
    agentPlatform: platform,
    phoneLegHangup: hangup,
    clock,
  });
  return gateway;
}

async function stop(): Promise<void> {
  await gateway?.close();
  gateway = null;
}

function svc(): CallService {
  if (!gateway) throw new Error("gateway not started");
  return gateway.service;
}

async function rehearse(): Promise<string> {
  const result = await svc().startMeeting({
    to: "george",
    members: ["executive", "eqstack"],
    agenda: "rehearse the GC-1 rerun",
    rehearsal: true,
  });
  if (!result.callId) throw new Error("expected a call id");
  return result.callId;
}

function types(callId: string): string[] {
  return svc()
    .store.getEvents(callId, 0, 500)
    .map((e) => e.type);
}

/** Every platform/carrier side effect the fakes record, in one comparable object. */
function sideEffects() {
  return {
    dialled: telephony.log.calls.length,
    providerEnded: telephony.log.ended.length,
    agentsCreated: platform.log.created.length,
    agentsUpdated: platform.log.updated.length,
    platformCalls: platform.log.calls.length,
    platformPolls: platform.log.polls.length,
    hungUp: hangup.hungUp.length,
  };
}

const NONE = {
  dialled: 0,
  providerEnded: 0,
  agentsCreated: 0,
  agentsUpdated: 0,
  platformCalls: 0,
  platformPolls: 0,
  hungUp: 0,
};

async function askOverHttp(
  callId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: ConsultResult & { error?: string } }> {
  const res = await fetchRetrying(`${ADMIN}/calls/${callId}/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as ConsultResult & { error?: string } };
}

/**
 * One retry on a reset socket: every test restarts the gateway on the same
 * port, and fetch's keep-alive pool can hand the next request a socket the
 * previous gateway closed (the harness race meeting-mode.test.ts documents).
 */
async function fetchRetrying(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    return fetch(url, init);
  }
}

/** A member session on the real member MCP surface (what `tel mcp --surface member` serves). */
async function memberClient(): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = buildMcpServer({
    cfg: cfg(),
    admin: new AdminClient(ADMIN_PORT),
    openReadStore: () => new SqliteStore(dbPath(), { readonly: true }),
    surface: "member",
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "rehearsal-member", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: () => Promise.all([client.close(), server.close()]).then(() => {}) };
}

function structured<T>(result: unknown): T {
  return (result as { structuredContent: T }).structuredContent;
}

beforeEach(() => {
  dir = tempStateDir();
  platform = new FakeAgentPlatform();
  telephony = new FakeTelephony();
  hangup = new FakePhoneLegHangup();
  clock = new FixedClock();
});

afterEach(async () => {
  await stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("start_meeting {rehearsal: true} (D-120)", () => {
  it("writes the meeting and goes live with ZERO telephony or agent-platform calls", async () => {
    await start();
    const result = await svc().startMeeting({
      to: "george",
      members: ["executive", "eqstack"],
      agenda: "rehearse the GC-1 rerun",
      rehearsal: true,
    });
    const callId = result.callId as string;
    // The no-dial pin: nothing at the carrier, nothing at the platform.
    expect(sideEffects()).toEqual(NONE);
    expect(result).toMatchObject({ dryRun: false, deduped: false, rehearsal: true });
    expect(result.notices).toContain(MEETING_REHEARSAL_NOTICE);
    expect(result.joinInstructions.executive).toContain(`call ${callId}`);

    const call = svc().store.getCall(callId);
    expect(call).toMatchObject({ status: "answered", rehearsal: true, providerCallId: null });
    // No bearer: nothing can authenticate to the tool route for this call.
    expect(svc().store.hasConsultToken(callId)).toBe(false);
    expect(svc().store.getPhoneLegSid(callId)).toBeNull();
    expect(svc().delegatePoller(callId)).toBeNull();
    expect(
      svc()
        .store.listMeetingMembers(callId)
        .map((m) => m.member),
    ).toEqual(["executive", "eqstack"]);
    expect(types(callId)).toEqual([
      "call.created",
      "meeting.started",
      "meeting.rehearsal",
      "call.answered",
    ]);
    // INV-11: alias + last four only, never the full number.
    const persisted = JSON.stringify([call, svc().store.getEvents(callId, 0, 500)]);
    expect(persisted).not.toContain(GEORGE_FULL_NUMBER);
    expect(call?.numberSuffix).toBe("1222");
  });

  it("is never deduped and claims no idempotency key: a real start of the same meeting still dials", async () => {
    await start();
    const input = {
      to: "george",
      members: ["executive", "eqstack"],
      agenda: "rehearse the GC-1 rerun",
    };
    const first = await svc().startMeeting({ ...input, rehearsal: true });
    const second = await svc().startMeeting({ ...input, rehearsal: true });
    expect(second.callId).not.toBe(first.callId);
    await svc().endCall(first.callId as string, "done");
    await svc().endCall(second.callId as string, "done");
    expect(sideEffects()).toEqual(NONE);
    const real = await svc().startMeeting(input);
    expect(real.deduped).toBe(false);
    expect(real.rehearsal).toBeUndefined();
    expect(platform.log.calls).toHaveLength(1);
  });

  it("a member polling through the member MCP surface sees the ask_member question, and its answer is the ask result", async () => {
    await start();
    const callId = await rehearse();
    const exec = await memberClient();
    const other = await memberClient();
    try {
      // The member's loop: long-poll as executive from the cursor until asked.
      const memberLoop = (async () => {
        let afterSeq = 0;
        const seen: CallEvent[] = [];
        for (;;) {
          const page = structured<{ events: CallEvent[]; nextCursor: number }>(
            await exec.client.callTool({
              name: "get_call_events",
              arguments: { callId, as: "executive", afterSeq, waitMs: 5000 },
            }),
          );
          seen.push(...page.events);
          const asked = page.events.find((e) => e.type === "consult.asked");
          if (asked) {
            const answered = structured<{ delivered: boolean }>(
              await exec.client.callTool({
                name: "answer_consult",
                arguments: {
                  callId,
                  questionId: asked.data.questionId as string,
                  answer: "Yes, the rerun is ready.",
                },
              }),
            );
            return { seen, asked, answered };
          }
          afterSeq = page.nextCursor;
        }
      })();
      // eqstack is listening too, but must not see executive's question.
      const otherPoll = other.client.callTool({
        name: "get_call_events",
        arguments: { callId, as: "eqstack", afterSeq: 4, waitMs: 1500 },
      });
      await until(() => svc().isHostListening(callId, "executive"), "executive polling");

      const ask = await askOverHttp(callId, {
        agent: "executive",
        question: "Is the rerun ready?",
      });
      const member = await memberLoop;

      expect(ask.status).toBe(200);
      expect(ask.json).toMatchObject({
        status: "answered",
        answer: "Yes, the rerun is ready.",
        agent: "executive",
      });
      expect(member.asked.data).toMatchObject({ addressee: "executive" });
      expect(String(member.asked.data.question)).toContain("Is the rerun ready?");
      expect(member.answered.delivered).toBe(true);
      const otherPage = structured<{ events: CallEvent[] }>(await otherPoll);
      expect(otherPage.events.some((e) => e.type === "consult.asked")).toBe(false);
      expect(svc().store.listConsultQuestions(callId)[0]).toMatchObject({
        status: "delivered",
        deliveredVia: "held",
        addressee: "executive",
      });
      expect(sideEffects()).toEqual(NONE);
    } finally {
      await exec.close();
      await other.close();
    }
  });

  it("ask_member answers unavailable when the member is not polling, and not_on_call off the roster", async () => {
    await start();
    const callId = await rehearse();
    const absent = await askOverHttp(callId, { agent: "eqstack", question: "Anyone there?" });
    expect(absent.json.status).toBe("unavailable");
    const svcCall = await svc().askMember(callId, { agent: "nobody", question: "Hello?" });
    expect(svcCall.status).toBe("not_on_call");
  });

  it("ask_member REFUSES a real (dialled) meeting: the chair asks there", async () => {
    await start();
    const real = await svc().startMeeting({
      to: "george",
      members: ["executive", "eqstack"],
      agenda: "a real meeting",
    });
    const callId = real.callId as string;
    expect(platform.log.calls).toHaveLength(1);
    const res = await askOverHttp(callId, { agent: "executive", question: "Ready?" });
    expect(res.status).toBe(409);
    expect(res.json.error).toBe(ASK_MEMBER_REAL_CALL_REFUSAL);
    await expect(
      svc().askMember(callId, { agent: "executive", question: "Ready?" }),
    ).rejects.toThrow(ASK_MEMBER_REAL_CALL_REFUSAL);
    expect(svc().store.listConsultQuestions(callId)).toHaveLength(0);
  });

  it("end_call ends a rehearsal locally: completed, call.ended, no carrier or platform call", async () => {
    await start();
    const callId = await rehearse();
    const res = await fetchRetrying(`${ADMIN}/calls/${callId}/end`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "rehearsal over" }),
    });
    expect(res.status).toBe(200);
    expect(svc().store.getCall(callId)).toMatchObject({
      status: "completed",
      endReason: "rehearsal over",
      rehearsal: true,
    });
    const ended = svc()
      .store.getEvents(callId, 0, 500)
      .filter((e) => e.type === "call.ended");
    expect(ended.map((e) => e.data)).toEqual([{ reason: "rehearsal over", rehearsal: true }]);
    expect(types(callId)).not.toContain("call.hangup_requested");
    expect(sideEffects()).toEqual(NONE);
    // Ended means ended: a further ask is call_ended, not a new question.
    const after = await svc().askMember(callId, { agent: "executive", question: "Still there?" });
    expect(after.status).toBe("call_ended");
  });

  it("the rehearsal flag survives a store re-read and a gateway restart; real calls carry no flag", async () => {
    await start();
    const callId = await rehearse();
    const real = await svc().startMeeting({
      to: "george",
      members: ["executive"],
      agenda: "a real meeting",
    });
    await stop();

    const reread = new SqliteStore(dbPath(), { readonly: true });
    try {
      expect(reread.getCall(callId)?.rehearsal).toBe(true);
      expect(reread.getCall(real.callId as string)).not.toHaveProperty("rehearsal");
      expect(reread.listCalls().find((c) => c.id === callId)?.rehearsal).toBe(true);
    } finally {
      reread.close();
    }

    await start();
    // Still recognised after a restart: ask_member is accepted (not refused) …
    const res = await askOverHttp(callId, { agent: "executive", question: "Back?" });
    expect(res.status).toBe(200);
    expect(res.json.status).toBe("unavailable");
    // … and end_call still closes it locally.
    await svc().endCall(callId, "done");
    expect(svc().store.getCall(callId)?.status).toBe("completed");
    expect(hangup.hungUp).toHaveLength(0);
    expect(telephony.log.calls).toHaveLength(0);
  });

  it("dryRun with rehearsal still creates nothing", async () => {
    await start();
    const result = await svc().startMeeting({
      to: "george",
      members: ["executive"],
      agenda: "preview",
      rehearsal: true,
      dryRun: true,
    });
    expect(result.dryRun).toBe(true);
    expect(result.callId).toBeUndefined();
    expect(svc().store.listCalls()).toHaveLength(0);
    expect(sideEffects()).toEqual(NONE);
  });
});
