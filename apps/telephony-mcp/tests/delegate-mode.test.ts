/**
 * Phase Q step 7 — the delegate-mode pins, service-level so the clock and the
 * poller are driven explicitly. Everything runs against FakeAgentPlatform and
 * FakeTelephony: no network, no paid call (INV-14).
 *
 * Pinned here: dryRun creates nothing (the fake THROWS on any mutation);
 * provisioning is idempotent (create once, reuse, update on a changed brief,
 * recreate on a platform-side delete); no relay token and no Twilio dial for a
 * delegate call (INV-7); say_on_call / play_disclosure / set_recording /
 * end_call refuse with an error that names the mode; the poller is idempotent
 * (repeat, concurrent and restarted polls never double-write), holds back an
 * unsettled item, stops on terminal status and writes call.ended with the
 * reason; D-76's third-party recording consent; and an INV-11 byte scan.
 */
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TwilioPhoneLegHangup } from "../src/adapters/telephony/twilio-hangup.js";
import type { Config } from "../src/config/schema.js";
import { HARNESS_PREAMBLE } from "../src/domain/agent-brief.js";
import {
  CallService,
  CallServiceError,
  DELEGATE_POLL_GRACE_SEC,
} from "../src/gateway/call-service.js";
import { DelegatePoller } from "../src/gateway/delegate-poller.js";
import { SqliteStore } from "../src/stores/sqlite-store.js";
import {
  delegateConfig,
  FakeAgentPlatform,
  FakePhoneLegHangup,
  FakeSecrets,
  FakeTelephony,
  FixedClock,
  ForbiddenPlatformCall,
  fakeCallSid,
  MemoryRecordingStore,
  said,
  seqIds,
  TEST_PHONE_NUMBER_ID,
  tempStateDir,
} from "./helpers.js";

const ADHOC = "+61400999888";
const GEORGE = "+61400111222"; // testConfig's preconsented recipient

describe("delegate mode (Phase Q)", () => {
  let dir: string;
  let dbFile: string;
  let store: SqliteStore;
  let telephony: FakeTelephony;
  let platform: FakeAgentPlatform;
  let clock: FixedClock;
  let ids: ReturnType<typeof seqIds>;
  let service: CallService;

  function build(
    cfg: Config = delegateConfig(),
    hangup: ConstructorParameters<typeof CallService>[8] = null,
  ): CallService {
    return new CallService(
      cfg,
      store,
      telephony,
      new MemoryRecordingStore(),
      clock,
      ids, // shared across rebuilds: a "restarted" service must not reuse row ids
      undefined,
      platform,
      hangup,
    );
  }

  beforeEach(() => {
    dir = tempStateDir();
    dbFile = join(dir, "telephony-mcp.sqlite3");
    store = new SqliteStore(dbFile);
    telephony = new FakeTelephony();
    platform = new FakeAgentPlatform();
    clock = new FixedClock();
    ids = seqIds();
    service = build();
  });
  afterEach(() => {
    service.shutdown();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function place(overrides: Record<string, unknown> = {}, svc = service) {
    return svc.placeCall({
      to: "george",
      objective: "confirm Thursday's booking",
      mode: "delegate",
      record: false,
      ...overrides,
    } as Parameters<CallService["placeCall"]>[0]);
  }

  async function dial(overrides: Record<string, unknown> = {}, svc = service) {
    const res = await place(overrides, svc);
    if (res.dryRun) throw new Error("expected a dial");
    return res;
  }

  function poller(callId: string): DelegatePoller {
    const p = service.delegatePoller(callId);
    if (!p) throw new Error(`no poller for ${callId}`);
    return p;
  }

  function convOf(callId: string): string {
    const c = store.getCall(callId);
    if (!c?.providerCallId) throw new Error("call has no conversation id");
    return c.providerCallId;
  }

  // ── dryRun ────────────────────────────────────────────────────────────────

  describe("dryRun creates nothing, anywhere", () => {
    it("the fake throws on any mutation; dryRun still returns the resolved agent + brief", async () => {
      platform.forbidMutations = true;
      const res = await place({ dryRun: true, context: "table for two" });
      if (!res.dryRun) throw new Error("expected a plan");
      expect(res.plan.mode).toBe("delegate");
      expect(res.agent?.action).toBe("create");
      expect(res.agent?.agentId).toBeNull();
      expect(res.agent?.name).toBe("eqstack-default");
      expect(res.agent?.brief?.prompt.startsWith(HARNESS_PREAMBLE)).toBe(true);
      expect(res.agent?.dynamicVariables).toEqual({
        call_objective: "confirm Thursday's booking",
        call_context: "table for two",
      });
      expect(platform.log.created).toHaveLength(0);
      expect(platform.log.calls).toHaveLength(0);
      expect(telephony.log.calls).toHaveLength(0);
      expect(store.listCalls({ limit: 10 })).toHaveLength(0);
      expect(store.getAgentProfile("default")).toBeNull();
      // The forbid switch is live — the same input without dryRun must throw it.
      await expect(place()).rejects.toThrow(/createAgent called while mutations are forbidden/);
    });

    it("dryRun after provisioning previews 'reuse' with the known agent id, still creating nothing", async () => {
      await dial();
      platform.forbidMutations = true;
      const res = await place({ dryRun: true });
      if (!res.dryRun) throw new Error("expected a plan");
      expect(res.agent?.action).toBe("reuse");
      expect(res.agent?.agentId).toBe("agent_fake1");
    });
  });

  // ── the call path ─────────────────────────────────────────────────────────

  describe("dial path (INV-7: laptop out of the media path)", () => {
    it("provisions once, dials through the platform, never through Twilio, and mints no relay token", async () => {
      const res = await dial({ context: "they asked for the patio" });
      expect(telephony.log.calls).toHaveLength(0);
      expect(platform.log.created).toHaveLength(1);
      expect(platform.log.calls).toHaveLength(1);
      const req = platform.log.calls[0];
      expect(req?.to).toBe(GEORGE); // the full number reaches ONLY the adapter
      expect(req?.phoneNumberId).toBe(TEST_PHONE_NUMBER_ID);
      expect(req?.agentId).toBe("agent_fake1");
      expect(req?.dynamicVariables).toEqual({
        call_objective: "confirm Thursday's booking",
        call_context: "they asked for the patio",
      });
      expect(res.call.providerCallId).toBe("conv_fake2");
      expect(res.agent).toMatchObject({ agentId: "agent_fake1", action: "create" });
      expect(store.getRelayTokenForCall(res.call.id)).toBeNull();
      expect(store.getCallRequest(res.call.requestId)?.mode).toBe("delegate");
      expect(service.delegatePoller(res.call.id)).not.toBeNull();
    });

    it("the same profile reuses its agent — no second create, no update", async () => {
      const first = await dial();
      platform.script(convOf(first.call.id), { status: "done", terminationReason: "end_call" });
      await poller(first.call.id).pollOnce();
      const second = await dial({ objective: "a different errand" });
      expect(platform.log.created).toHaveLength(1);
      expect(platform.log.updated).toHaveLength(0);
      expect(second.agent?.action).toBe("reuse");
      expect(platform.log.calls.map((c) => c.agentId)).toEqual(["agent_fake1", "agent_fake1"]);
    });

    it("a changed profile brief updates the SAME agent once, then reuses it", async () => {
      const first = await dial();
      platform.script(convOf(first.call.id), { status: "done" });
      await poller(first.call.id).pollOnce();
      service.shutdown();
      const edited = delegateConfig({
        profiles: { default: { systemPrompt: "A rewritten brief.", greeting: "Hello there." } },
      });
      service = build(edited);
      const second = await dial({ objective: "second" });
      expect(second.agent?.action).toBe("update");
      expect(platform.log.updated).toHaveLength(1);
      expect(platform.log.updated[0]?.agentId).toBe("agent_fake1");
      expect(platform.log.updated[0]?.brief.prompt).toContain("A rewritten brief.");
      platform.script(convOf(second.call.id), { status: "done" });
      await poller(second.call.id).pollOnce();
      const third = await dial({ objective: "third" });
      expect(third.agent?.action).toBe("reuse");
      expect(platform.log.created).toHaveLength(1);
    });

    it("an agent deleted on the platform side is recreated, not dialed dead", async () => {
      const first = await dial();
      platform.script(convOf(first.call.id), { status: "done" });
      await poller(first.call.id).pollOnce();
      platform.deletedAgents.add("agent_fake1");
      service.shutdown();
      service = build(delegateConfig({ profiles: { default: { systemPrompt: "changed" } } }));
      const second = await dial({ objective: "after delete" });
      expect(second.agent?.action).toBe("create");
      expect(platform.log.created).toHaveLength(2);
      expect(store.getAgentProfile("default")?.agentId).toBe(second.agent?.agentId);
    });

    it("idempotency and concurrency apply unchanged: a concurrent identical race dials and provisions once", async () => {
      const [a, b] = await Promise.all([place(), place()]);
      if (a.dryRun || b.dryRun) throw new Error("expected dials");
      expect(a.call.id).toBe(b.call.id);
      expect(platform.log.calls).toHaveLength(1);
      expect(platform.log.created).toHaveLength(1);
      await expect(place({ objective: "while one is live" })).rejects.toThrow(/concurrency limit/);
    });

    it("a platform dial failure marks the call failed, frees the claim, and surfaces the error", async () => {
      platform.failNextCall = "ElevenLabs POST /v1/convai/twilio/outbound-call → 422: nope";
      await expect(place()).rejects.toThrow(/dial failed: .*422/);
      expect(store.activeCallCount()).toBe(0);
      const retry = await dial();
      expect(retry.deduped).toBe(false);
    });

    it("needs no publicBaseUrl — a delegate call has no public leg", async () => {
      service.shutdown();
      const cfg = delegateConfig({ server: { publicPort: 18790, adminPort: 18791 } });
      expect(cfg.server.publicBaseUrl).toBeUndefined();
      service = build(cfg);
      await expect(dial()).resolves.toBeDefined();
    });
  });

  // ── refusals ──────────────────────────────────────────────────────────────

  describe("host-side tools refuse with a mode-naming error", () => {
    it.each([
      ["say_on_call", (s: CallService, id: string) => s.say(id, "hello?"), /get_call_events/],
      [
        "play_disclosure",
        (s: CallService, id: string) => s.playDisclosure(id),
        /greeting or systemPrompt/,
      ],
      [
        "set_recording",
        (s: CallService, id: string) => s.setRecording(id, true),
        /fixes recording when the call starts/,
      ],
      [
        "set_recording",
        (s: CallService, id: string) => s.setRecording(id, false),
        /neither started nor stopped/,
      ],
      [
        "end_call",
        (s: CallService, id: string) => s.endCall(id, "operator"),
        /no API that hangs up/,
      ],
    ] as const)("%s", async (tool, run, hint) => {
      const res = await dial();
      const attempt = run(service, res.call.id);
      await expect(attempt).rejects.toThrow(CallServiceError);
      await expect(run(service, res.call.id)).rejects.toThrow(
        new RegExp(`^${tool} is refused on a 'delegate' call: `),
      );
      await expect(run(service, res.call.id)).rejects.toThrow(hint);
      expect(telephony.log.ended).toHaveLength(0);
      expect(telephony.log.recordingStarts).toHaveLength(0);
      expect(store.getCall(res.call.id)?.status).toBe("created");
    });

    it("the refusal keys off mediaPathOffDevice, not hostAnswersTurns: byo-model say is NOT refused by it", async () => {
      service.shutdown();
      service = build();
      const res = await service.placeCall({
        to: "george",
        objective: "llm call",
        mode: "byo-model",
      });
      if (res.dryRun) throw new Error("expected a dial");
      // byo-model has hostAnswersTurns=false too, but operator interjection is
      // legitimate there; it fails only because no relay session attached yet.
      await expect(service.say(res.call.id, "hi")).rejects.toThrow(/no live session/);
    });

    it("end_call on an already-ended delegate call stays a no-op (idempotent)", async () => {
      const res = await dial();
      platform.script(convOf(res.call.id), { status: "done" });
      await poller(res.call.id).pollOnce();
      await expect(service.endCall(res.call.id, "late")).resolves.toBeUndefined();
    });
  });

  // ── end_call through the carrier (O-30) ──────────────────────────────────

  describe("end_call hangs up through the carrier when configured (O-30)", () => {
    let hangup: FakePhoneLegHangup;

    beforeEach(() => {
      service.shutdown();
      hangup = new FakePhoneLegHangup();
      service = build(delegateConfig(), hangup);
    });

    it("the dial persists the phone-leg SID beside the conversation id (which stays providerCallId)", async () => {
      const res = await dial();
      expect(res.call.providerCallId).toMatch(/^conv_fake\d+$/);
      expect(store.getPhoneLegSid(res.call.id)).toBe(fakeCallSid(2));
    });

    it("the SID is persisted even without a hang-up configured, so enabling one later covers live calls", async () => {
      service.shutdown();
      service = build();
      const res = await dial();
      expect(store.getPhoneLegSid(res.call.id)).toBe(fakeCallSid(2));
    });

    it("hangs up the stored SID, announces it once, and leaves call.ended to the poller with the transcript intact", async () => {
      const res = await dial();
      const conv = convOf(res.call.id);
      platform.script(conv, { status: "in-progress", transcript: [] });
      await poller(res.call.id).pollOnce();

      await service.endCall(res.call.id, "operator");
      expect(hangup.hungUp).toEqual([fakeCallSid(2)]);
      expect(telephony.log.ended).toHaveLength(0); // never the main-account adapter
      // Not terminal yet: the platform still owes the transcript (D-83).
      expect(store.getCall(res.call.id)?.status).toBe("answered");
      expect(poller(res.call.id).isStopped).toBe(false);
      let types = store.getEvents(res.call.id).map((e) => e.type);
      expect(types).not.toContain("call.ended");
      const req = store.getEvents(res.call.id).find((e) => e.type === "call.hangup_requested");
      expect(req?.data).toEqual({ reason: "operator", via: "fake-hangup", outcome: "ended" });

      // Repeating end_call before the platform settles: carrier says already
      // ended, and no second announcement.
      await service.endCall(res.call.id, "again");
      expect(hangup.hungUp).toHaveLength(2);
      types = store.getEvents(res.call.id).map((e) => e.type);
      expect(types.filter((t) => t === "call.hangup_requested")).toHaveLength(1);

      platform.script(conv, {
        status: "done",
        transcript: [said("agent", "Hello."), said("user", "Hi, who is this?")],
        terminationReason: "Call ended by remote party",
      });
      expect(await poller(res.call.id).pollOnce()).toBe("terminal");
      expect(store.getCall(res.call.id)?.status).toBe("completed");
      expect(store.getTranscript(res.call.id)).toHaveLength(2);
      types = store.getEvents(res.call.id).map((e) => e.type);
      expect(types.filter((t) => t === "call.ended")).toHaveLength(1);

      // Ended now: end_call is a no-op and touches the carrier no more.
      await service.endCall(res.call.id, "late");
      expect(hangup.hungUp).toHaveLength(2);
    });

    it("a carrier that reports the leg already over (21220) is success, not an error", async () => {
      const res = await dial();
      hangup.ended.add(fakeCallSid(2));
      await expect(service.endCall(res.call.id, "operator")).resolves.toBeUndefined();
      const req = store.getEvents(res.call.id).find((e) => e.type === "call.hangup_requested");
      expect(req?.data).toMatchObject({ outcome: "already-ended" });
    });

    it("a failed hang-up is a 502 and changes nothing: no event, record still live", async () => {
      const res = await dial();
      hangup.failNext = "Twilio POST … → 401: Authenticate";
      const err = await service.endCall(res.call.id, "operator").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CallServiceError);
      expect((err as CallServiceError).httpStatus).toBe(502);
      expect((err as Error).message).toMatch(/^end_call could not hang up through fake-hangup: /);
      expect(store.getCall(res.call.id)?.status).toBe("created");
      const types = store.getEvents(res.call.id).map((e) => e.type);
      expect(types).not.toContain("call.hangup_requested");
      expect(types).not.toContain("call.ended");
    });

    it("no SID on record (platform returned none): refused, naming the mode, and the carrier is not called", async () => {
      platform.returnPhoneLegSid = false;
      const res = await dial();
      expect(store.getPhoneLegSid(res.call.id)).toBeNull();
      await expect(service.endCall(res.call.id, "operator")).rejects.toThrow(
        /^end_call is refused on a 'delegate' call: no phone-leg call SID is recorded/,
      );
      expect(hangup.hungUp).toHaveLength(0);
    });

    it("the branch keys off mediaPathOffDevice: a byo-model call still ends through the telephony adapter", async () => {
      const res = await service.placeCall({ to: "george", objective: "llm", mode: "byo-model" });
      if (res.dryRun) throw new Error("expected a dial");
      await service.endCall(res.call.id, "operator");
      expect(hangup.hungUp).toHaveLength(0);
      expect(telephony.log.ended).toEqual([res.call.providerCallId]);
      expect(store.getCall(res.call.id)?.status).toBe("completed");
    });

    it("no secret value reaches the error or any log line (real adapter, fake fetch)", async () => {
      const SECRET = "fake-hangup-secret-9f8e7d6c5b4a";
      const auth = Buffer.from(`SK${"2".repeat(32)}:${SECRET}`).toString("base64");
      const fetchImpl = (async () =>
        new Response(JSON.stringify({ code: 20003, message: `bad ${SECRET} ${auth}` }), {
          status: 401,
        })) as typeof fetch;
      service.shutdown();
      service = build(
        delegateConfig(),
        new TwilioPhoneLegHangup({
          accountSid: `AC${"1".repeat(32)}`,
          apiKeySid: `SK${"2".repeat(32)}`,
          apiSecretRef: "TWILIO_API_KEY_ELEVENLABS_SUBACCOUNT_CALLS_RW",
          secrets: new FakeSecrets({ TWILIO_API_KEY_ELEVENLABS_SUBACCOUNT_CALLS_RW: SECRET }),
          fetchImpl,
        }),
      );
      const res = await dial();
      const written: string[] = [];
      const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
        written.push(String(chunk));
        return true;
      });
      let err: unknown;
      try {
        err = await service.endCall(res.call.id, "operator").catch((e: unknown) => e);
      } finally {
        spy.mockRestore();
      }
      expect((err as Error).message).toMatch(/→ 401 \(code 20003\)/);
      expect(written.join("")).toContain("phone-leg hang-up failed");
      for (const text of [(err as Error).message, written.join(""), readFileSync(dbFile)]) {
        expect(String(text)).not.toContain(SECRET);
        expect(String(text)).not.toContain(auth);
      }
    });
  });

  // ── the poller ────────────────────────────────────────────────────────────

  describe("poller (step 6)", () => {
    it("advances status, writes settled turns in order, holds back the live last item", async () => {
      const res = await dial();
      const conv = convOf(res.call.id);
      platform.script(conv, {
        status: "in-progress",
        transcript: [
          said("agent", "Hi, this is George's assistant."),
          said("user", "Oh hi, who is this?"),
          said("agent", "I'm calling about Thurs"), // still being spoken
        ],
      });
      expect(await poller(res.call.id).pollOnce()).toBe("live");
      expect(store.getCall(res.call.id)?.status).toBe("answered");
      const t = store.getTranscript(res.call.id);
      expect(t.map((u) => [u.turn, u.role, u.text])).toEqual([
        [0, "assistant", "Hi, this is George's assistant."],
        [1, "user", "Oh hi, who is this?"],
      ]);
      const types = store.getEvents(res.call.id).map((e) => e.type);
      expect(types).toEqual(["call.created", "call.answered", "turn.assistant", "turn.user"]);
      // Same event shape as a relay session: no text on the stream.
      const userEv = store.getEvents(res.call.id).find((e) => e.type === "turn.user");
      expect(userEv?.data).toEqual({ turn: 1, chars: "Oh hi, who is this?".length });
    });

    it("a duplicated, concurrent, or restarted poll never double-writes a turn", async () => {
      const res = await dial();
      const conv = convOf(res.call.id);
      platform.script(conv, {
        status: "in-progress",
        transcript: [said("agent", "Hello."), said("user", "Hi."), said("agent", "Great.")],
      });
      const p = poller(res.call.id);
      await p.pollOnce();
      await p.pollOnce();
      await Promise.all([p.pollOnce(), p.pollOnce(), p.pollOnce()]);
      // A second poller over the same store = serve restarted mid-call.
      const reborn = new DelegatePoller({
        callId: res.call.id,
        conversationId: conv,
        platform,
        service,
        clock,
        intervalMs: 60_000,
        deadlineMs: clock.nowMs() + 3_600_000,
      });
      await reborn.pollOnce();
      expect(store.getTranscript(res.call.id)).toHaveLength(2);
      const evs = store.getEvents(res.call.id).map((e) => e.type);
      expect(evs.filter((t) => t.startsWith("turn."))).toHaveLength(2);
      expect(evs.filter((t) => t === "call.answered")).toHaveLength(1);
      reborn.stop();
    });

    it("on done: flushes the last item, closes the call, writes call.ended with the reason, and stops", async () => {
      const res = await dial();
      const conv = convOf(res.call.id);
      platform.script(conv, {
        status: "in-progress",
        transcript: [said("agent", "Hello."), said("user", "Yes, Thursday works.")],
      });
      await poller(res.call.id).pollOnce();
      platform.script(conv, {
        status: "done",
        transcript: [
          said("agent", "Hello."),
          said("user", "Yes, Thursday works."),
          said("agent", null), // a tool call: never an utterance
          said("agent", "Perfect, see you then. Bye!"),
        ],
        terminationReason: "end_call tool was called.",
        callDurationSecs: 42,
      });
      const p = poller(res.call.id);
      expect(await p.pollOnce()).toBe("terminal");
      expect(p.isStopped).toBe(true);
      expect(service.delegatePoller(res.call.id)).toBeNull();
      const call = store.getCall(res.call.id);
      expect(call?.status).toBe("completed");
      expect(call?.endReason).toBe("end_call tool was called.");
      expect(store.activeCallCount()).toBe(0);
      expect(store.getTranscript(res.call.id).map((u) => u.text)).toEqual([
        "Hello.",
        "Yes, Thursday works.",
        "Perfect, see you then. Bye!",
      ]);
      const ended = store.getEvents(res.call.id).filter((e) => e.type === "call.ended");
      expect(ended).toHaveLength(1);
      expect(ended[0]?.data).toEqual({
        reason: "end_call tool was called.",
        providerStatus: "done",
        durationSec: 42,
        platformHasAudio: false,
      });
      // Polling a finished call is a no-op, not a second call.ended.
      const before = platform.log.polls.length;
      expect(await p.pollOnce()).toBe("terminal");
      expect(platform.log.polls.length).toBe(before);
    });

    it("processing is not terminal: the poller waits for done before trusting the transcript", async () => {
      const res = await dial();
      platform.script(convOf(res.call.id), {
        status: "processing",
        transcript: [said("user", "Bye."), said("agent", "Bye!")],
      });
      expect(await poller(res.call.id).pollOnce()).toBe("live");
      expect(store.getCall(res.call.id)?.status).toBe("answered");
      expect(store.getTranscript(res.call.id)).toHaveLength(1);
    });

    it("failed → call failed, call.ended carries providerStatus failed", async () => {
      const res = await dial();
      platform.script(convOf(res.call.id), { status: "failed", terminationReason: "no-answer" });
      await poller(res.call.id).pollOnce();
      expect(store.getCall(res.call.id)?.status).toBe("failed");
      const ended = store.getEvents(res.call.id).find((e) => e.type === "call.ended");
      expect(ended?.data).toMatchObject({ reason: "no-answer", providerStatus: "failed" });
    });

    it("a poll error is one event per streak and keeps polling", async () => {
      const res = await dial();
      const p = poller(res.call.id);
      platform.failNextPoll = "ElevenLabs GET → 503";
      expect(await p.pollOnce()).toBe("live");
      platform.failNextPoll = "ElevenLabs GET → 503";
      expect(await p.pollOnce()).toBe("live");
      const errs = store.getEvents(res.call.id).filter((e) => e.type === "delegate.poll_error");
      expect(errs).toHaveLength(1);
      platform.script(convOf(res.call.id), { status: "done" });
      expect(await p.pollOnce()).toBe("terminal");
    });

    it("past maxDuration + grace with no terminal status, the record is closed honestly", async () => {
      const res = await dial();
      clock.advance((res.call.maxDurationSec + DELEGATE_POLL_GRACE_SEC) * 1000 + 1);
      expect(await poller(res.call.id).pollOnce()).toBe("terminal");
      expect(store.getCall(res.call.id)?.status).toBe("failed");
      const ended = store.getEvents(res.call.id).find((e) => e.type === "call.ended");
      expect(ended?.data).toMatchObject({ reason: "poll_deadline_exceeded" });
      expect(store.activeCallCount()).toBe(0);
    });

    it("resumeDelegatePollers picks a live delegate call back up after a restart", async () => {
      const res = await dial();
      service.shutdown(); // serve died; the call row is still live
      service = build();
      expect(service.delegatePoller(res.call.id)).toBeNull();
      expect(service.resumeDelegatePollers()).toBe(1);
      platform.script(convOf(res.call.id), { status: "done", transcript: [said("user", "Hi")] });
      await poller(res.call.id).pollOnce();
      expect(store.getTranscript(res.call.id)).toHaveLength(1);
    });
  });

  // ── D-76: recording held by a third party ─────────────────────────────────

  describe("third-party recording consent (D-76)", () => {
    it("record: true without acknowledgement is refused, naming the holder — and nothing is created", async () => {
      const attempt = place({ record: true });
      await expect(attempt).rejects.toThrow(CallServiceError);
      await expect(place({ record: true })).rejects.toThrow(
        /held by ElevenLabs, a third party.*acknowledgeThirdPartyRecording: true.*consent\.autoApproveThirdPartyDisclosures/,
      );
      expect(platform.log.created).toHaveLength(0);
      expect(platform.log.calls).toHaveLength(0);
    });

    it("record: true + acknowledgement records via a separate recorded agent, and the result discloses it", async () => {
      const res = await dial({ record: true, acknowledgeThirdPartyRecording: true });
      expect(res.call.recordingEnabled).toBe(true);
      expect(res.agent?.name).toBe("eqstack-default-recorded");
      expect(platform.log.created[0]?.recordVoice).toBe(true);
      expect(store.getAgentProfile("default+recorded")?.agentId).toBe(res.agent?.agentId);
      expect(res.notices).toHaveLength(1);
      expect(res.notices?.[0]).toMatch(/recorded by ElevenLabs, a third party/);
      expect(res.notices?.[0]).toMatch(/never copies it locally/);
    });

    it("an implicit default (preconsented) does NOT stretch to a third party: starts unrecorded, and says why", async () => {
      const res = await dial({ record: undefined });
      expect(res.call.recordingEnabled).toBe(false);
      expect(platform.log.created[0]?.recordVoice).toBe(false);
      expect(res.notices?.[0]).toMatch(/^Recording is OFF: .*ElevenLabs, a third party/);
    });

    it("consent.autoApproveThirdPartyDisclosures supplies the acknowledgement and silences the notice", async () => {
      service.shutdown();
      service = build(delegateConfig({ consent: { autoApproveThirdPartyDisclosures: true } }));
      const res = await dial({ record: true });
      expect(res.call.recordingEnabled).toBe(true);
      expect(res.notices).toBeUndefined();
      const preview = await place({ record: true, dryRun: true });
      if (!preview.dryRun) throw new Error("expected a plan");
      expect(preview.plan.notices).toEqual([]);
      expect(preview.plan.recordingHolder).toBe("ElevenLabs");
    });

    it("the recipient policies still decide first: 'never' and 'manual' refuse even when acknowledged", async () => {
      service.shutdown();
      service = build(delegateConfig({ consent: { autoApproveThirdPartyDisclosures: true } }));
      await expect(
        place({ to: "private", record: true, acknowledgeThirdPartyRecording: true }),
      ).rejects.toThrow(/'never'/);
      await expect(
        place({ to: "friend", record: true, acknowledgeThirdPartyRecording: true }),
      ).rejects.toThrow(/'manual'.*set_recording/);
      expect(platform.log.calls).toHaveLength(0);
    });

    it("on-device modes are untouched: direct records locally with no notice, acknowledgement or not", async () => {
      const res = await service.placeCall({
        to: "george",
        objective: "direct call",
        mode: "direct",
        record: true,
      });
      if (res.dryRun) throw new Error("expected a dial");
      expect(res.call.recordingEnabled).toBe(true);
      expect(res.notices).toBeUndefined();
      expect(telephony.log.calls[0]?.record).toBe(true);
    });
  });

  // ── INV-11 ────────────────────────────────────────────────────────────────

  it("LEAK SCAN — an ad-hoc number appears in zero bytes of sqlite, events or logs on a delegate call", async () => {
    const stderr: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const res = await dial({ to: ADHOC });
      expect(platform.log.calls[0]?.to).toBe(ADHOC);
      platform.script(convOf(res.call.id), {
        status: "done",
        transcript: [said("agent", "Hello."), said("user", "Hi.")],
        terminationReason: "remote party hung up",
      });
      await poller(res.call.id).pollOnce();
      const everything = JSON.stringify([
        store.getGlobalEvents(0),
        store.getCall(res.call.id),
        store.getAgentProfile("default"),
        platform.log.created,
      ]);
      expect(everything).not.toContain(ADHOC);
      expect(everything).not.toContain(TEST_PHONE_NUMBER_ID);
    } finally {
      process.stderr.write = orig;
    }
    store.close();
    new SqliteStore(dbFile).close(); // checkpoint the WAL so the scan sees every page
    for (const file of ["telephony-mcp.sqlite3", "telephony-mcp.sqlite3-wal"]) {
      let bytes: Buffer;
      try {
        bytes = readFileSync(join(dir, file));
      } catch {
        continue;
      }
      expect(bytes.includes(Buffer.from(ADHOC)), file).toBe(false);
      expect(bytes.includes(Buffer.from(ADHOC.slice(1))), file).toBe(false);
      expect(bytes.includes(Buffer.from(TEST_PHONE_NUMBER_ID)), file).toBe(false);
    }
    const logs = stderr.join("");
    expect(logs).not.toContain(ADHOC);
    expect(logs).not.toContain(TEST_PHONE_NUMBER_ID);
    store = new SqliteStore(dbFile);
  });

  it("the forbid switch really throws ForbiddenPlatformCall (guards the dryRun pin itself)", async () => {
    platform.forbidMutations = true;
    await expect(platform.createAgent({} as never)).rejects.toBeInstanceOf(ForbiddenPlatformCall);
  });
});
