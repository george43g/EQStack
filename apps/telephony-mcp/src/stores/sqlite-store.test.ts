import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempStateDir } from "../../tests/helpers.js";
import type { CallRecord } from "../domain/types.js";
import { SqliteStore } from "./sqlite-store.js";

function call(id: string, overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    id,
    providerCallId: null,
    requestId: `req-${id}`,
    recipientAlias: "george",
    numberSuffix: "1222",
    profile: "default",
    objective: "book a dentist appointment",
    status: "created",
    recordingEnabled: false,
    recordingPolicy: "preconsented",
    maxDurationSec: 900,
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
    endedAtMs: null,
    endReason: null,
    ...overrides,
  };
}

describe("SqliteStore", () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = tempStateDir();
    store = new SqliteStore(join(dir, "t.sqlite3"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("stores and reads calls, including provider-id lookup", () => {
    store.createCall(call("c1"));
    store.setProviderCallId("c1", "CA1");
    expect(store.getCall("c1")?.id).toBe("c1");
    expect(store.getCallByProviderId("CA1")?.id).toBe("c1");
    expect(store.getCallByProviderId("CAnope")).toBeNull();
  });

  it("event sequences are per-call and the global id is a cross-call cursor", () => {
    store.createCall(call("c1"));
    store.createCall(call("c2"));
    const e1 = store.appendEvent("c1", "a", {});
    const e2 = store.appendEvent("c2", "b", {});
    const e3 = store.appendEvent("c1", "c", { n: 1 });
    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(1);
    expect(e3.seq).toBe(2);
    expect(store.getEvents("c1").map((e) => e.type)).toEqual(["a", "c"]);
    expect(store.getEvents("c1", 1).map((e) => e.type)).toEqual(["c"]);
    const global = store.getGlobalEvents(e1.id);
    expect(global.map((e) => e.type)).toEqual(["b", "c"]);
    expect(global[1]?.data).toEqual({ n: 1 });
  });

  it("deduplicates provider events (replay defense)", () => {
    store.createCall(call("c1"));
    expect(store.recordProviderEvent("c1", "status:ringing:1")).toBe(true);
    expect(store.recordProviderEvent("c1", "status:ringing:1")).toBe(false);
    expect(store.recordProviderEvent("c1", "status:ringing:2")).toBe(true);
  });

  it("paginates calls newest-first with beforeMs", () => {
    const t0 = 1_754_000_000_000;
    for (let i = 0; i < 5; i++) {
      store.createCall(call(`c${i}`, { createdAtMs: t0 + i * 1000 }));
    }
    const page1 = store.listCalls({ limit: 2 });
    expect(page1.map((c) => c.id)).toEqual(["c4", "c3"]);
    const page2 = store.listCalls({ limit: 2, beforeMs: page1[1]?.createdAtMs ?? 0 });
    expect(page2.map((c) => c.id)).toEqual(["c2", "c1"]);
  });

  it("counts only non-terminal calls as active", () => {
    store.createCall(call("c1", { status: "answered" }));
    store.createCall(call("c2", { status: "completed" }));
    store.createCall(call("c3", { status: "failed" }));
    expect(store.activeCallCount()).toBe(1);
  });

  it("FTS finds transcripts and call metadata", () => {
    store.createCall(call("c1", { objective: "negotiate the plumbing quote" }));
    store.addUtterance({
      callId: "c1",
      turn: 1,
      role: "user",
      text: "the quote for the bathroom was too high",
      tsMs: Date.now(),
      interrupted: false,
    });
    store.addUtterance({
      callId: "c1",
      turn: 1,
      role: "assistant",
      text: "I understand — let me see what we can do",
      tsMs: Date.now(),
      interrupted: false,
    });
    expect(store.searchTranscripts("bathroom")[0]?.text).toContain("bathroom");
    expect(store.searchTranscripts("nonexistentword")).toHaveLength(0);
    expect(store.searchCalls("plumbing")[0]?.id).toBe("c1");
  });

  it("keeps transcripts ordered with interruption flags", () => {
    store.createCall(call("c1"));
    store.addUtterance({
      callId: "c1",
      turn: 1,
      role: "user",
      text: "hi",
      tsMs: 1,
      interrupted: false,
    });
    store.addUtterance({
      callId: "c1",
      turn: 1,
      role: "assistant",
      text: "hello th",
      tsMs: 2,
      interrupted: true,
    });
    const t = store.getTranscript("c1");
    expect(t.map((u) => u.role)).toEqual(["user", "assistant"]);
    expect(t[1]?.interrupted).toBe(true);
  });

  it("recording metadata upserts and scoped deletion flags", () => {
    store.createCall(call("c1"));
    store.upsertRecording({
      providerRecordingId: "RE1",
      callId: "c1",
      durationSec: 12.5,
      channels: 2,
      encryptedPath: "/x/RE1.enc",
      sizeBytes: 1000,
      deletedLocal: false,
      deletedProvider: false,
      createdAtMs: Date.now(),
    });
    store.markRecordingDeleted("RE1", "local");
    const meta = store.getRecording("RE1");
    expect(meta?.deletedLocal).toBe(true);
    expect(meta?.deletedProvider).toBe(false);
    expect(meta?.encryptedPath).toBeNull(); // local deletion clears the path
    store.markRecordingDeleted("RE1", "provider");
    expect(store.getRecording("RE1")?.deletedProvider).toBe(true);
    expect(store.getRecordingsForCall("c1")).toHaveLength(1);
  });

  it("merges turn timings without losing earlier marks", () => {
    store.createCall(call("c1"));
    store.upsertTiming({
      callId: "c1",
      turn: 1,
      endOfTurnMs: 100,
      firstModelTokenMs: null,
      firstTokenToTwilioMs: null,
      interruptedAtMs: null,
    });
    store.upsertTiming({
      callId: "c1",
      turn: 1,
      endOfTurnMs: null,
      firstModelTokenMs: 400,
      firstTokenToTwilioMs: null,
      interruptedAtMs: null,
    });
    const t = store.getTimings("c1");
    expect(t[0]?.endOfTurnMs).toBe(100);
    expect(t[0]?.firstModelTokenMs).toBe(400);
  });

  it("relay tokens map both directions", () => {
    store.createCall(call("c1"));
    store.putRelayToken("tokabc", "c1");
    expect(store.getCallIdForRelayToken("tokabc")).toBe("c1");
    expect(store.getRelayTokenForCall("c1")).toBe("tokabc");
    expect(store.getCallIdForRelayToken("nope")).toBeNull();
  });
});
