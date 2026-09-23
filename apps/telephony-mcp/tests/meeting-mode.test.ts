/**
 * PHASE-GC Step 8 — group-call (GC-1) pins. The whole addressed-consult loop
 * runs for real over loopback HTTP (tool listener + admin API inside
 * startGateway) against FakeAgentPlatform: no network, no paid call (INV-14).
 *
 * Pinned here: start_meeting composes the consult dial path (one agent,
 * `eqstack-meeting`, the roster variables, the bearer as a secret__ variable,
 * the roster rows, meeting.started); dryRun mints nothing; a member polling
 * `as` sees only its own questions and answers them; the other member never
 * sees them; listening is per member (present-but-silent → unavailable); a
 * non-member → not_on_call; `agent` on a non-meeting call → 400 and a meeting
 * call without it → 400, both AFTER the unchanged auth layers; `as` is refused
 * off a meeting or for a non-member; a member's long-poll reads past other
 * members' events instead of busy-looping; the MCP binding filters the
 * no-wait read too.
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AdminClient } from "../src/client/admin-client.js";
import { buildClientRegistry } from "../src/commands/bind-client.js";
import type { Config } from "../src/config/schema.js";
import {
  ASK_AGENT_TOOL_NAME,
  CONSULT_BEARER_VARIABLE,
  MEETING_HARNESS,
} from "../src/domain/agent-brief.js";
import { CONSULT_HOST_NOTICE, MEETING_CONVENOR_NOTICE } from "../src/domain/call-requests.js";
import type { CallEvent } from "../src/domain/types.js";
import type {
  CallService,
  ConsultResult,
  StartMeetingInput,
  StartMeetingResult,
} from "../src/gateway/call-service.js";
import { type Gateway, startGateway } from "../src/gateway/gateway.js";
import { SqliteStore } from "../src/stores/sqlite-store.js";
import {
  consultConfig,
  FakeAgentPlatform,
  FakeSecrets,
  FakeTelephony,
  FixedClock,
  fakeSecretValues,
  MEETING_TEST_VOICES,
  MemoryRecordingStore,
  meetingConfig,
  ScriptedLlm,
  TEST_EL_EGRESS_IP,
  tempStateDir,
  withHoldMs,
} from "./helpers.js";

const PUBLIC_PORT = 19390;
const ADMIN_PORT = 19391;
const TOOLS_PORT = 19392;
const TOOLS = `http://127.0.0.1:${TOOLS_PORT}/v1/consult`;
const ADMIN = `http://127.0.0.1:${ADMIN_PORT}`;
const SERVER = {
  publicBaseUrl: "https://gw.test.invalid",
  publicPort: PUBLIC_PORT,
  adminPort: ADMIN_PORT,
  toolsPort: TOOLS_PORT,
};

let dir: string;
let gateway: Gateway | null = null;
let platform: FakeAgentPlatform;
let clock: FixedClock;

function cfgWith(meeting: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return meetingConfig(meeting, { server: SERVER, ...extra });
}

async function stop(): Promise<void> {
  await gateway?.close();
  gateway = null;
}

async function start(cfg: Config = cfgWith()): Promise<Gateway> {
  gateway = await startGateway(cfg, {
    secrets: new FakeSecrets(fakeSecretValues()),
    telephony: new FakeTelephony(),
    llm: new ScriptedLlm([]),
    recordings: new MemoryRecordingStore(),
    agentPlatform: platform,
    clock,
  });
  return gateway;
}

function svc(): CallService {
  if (!gateway) throw new Error("gateway not started");
  return gateway.service;
}

interface Dialed {
  callId: string;
  conv: string;
  bearer: string;
  sid: string | null;
  result: StartMeetingResult;
}

async function convene(overrides: Partial<StartMeetingInput> = {}): Promise<Dialed> {
  const result = await svc().startMeeting({
    to: "george",
    members: ["executive", "eqstack"],
    agenda: "ship GC-1?",
    ...overrides,
  });
  if (result.dryRun || !result.callId) throw new Error("expected a dial");
  const vars = platform.log.calls.at(-1)?.dynamicVariables ?? {};
  const header = vars[CONSULT_BEARER_VARIABLE];
  if (!header?.startsWith("Bearer ")) throw new Error("no bearer handed to the platform");
  const call = svc().store.getCall(result.callId);
  return {
    callId: result.callId,
    conv: call?.providerCallId as string,
    bearer: header.slice("Bearer ".length),
    sid: svc().store.getPhoneLegSid(result.callId),
    result,
  };
}

async function ask(
  d: Pick<Dialed, "conv" | "bearer" | "sid">,
  body: Record<string, unknown>,
): Promise<{ status: number; json: (ConsultResult & { error?: string }) | null }> {
  const res = await fetch(TOOLS, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${d.bearer}`,
      "CF-Connecting-IP": TEST_EL_EGRESS_IP,
    },
    body: JSON.stringify({
      conversation_id: d.conv,
      ...(d.sid ? { call_sid: d.sid } : {}),
      ...body,
    }),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function poll(
  callId: string,
  opts: { as?: string; afterSeq?: number; waitMs?: number } = {},
): Promise<{ status: number; events: CallEvent[]; nextCursor: number; error?: string }> {
  const q = new URLSearchParams({ afterSeq: String(opts.afterSeq ?? 0) });
  if (opts.waitMs) q.set("waitMs", String(opts.waitMs));
  if (opts.as) q.set("as", opts.as);
  const res = await fetchRetrying(`${ADMIN}/calls/${callId}/events?${q}`);
  const json = (await res.json()) as {
    events: CallEvent[];
    nextCursor: number;
    error?: string;
  };
  return { status: res.status, ...json };
}

/**
 * One retry on a reset socket: every test restarts the gateway on the same
 * port, and fetch's keep-alive pool can hand the next request a socket the
 * previous gateway closed (a test-harness race, not a gateway behaviour).
 */
async function fetchRetrying(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    return fetch(url, init);
  }
}

/** A member session: long-polls with `as` until it sees its question, then answers it. */
async function memberAnswers(callId: string, member: string, answer: string) {
  let after = 0;
  const seen: CallEvent[] = [];
  for (;;) {
    const page = await poll(callId, { as: member, afterSeq: after, waitMs: 5000 });
    seen.push(...page.events);
    const asked = page.events.find((e) => e.type === "consult.asked");
    if (asked) {
      const res = await fetch(
        `${ADMIN}/calls/${callId}/consult/${asked.data.questionId as string}/answer`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ answer }),
        },
      );
      return { seen, answer: (await res.json()) as Record<string, unknown> };
    }
    after = page.nextCursor;
  }
}

function rows(callId: string) {
  return svc().store.listConsultQuestions(callId);
}

function eventsOf(callId: string, type: string): CallEvent[] {
  return svc()
    .store.getEvents(callId, 0, 500)
    .filter((e) => e.type === type);
}

beforeEach(() => {
  dir = tempStateDir();
  platform = new FakeAgentPlatform();
  clock = new FixedClock();
});

afterEach(async () => {
  await stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("start_meeting (Steps 6–7): the consult dial path, with the meeting variant", () => {
  it("provisions ONE ensemble agent, hands EL the roster + a secret__ bearer, writes the roster", async () => {
    await start();
    const d = await convene({ briefs: { executive: "Owns the Q4 roadmap." } });
    expect(platform.log.created).toHaveLength(1);
    const brief = platform.log.created[0];
    expect(brief?.name).toBe("eqstack-meeting");
    expect(brief?.prompt).toContain(MEETING_HARNESS);
    expect(brief?.consultTool?.name).toBe(ASK_AGENT_TOOL_NAME);
    expect(brief?.supportedVoices?.map((v) => v.voiceId)).toEqual([
      MEETING_TEST_VOICES.david,
      MEETING_TEST_VOICES.roger,
    ]);
    const vars = platform.log.calls[0]?.dynamicVariables ?? {};
    expect(vars.call_objective).toBe("ship GC-1?");
    expect(vars.meeting_roster_names).toBe("Executive and EQ Stack");
    expect(vars.meeting_roster).toContain("Brief: Owns the Q4 roadmap.");
    expect(vars.meeting_roster).toContain("Brief: (none: use ask_agent)");
    // The consult machinery is Phase R's: the request row says consult.
    const call = svc().store.getCall(d.callId);
    expect(svc().store.getCallRequest(call?.requestId as string)?.mode).toBe("consult");
    expect(call?.maxDurationSec).toBe(30 * 60);
    expect(call?.recordingEnabled).toBe(false);
    expect(svc().store.hasConsultToken(d.callId)).toBe(true);
    expect(
      svc()
        .store.listMeetingMembers(d.callId)
        .map((m) => [m.member, m.label]),
    ).toEqual([
      ["executive", "Executive"],
      ["eqstack", "Eqstack"],
    ]);
    expect(eventsOf(d.callId, "meeting.started")[0]?.data).toEqual({
      members: ["executive", "eqstack"],
    });
    expect(d.result.roster.map((r) => r.listening)).toEqual([false, false]);
    expect(d.result.joinInstructions.executive).toContain(`call ${d.callId}`);
    expect(d.result.notices).toContain(MEETING_CONVENOR_NOTICE);
    expect(d.result.notices).not.toContain(CONSULT_HOST_NOTICE);
    expect(d.result.agent).toMatchObject({ name: "eqstack-meeting", action: "create" });
  });

  it("a second meeting reuses the agent; a different roster is a different call, the same one dedupes", async () => {
    await start(cfgWith({}, { limits: { maxConcurrentCalls: 3 } }));
    const a = await convene();
    const again = await svc().startMeeting({
      to: "george",
      members: ["executive", "eqstack"],
      agenda: "ship GC-1?",
    });
    expect(again).toMatchObject({ callId: a.callId, deduped: true });
    const b = await svc().startMeeting({
      to: "george",
      members: ["executive"],
      agenda: "ship GC-1?",
    });
    expect(b.callId).not.toBe(a.callId);
    expect(b.agent.action).toBe("reuse");
    expect(platform.log.created).toHaveLength(1);
    expect(svc().store.listMeetingMembers(a.callId)).toHaveLength(2);
  });

  it("dryRun shows the agent, the roster and the join instructions, and mints nothing", async () => {
    await start();
    platform.forbidMutations = true;
    const r = await svc().startMeeting({
      to: "george",
      members: ["eqstack"],
      agenda: "status",
      dryRun: true,
    });
    expect(r.dryRun).toBe(true);
    expect(r.callId).toBeUndefined();
    expect(r.agent.name).toBe("eqstack-meeting");
    expect(r.agent.brief?.supportedVoices?.map((v) => v.label)).toEqual(["Executive", "Eqstack"]);
    expect(r.agent.brief?.consultTool?.addressees).toEqual(["executive", "eqstack"]);
    expect(r.agent.dynamicVariables).toMatchObject({ meeting_roster_names: "EQ Stack" });
    expect(r.agent.dynamicVariables).not.toHaveProperty(CONSULT_BEARER_VARIABLE);
    expect(r.roster).toEqual([
      {
        member: "eqstack",
        displayName: "EQ Stack",
        label: "Eqstack",
        voiceProfile: "roger",
        listening: false,
      },
    ]);
    expect(r.joinInstructions.eqstack).toContain('as: "eqstack"');
    expect(svc().store.listCalls()).toHaveLength(0);
    expect(platform.log.calls).toHaveLength(0);
  });

  it("refuses at plan time, naming what is wrong", async () => {
    await start(consultConfig({}, { server: SERVER }));
    await expect(
      svc().startMeeting({ to: "george", members: ["executive"], agenda: "x" }),
    ).rejects.toThrow(/needs the "meeting" config block/);
    await stop();
    await start();
    for (const [input, msg] of [
      [{ members: ["nobody"] }, /"nobody" is not a configured meeting member/],
      [{ members: ["executive", "executive"] }, /listed twice/],
      [{ members: ["executive"], briefs: { eqstack: "x" } }, /briefs: "eqstack" is not one/],
    ] as const) {
      await expect(
        svc().startMeeting({ to: "george", agenda: "x", ...input } as unknown as StartMeetingInput),
      ).rejects.toThrow(msg);
    }
    await stop();
    await start(
      cfgWith({ chair: { voiceProfile: "lily", personaFile: "/nonexistent/persona.md" } }),
    );
    await expect(
      svc().startMeeting({ to: "george", members: ["executive"], agenda: "x" }),
    ).rejects.toThrow(/personaFile cannot be read \(\/nonexistent\/persona\.md\): ENOENT/);
    expect(svc().store.listCalls()).toHaveLength(0);
  });

  it("the REST row POST /meetings parses with the registry schema (201; 400 on a bad roster)", async () => {
    await start();
    const ok = await fetch(`${ADMIN}/meetings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: "george", members: ["executive"], agenda: "x", dryRun: true }),
    });
    expect(ok.status).toBe(201);
    const bad = await fetch(`${ADMIN}/meetings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: "george", members: [], agenda: "x" }),
    });
    expect(bad.status).toBe(400);
  });
});

describe("addressed consult (Step 6, D-105): ask_agent → get_call_events {as} → answer_consult", () => {
  it("end to end: executive sees only its own question and answers; eqstack never sees it", async () => {
    await start();
    const d = await convene();
    const exec = memberAnswers(d.callId, "executive", "The board pack is due Friday.");
    // eqstack is listening too — its long-poll is open across the question —
    // and must see nothing addressed to executive.
    const before = svc().store.getEvents(d.callId, 0, 500).at(-1)?.seq ?? 0;
    const other = poll(d.callId, { as: "eqstack", afterSeq: before, waitMs: 400 });
    await new Promise((r) => setTimeout(r, 50));
    expect(svc().isHostListening(d.callId, "executive")).toBe(true);
    expect(svc().isHostListening(d.callId, "eqstack")).toBe(true);
    // An ordinary (un-addressed) host poll is NOT a member listening.
    expect(svc().isHostListening(d.callId)).toBe(false);

    const r = await ask(d, { agent: "executive", question: "What is due this week?" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      status: "answered",
      agent: "executive",
      answer: "The board pack is due Friday.",
    });
    const { seen, answer } = await exec;
    expect(answer).toEqual({ status: "answered", delivered: true, collectable: false });
    expect(seen.filter((e) => e.type === "consult.asked").map((e) => e.data.addressee)).toEqual([
      "executive",
    ]);
    const eq = await other;
    expect(eq.events.filter((e) => e.type.startsWith("consult.asked"))).toHaveLength(0);
    const [q] = rows(d.callId);
    expect(q).toMatchObject({ addressee: "executive", status: "delivered", deliveredVia: "held" });
    expect(q?.firstDeliveredMs).not.toBeNull();
    const members = svc().store.listMeetingMembers(d.callId);
    expect(members.find((m) => m.member === "executive")).toMatchObject({
      questionsAsked: 1,
      firstPolledMs: clock.now,
    });
    expect(members.find((m) => m.member === "eqstack")?.questionsAsked).toBe(0);
  });

  it("a member that is present but not listening → unavailable at once, worded for the chair", async () => {
    await start();
    const d = await convene();
    svc().noteHostPoll(d.callId, "eqstack")(); // only eqstack is at its desk
    const started = Date.now();
    const r = await ask(d, { agent: "executive", question: "Anything new?" });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(r.json).toMatchObject({ status: "unavailable", agent: "executive" });
    expect((r.json as { guidance: string }).guidance).toMatch(/not at its desk/);
    expect(rows(d.callId)[0]).toMatchObject({ addressee: "executive", status: "unanswered" });
    expect(eventsOf(d.callId, "consult.unanswered")[0]?.data).toMatchObject({
      addressee: "executive",
    });
  });

  it("a configured member who is not on THIS call → not_on_call, and nothing is stored", async () => {
    await start();
    const d = await convene({ members: ["executive"] });
    svc().noteHostPoll(d.callId, "executive")();
    const r = await ask(d, { agent: "eqstack", question: "Build status?" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ status: "not_on_call", agent: "eqstack" });
    expect(rows(d.callId)).toHaveLength(0);
    expect(gateway?.metrics.renderProm()).toMatch(/^tel_consult_outcome_not_on_call_total 1$/m);
  });

  it("`agent` on a non-meeting consult call → 400; a meeting call WITHOUT it → 400", async () => {
    await start(cfgWith({}, { limits: { maxConcurrentCalls: 2 } }));
    const res = await svc().placeCall({
      to: "george",
      objective: "plain consult",
      mode: "consult",
      record: false,
    });
    if (res.dryRun) throw new Error("expected a dial");
    const header = platform.log.calls.at(-1)?.dynamicVariables[CONSULT_BEARER_VARIABLE] ?? "";
    const plain = {
      conv: res.call.providerCallId as string,
      bearer: header.slice("Bearer ".length),
      sid: svc().store.getPhoneLegSid(res.call.id),
    };
    svc().noteHostPoll(res.call.id)();
    const r = await ask(plain, { agent: "executive", question: "hi?" });
    expect(r.status).toBe(400);
    expect(r.json?.error).toMatch(/only accepted on a meeting call/);
    expect(rows(res.call.id)).toHaveLength(0);

    const d = await convene();
    svc().noteHostPoll(d.callId, "executive")();
    const m = await ask(d, { question: "who is this for?" });
    expect(m.status).toBe(400);
    expect(m.json?.error).toMatch(/agent is required on a meeting call/);
    expect(rows(d.callId)).toHaveLength(0);
  });

  it("the auth layers are untouched: a wrong bearer on a meeting call is still a bare 401", async () => {
    await start();
    const d = await convene();
    const r = await ask({ ...d, bearer: `${d.bearer}x` }, { agent: "executive", question: "x" });
    expect(r.status).toBe(401);
    expect(r.json).toBeNull();
    const conv = await ask({ ...d, conv: "conv_other" }, { agent: "executive", question: "x" });
    expect(conv.status).toBe(401);
  });

  it("the meeting hold (not consult's 45 s) → pending, named; the late answer is collected", async () => {
    await start(withHoldMs(cfgWith(), 60));
    const d = await convene();
    svc().noteHostPoll(d.callId, "eqstack")();
    const r = await ask(d, { agent: "eqstack", question: "Is the build green?" });
    expect(r.json).toMatchObject({ status: "pending", agent: "eqstack" });
    expect((r.json as { guidance: string }).guidance).toMatch(/ask_agent again/);
    const qid = (r.json as { question_id: string }).question_id;
    svc().answerConsult(d.callId, qid, "Green.");
    const c = await ask(d, { agent: "eqstack", collect_question_id: qid });
    expect(c.json).toEqual({
      status: "answered",
      question_id: qid,
      answer: "Green.",
      agent: "eqstack",
    });
  });

  it("the same words to two members are two questions, not a joined repeat", async () => {
    await start(withHoldMs(cfgWith(), 60));
    const d = await convene();
    svc().noteHostPoll(d.callId, "executive")();
    svc().noteHostPoll(d.callId, "eqstack")();
    await Promise.all([
      ask(d, { agent: "executive", question: "Any blockers?" }),
      ask(d, { agent: "eqstack", question: "Any blockers?" }),
    ]);
    expect(
      rows(d.callId)
        .map((q) => q.addressee)
        .sort(),
    ).toEqual(["eqstack", "executive"]);
  });

  it("the call ending cancels a held meeting question and forgets every member's listening", async () => {
    await start();
    const d = await convene();
    svc().noteHostPoll(d.callId, "executive")();
    const held = ask(d, { agent: "executive", question: "Hold on this?" });
    for (let i = 0; i < 100 && eventsOf(d.callId, "consult.asked").length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    svc().emit(d.callId, "call.ended", { reason: "test" });
    expect((await held).json).toMatchObject({ status: "call_ended" });
    expect(svc().isHostListening(d.callId, "executive")).toBe(false);
    expect(svc().store.hasConsultToken(d.callId)).toBe(false);
  });
});

describe("get_call_events {as} (Step 7)", () => {
  it("is refused off a meeting and for a member not on this meeting", async () => {
    await start(cfgWith({}, { limits: { maxConcurrentCalls: 2 } }));
    const d = await convene({ members: ["executive"] });
    const bad = await poll(d.callId, { as: "eqstack" });
    expect(bad.status).toBe(400);
    expect(bad.error).toMatch(/"eqstack" is not on this meeting/);
    const res = await svc().placeCall({
      to: "george",
      objective: "o",
      mode: "consult",
      record: false,
    });
    if (res.dryRun) throw new Error("expected a dial");
    const off = await poll(res.call.id, { as: "executive" });
    expect(off.status).toBe(400);
    expect(off.error).toMatch(/not a meeting/);
    // Neither refusal marked anyone listening.
    expect(svc().isHostListening(res.call.id, "executive")).toBe(false);
  });

  it("a member's long-poll reads PAST another member's question and keeps waiting (no busy loop)", async () => {
    await start(withHoldMs(cfgWith(), 400));
    const d = await convene();
    svc().noteHostPoll(d.callId, "eqstack")();
    const before = svc().store.getEvents(d.callId, 0, 500).at(-1)?.seq ?? 0;
    // A question for eqstack lands; executive's poll must not return on it.
    void ask(d, { agent: "eqstack", question: "Build?" });
    for (let i = 0; i < 100 && eventsOf(d.callId, "consult.asked").length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const started = Date.now();
    const page = await poll(d.callId, { as: "executive", afterSeq: before, waitMs: 300 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(page.events.filter((e) => e.type === "consult.asked")).toHaveLength(0);
    // The cursor moved past the filtered event, so the next poll does not re-read it.
    expect(page.nextCursor).toBeGreaterThan(before);
  });

  it("an ordinary poll (no `as`) is unchanged: it sees every question, and its cursor is its last event", async () => {
    await start();
    const d = await convene();
    svc().noteHostPoll(d.callId, "executive")();
    await ask(d, { agent: "eqstack", question: "unheard" }); // eqstack not listening → unanswered
    const page = await poll(d.callId);
    expect(page.events.some((e) => e.type === "consult.unanswered")).toBe(true);
    expect(page.nextCursor).toBe(page.events.at(-1)?.seq);
  });

  it("the MCP binding: the no-wait read filters with `as` too, and continues from nextCursor", async () => {
    await start();
    const d = await convene();
    await ask(d, { agent: "eqstack", question: "for eqstack only" }); // unanswered event
    const registry = buildClientRegistry({
      admin: new AdminClient(ADMIN_PORT),
      openReadStore: () => new SqliteStore(join(dir, "telephony-mcp.sqlite3"), { readonly: true }),
    });
    const tool = registry.get("get_call_events");
    if (!tool) throw new Error("no tool");
    const mine = (await tool.handler({ callId: d.callId, as: "executive" }, undefined)) as {
      events: CallEvent[];
      nextCursor: number;
    };
    expect(mine.events.some((e) => e.type === "consult.unanswered")).toBe(false);
    const all = svc().store.getEvents(d.callId, 0, 500);
    expect(mine.nextCursor).toBe(all.at(-1)?.seq);
    const theirs = (await tool.handler({ callId: d.callId, as: "eqstack" }, undefined)) as {
      events: CallEvent[];
    };
    expect(theirs.events.some((e) => e.type === "consult.unanswered")).toBe(true);
    await expect(tool.handler({ callId: d.callId, as: "nobody" }, undefined)).rejects.toThrow(
      /not on this meeting/,
    );
  });
});
