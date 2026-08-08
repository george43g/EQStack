/**
 * Gateway integration — the simulated WebSocket call path: prepare → start →
 * relay setup → prompt → streamed tokens → interruption → transcript, plus
 * the public listener's rejection surface (signatures, unknown SIDs,
 * replays, out-of-order callbacks) and the no-autoplay invariants.
 * No network, no paid calls: fake telephony + scripted LLM.
 */
import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { computeTwilioSignature } from "../src/adapters/telephony/twilio-signature.js";
import { AdminClient } from "../src/client/admin-client.js";
import type { Config } from "../src/config/schema.js";
import { type Gateway, startGateway } from "../src/gateway/gateway.js";
import {
  FakeSecrets,
  FakeTelephony,
  fakeSecretValues,
  MemoryRecordingStore,
  ScriptedLlm,
  TEST_TWILIO_AUTH_TOKEN,
  tempStateDir,
  testConfig,
} from "./helpers.js";

const PUBLIC_PORT = 18790;
const ADMIN_PORT = 18791;
const PUBLIC_BASE = "https://gw.test.invalid";

let cfg: Config;
let gateway: Gateway;
let telephony: FakeTelephony;
let llm: ScriptedLlm;
let recordings: MemoryRecordingStore;
let admin: AdminClient;
let stateDir: string;

function signedForm(path: string, params: Record<string, string>): RequestInit {
  const body = new URLSearchParams(params).toString();
  return {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Twilio-Signature": computeTwilioSignature(
        TEST_TWILIO_AUTH_TOKEN,
        `${PUBLIC_BASE}${path}`,
        params,
      ),
    },
    body,
  };
}

function publicUrl(path: string): string {
  return `http://127.0.0.1:${PUBLIC_PORT}${path}`;
}

function openRelayWs(token: string): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${PUBLIC_PORT}/relay/${token}`, {
    headers: {
      "X-Twilio-Signature": computeTwilioSignature(
        TEST_TWILIO_AUTH_TOKEN,
        `wss://gw.test.invalid/relay/${token}`,
      ),
    },
  });
}

/** Collects outbound frames and waits for conditions. */
class FrameCollector {
  frames: Array<Record<string, unknown>> = [];
  constructor(ws: WebSocket) {
    ws.on("message", (data) =>
      this.frames.push(JSON.parse(String(data)) as Record<string, unknown>),
    );
  }
  async waitFor(
    pred: (frames: Array<Record<string, unknown>>) => boolean,
    timeoutMs = 3000,
  ): Promise<void> {
    const start = Date.now();
    while (!pred(this.frames)) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(`timed out waiting; frames so far: ${JSON.stringify(this.frames)}`);
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  assembledText(): string {
    return this.frames
      .filter((f) => f.type === "text")
      .map((f) => String(f.token ?? ""))
      .join("");
  }
}

function wsOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", reject);
  });
}

beforeAll(async () => {
  stateDir = tempStateDir();
  cfg = testConfig();
  telephony = new FakeTelephony();
  llm = new ScriptedLlm([]);
  recordings = new MemoryRecordingStore();
  gateway = await startGateway(cfg, {
    secrets: new FakeSecrets(fakeSecretValues()),
    telephony,
    llm,
    recordings,
  });
  admin = new AdminClient(ADMIN_PORT);
});

afterAll(async () => {
  await gateway.close();
  rmSync(stateDir, { recursive: true, force: true });
});

describe("public listener hardening", () => {
  it("exposes no admin routes publicly", async () => {
    for (const path of ["/calls", "/metrics", "/events", "/healthz"]) {
      const res = await fetch(publicUrl(path));
      expect(res.status, path).toBe(404);
    }
  });

  it("rejects unsigned and mis-signed callbacks", async () => {
    const unsigned = await fetch(publicUrl("/twilio/status"), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "CallSid=CA1&CallStatus=ringing",
    });
    expect(unsigned.status).toBe(403);
    const badSig = await fetch(publicUrl("/twilio/status"), {
      ...signedForm("/twilio/status", { CallSid: "CA1", CallStatus: "ringing" }),
      body: "CallSid=CA1&CallStatus=completed", // body no longer matches signature
    });
    expect(badSig.status).toBe(403);
  });

  it("rejects signed callbacks for unknown Call SIDs", async () => {
    const res = await fetch(
      publicUrl("/twilio/status"),
      signedForm("/twilio/status", { CallSid: "CAunknown", CallStatus: "ringing" }),
    );
    expect(res.status).toBe(404);
  });

  it("rejects WS upgrades without a valid signature or token", async () => {
    const noSig = new WebSocket(`ws://127.0.0.1:${PUBLIC_PORT}/relay/sometoken123`);
    await expect(wsOpen(noSig)).rejects.toThrow();
    const badToken = openRelayWs("notarealtoken000");
    await expect(wsOpen(badToken)).rejects.toThrow();
  });
});

describe("full simulated call", () => {
  let callId: string;
  let providerCallId: string;
  let relayToken: string;

  it("prepare → start dials via the adapter with redacted state", async () => {
    const { request } = await admin.prepare({
      recipient: "george",
      objective: "confirm dinner plans",
      context: "Friday 7pm, vegetarian",
    });
    expect(request.numberSuffix).toBe("1222");
    const { call } = await admin.start(request.id, true);
    callId = call.id;
    providerCallId = call.providerCallId as string;
    expect(providerCallId).toMatch(/^CAfake/);
    expect(telephony.log.calls).toHaveLength(1);
    const spec = telephony.log.calls[0];
    expect(spec?.to).toBe("+61400111222"); // full number reaches ONLY the adapter
    expect(spec?.record).toBe(true); // preconsented default
    expect(spec?.relayWsUrl).toMatch(/^wss:\/\/gw\.test\.invalid\/relay\/[A-Za-z0-9]+$/);
    relayToken = spec?.relayWsUrl.split("/relay/")[1] as string;

    // retry with the same request id → same call, no second dial
    const again = await admin.start(request.id, true);
    expect(again.call.id).toBe(callId);
    expect(telephony.log.calls).toHaveLength(1);
  });

  it("enforces the concurrency cap while a call is active", async () => {
    const { request } = await admin.prepare({ recipient: "friend", objective: "x" });
    await expect(admin.start(request.id, true)).rejects.toThrow(/concurrency/);
  });

  it("status callbacks advance the call; duplicates and out-of-order are dropped", async () => {
    for (const [status, seq] of [
      ["initiated", "0"],
      ["ringing", "1"],
      ["in-progress", "2"],
    ] as const) {
      const res = await fetch(
        publicUrl("/twilio/status"),
        signedForm("/twilio/status", {
          CallSid: providerCallId,
          CallStatus: status,
          SequenceNumber: seq,
        }),
      );
      expect(res.status).toBe(204);
    }
    expect((await admin.getCall(callId)).call.status).toBe("answered");

    // replay of ringing (same SequenceNumber) → dropped
    await fetch(
      publicUrl("/twilio/status"),
      signedForm("/twilio/status", {
        CallSid: providerCallId,
        CallStatus: "ringing",
        SequenceNumber: "1",
      }),
    );
    // late out-of-order ringing with a NEW sequence number → recorded but not applied
    await fetch(
      publicUrl("/twilio/status"),
      signedForm("/twilio/status", {
        CallSid: providerCallId,
        CallStatus: "ringing",
        SequenceNumber: "9",
      }),
    );
    const { call } = await admin.getCall(callId);
    expect(call.status).toBe("answered");
    const { events } = await admin.getEvents(callId);
    expect(events.filter((e) => e.type === "call.ringing")).toHaveLength(1);
    expect(events.some((e) => e.type === "callback.out_of_order")).toBe(true);
  });

  it("relay session: prompt streams LLM tokens to Twilio and finalizes the transcript", async () => {
    llm.turns = [
      { tokens: ["Hi ", "George", "!"] },
      { tokens: ["Second ", "turn ", "reply ", "with ", "many ", "tokens"], tokenDelayMs: 30 },
    ];
    const ws = openRelayWs(relayToken);
    const frames = new FrameCollector(ws);
    await wsOpen(ws);
    ws.send(JSON.stringify({ type: "setup", sessionId: "VX1", callSid: providerCallId }));
    ws.send(JSON.stringify({ type: "prompt", voicePrompt: "Hello, who is this?", last: true }));
    await frames.waitFor((f) => f.some((x) => x.type === "text" && x.last === true));
    expect(frames.assembledText()).toBe("Hi George!");

    // barge-in on the second, slower turn
    frames.frames = [];
    ws.send(JSON.stringify({ type: "prompt", voicePrompt: "And another thing", last: true }));
    await frames.waitFor((f) => f.some((x) => x.type === "text"));
    ws.send(
      JSON.stringify({
        type: "interrupt",
        utteranceUntilInterrupt: "Second turn",
        durationUntilInterruptMs: 500,
      }),
    );
    await new Promise((r) => setTimeout(r, 200));
    expect(llm.aborts).toBeGreaterThanOrEqual(1);

    const { transcript } = await admin.getTranscript(callId);
    const roles = transcript.map((u) => u.role);
    expect(roles).toContain("user");
    expect(roles).toContain("assistant");
    expect(transcript.find((u) => u.text === "Hi George!")).toBeTruthy();
    const interrupted = transcript.find((u) => u.interrupted);
    expect(interrupted?.text).toBe("Second turn"); // what was HEARD, not what was generated
    ws.close();
  });

  it("never plays the disclosure automatically; the explicit tool path speaks it", async () => {
    const { events } = await admin.getEvents(callId);
    expect(events.some((e) => e.type === "disclosure.played")).toBe(false);

    const ws = openRelayWs(relayToken);
    const frames = new FrameCollector(ws);
    await wsOpen(ws);
    ws.send(JSON.stringify({ type: "setup", sessionId: "VX2", callSid: providerCallId }));
    await new Promise((r) => setTimeout(r, 50));
    await admin.playDisclosure(callId);
    await frames.waitFor((f) => f.some((x) => x.type === "text"));
    expect(frames.assembledText()).toContain("recorded");
    const after = await admin.getEvents(callId);
    expect(after.events.some((e) => e.type === "disclosure.played")).toBe(true);
    ws.close();
  });

  it("recording callback downloads, encrypts, and indexes the recording", async () => {
    const res = await fetch(
      publicUrl("/twilio/recording"),
      signedForm("/twilio/recording", {
        CallSid: providerCallId,
        RecordingSid: "REfake0001",
        RecordingStatus: "completed",
        RecordingDuration: "42",
        RecordingChannels: "2",
      }),
    );
    expect(res.status).toBe(204);
    expect(recordings.hasLocal("REfake0001")).toBe(true);
    const { events } = await admin.getEvents(callId);
    expect(events.some((e) => e.type === "recording.stored")).toBe(true);
    // replayed recording callback is a no-op
    await fetch(
      publicUrl("/twilio/recording"),
      signedForm("/twilio/recording", {
        CallSid: providerCallId,
        RecordingSid: "REfake0001",
        RecordingStatus: "completed",
      }),
    );
    const after = await admin.getEvents(callId);
    expect(after.events.filter((e) => e.type === "recording.stored")).toHaveLength(1);
  });

  it("deleting a recording requires confirmation and honors scope", async () => {
    await expect(admin.deleteRecording("REfake0001", "both", false)).rejects.toThrow(
      /confirmation/,
    );
    const result = await admin.deleteRecording("REfake0001", "both", true);
    expect(result.deletedLocal).toBe(true);
    expect(result.deletedProvider).toBe(true);
    expect(telephony.log.deletedRecordings).toEqual(["REfake0001"]);
    expect(recordings.hasLocal("REfake0001")).toBe(false);
  });

  it("ends the call and events never leak the full number", async () => {
    await admin.endCall(callId, "test_done");
    const { call } = await admin.getCall(callId);
    expect(call.status).toBe("completed");
    expect(telephony.log.ended).toContain(providerCallId);
    const { events } = await admin.getEvents(callId);
    expect(JSON.stringify(events)).not.toContain("+61400111222");
    expect(JSON.stringify(call)).not.toContain("+61400111222");
  });

  it("frees the concurrency slot after the call ends", async () => {
    const { request } = await admin.prepare({ recipient: "friend", objective: "quick check-in" });
    const { call } = await admin.start(request.id, true);
    expect(call.recordingEnabled).toBe(false); // manual policy starts unrecorded
    await admin.endCall(call.id, "cleanup");
  });

  it("a failed dial marks the call failed and surfaces the error", async () => {
    telephony.failNextCreate = "ConversationRelay not enabled on this account";
    const { request } = await admin.prepare({ recipient: "george", objective: "x" });
    await expect(admin.start(request.id, true)).rejects.toThrow(/dial failed/);
    const calls = (await admin.listCalls({ limit: 5 })).calls;
    expect(
      calls.some((c) => c.status === "failed" && c.endReason?.includes("ConversationRelay")),
    ).toBe(true);
  });

  it("exposes metrics and SSE-pollable events on the admin listener only", async () => {
    const metrics = await fetch(`http://127.0.0.1:${ADMIN_PORT}/metrics`);
    const text = await metrics.text();
    expect(text).toContain("voice_calls_total");
    expect(text).toContain("voice_first_model_token_ms_bucket");
    const poll = await admin.pollGlobalEvents(0);
    expect(poll.events.length).toBeGreaterThan(5);
    // events are strictly ordered for cursor consumers
    const ids = poll.events.map((e) => e.id);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
  });
});

describe("direct mode: the MCP host is the conversational brain", () => {
  let callId: string;
  let providerCallId: string;
  let ws: WebSocket;
  let frames: FrameCollector;
  let llmCallsBefore: number;

  it("records the utterance, inlines its text in turn.user, and never calls the LLM", async () => {
    llmCallsBefore = llm.requests.length;
    const { request } = await admin.prepare({
      recipient: "george",
      objective: "talk to George directly",
      mode: "direct",
    });
    expect(request.mode).toBe("direct");
    const { call } = await admin.start(request.id, true);
    callId = call.id;
    providerCallId = call.providerCallId as string;
    const spec = telephony.log.calls[telephony.log.calls.length - 1];
    const relayToken = spec?.relayWsUrl.split("/relay/")[1] as string;

    ws = openRelayWs(relayToken);
    frames = new FrameCollector(ws);
    await wsOpen(ws);
    ws.send(JSON.stringify({ type: "setup", sessionId: "VXdirect", callSid: providerCallId }));
    ws.send(
      JSON.stringify({ type: "prompt", voicePrompt: "Hello Claude, can you hear me?", last: true }),
    );
    await new Promise((r) => setTimeout(r, 150));
    expect(llm.requests.length).toBe(llmCallsBefore); // the configured LLM is never invoked
    expect(frames.frames.filter((f) => f.type === "text")).toHaveLength(0); // nothing auto-spoken

    const { events } = await admin.getEvents(callId);
    const turnUser = events.find((e) => e.type === "turn.user");
    expect(turnUser?.data.text).toBe("Hello Claude, can you hear me?");
  });

  it("say speaks host text verbatim and lands in transcript + events", async () => {
    await admin.say(callId, "Hi George, this is the host speaking.");
    await frames.waitFor((f) => f.some((x) => x.type === "text" && x.last === true));
    expect(frames.assembledText()).toBe("Hi George, this is the host speaking.");
    const { transcript } = await admin.getTranscript(callId);
    expect(transcript.some((u) => u.role === "assistant" && u.text.includes("host speaking"))).toBe(
      true,
    );
    const { events } = await admin.getEvents(callId);
    expect(events.some((e) => e.type === "turn.assistant" && e.data.verbatim === true)).toBe(true);
  });

  it("long-poll waitMs resolves as soon as the next utterance arrives", async () => {
    const { events: before } = await admin.getEvents(callId);
    const cursor = before[before.length - 1]?.seq ?? 0;
    const t0 = Date.now();
    const pending = admin.getEvents(callId, cursor, 200, 5000);
    setTimeout(() => {
      ws.send(JSON.stringify({ type: "prompt", voicePrompt: "Second utterance", last: true }));
    }, 100);
    const { events } = await pending;
    expect(Date.now() - t0).toBeLessThan(3000); // returned on the event, not the timeout
    expect(events.some((e) => e.type === "turn.user" && e.data.text === "Second utterance")).toBe(
      true,
    );
    expect(llm.requests.length).toBe(llmCallsBefore);
  });

  it("say refuses once the session is gone", async () => {
    ws.close();
    await new Promise((r) => setTimeout(r, 100));
    await expect(admin.say(callId, "anyone there?")).rejects.toThrow(/no live session/);
    await admin.endCall(callId, "test_done");
  });
});
