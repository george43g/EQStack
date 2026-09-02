/**
 * Phase C must-pass table (PHASE-C-open-dialing.md § Verification): the
 * open-dialing, dedupe and INV-11 leak pins that the surface suites don't
 * cover. Service-level so the clock is controllable; no server, no network,
 * no paid calls (INV-14 — FakeTelephony records every dial).
 */
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CallService, CallServiceError } from "../src/gateway/call-service.js";
import { SqliteStore } from "../src/stores/sqlite-store.js";
import {
  FakeTelephony,
  FixedClock,
  MemoryRecordingStore,
  seqIds,
  tempStateDir,
  testConfig,
} from "./helpers.js";

const ADHOC = "+61400999888";

describe("open dialing + keyed dedupe (Phase C)", () => {
  let dir: string;
  let store: SqliteStore;
  let telephony: FakeTelephony;
  let clock: FixedClock;
  let service: CallService;

  beforeEach(() => {
    dir = tempStateDir();
    store = new SqliteStore(join(dir, "telephony-mcp.sqlite3"));
    telephony = new FakeTelephony();
    clock = new FixedClock();
    service = new CallService(
      testConfig(),
      store,
      telephony,
      new MemoryRecordingStore(),
      clock,
      seqIds(),
    );
  });
  afterEach(() => {
    service.shutdown();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function place(overrides: Record<string, unknown> = {}) {
    const res = await service.placeCall({
      to: ADHOC,
      objective: "say hello",
      ...overrides,
    } as Parameters<CallService["placeCall"]>[0]);
    return res;
  }

  it("1+2: an ad-hoc E.164 absent from config dials, manual policy, unrecorded", async () => {
    const res = await place();
    if (res.dryRun) throw new Error("expected a dial");
    expect(telephony.log.calls).toHaveLength(1);
    expect(telephony.log.calls[0]?.to).toBe(ADHOC); // full number reaches ONLY the adapter
    expect(telephony.log.calls[0]?.record).toBe(false);
    expect(res.call.recordingPolicy).toBe("manual");
    expect(res.call.recordingEnabled).toBe(false);
    expect(res.call.recipientAlias).toBe("adhoc-9888");
  });

  it("3: ad-hoc + record: true is a ConsentError and NO dial happens", async () => {
    await expect(place({ record: true })).rejects.toThrow(CallServiceError);
    await expect(place({ record: true })).rejects.toThrow(/manual/);
    expect(telephony.log.calls).toHaveLength(0);
  });

  it("6: dryRun creates no rows, no request, no dial; plan carries suffix only", async () => {
    const res = await place({ dryRun: true });
    if (!res.dryRun) throw new Error("expected a plan");
    expect(res.plan.numberSuffix).toBe("9888");
    expect(JSON.stringify(res.plan)).not.toContain(ADHOC);
    expect(telephony.log.calls).toHaveLength(0);
    expect(store.listCalls({ limit: 10 })).toHaveLength(0);
    expect(store.activeCallCount()).toBe(0);
    const raw = readFileSync(join(dir, "telephony-mcp.sqlite3"));
    expect(raw.includes(Buffer.from("9888"))).toBe(false); // not even a request row
  });

  it("8: a concurrent identical race still dials exactly once", async () => {
    const [a, b] = await Promise.all([place(), place()]);
    if (a.dryRun || b.dryRun) throw new Error("expected dials");
    expect(telephony.log.calls).toHaveLength(1);
    expect(a.call.id).toBe(b.call.id);
    expect([a.deduped, b.deduped].filter(Boolean)).toHaveLength(1);
  });

  it("9: same number, different objective → two dials (dedupe not over-broad)", async () => {
    const first = await place({ objective: "first thing" });
    if (first.dryRun) throw new Error("expected a dial");
    await service.endCall(first.call.id, "free the slot");
    await place({ objective: "second thing" });
    expect(telephony.log.calls).toHaveLength(2);
  });

  it("10: past the dedupe window an identical call dials again", async () => {
    const first = await place();
    if (first.dryRun) throw new Error("expected a dial");
    // End the call so concurrency (1) frees; dedupe alone decides the retry.
    await service.endCall(first.call.id, "test cleanup");
    const windowMs = testConfig().limits.callDedupeWindowSeconds * 1000;
    clock.advance(windowMs + 1000);
    const second = await place();
    if (second.dryRun) throw new Error("expected a dial");
    expect(second.deduped).toBe(false);
    expect(second.call.id).not.toBe(first.call.id);
    expect(telephony.log.calls).toHaveLength(2);
  });

  it("explicit idempotencyKey overrides derivation (host-restart retry safety)", async () => {
    const k = "host-retry-key-0001";
    const a = await place({ idempotencyKey: k });
    const b = await place({ idempotencyKey: k, objective: "different words, same key" });
    if (a.dryRun || b.dryRun) throw new Error("expected dials");
    expect(b.call.id).toBe(a.call.id);
    expect(telephony.log.calls).toHaveLength(1);
  });

  it("13: LEAK SCAN — the ad-hoc E.164 appears in zero bytes of sqlite, events, or logs", async () => {
    const stderrWrites: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrWrites.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const res = await place();
      if (res.dryRun) throw new Error("expected a dial");
      await service.endCall(res.call.id, "leak-scan cleanup");
      const events = store.getGlobalEvents(0);
      expect(events.length).toBeGreaterThan(0);
      expect(JSON.stringify(events)).not.toContain(ADHOC);
      expect(JSON.stringify(store.getCall(res.call.id))).not.toContain(ADHOC);
    } finally {
      process.stderr.write = orig;
    }
    // Checkpoint the WAL so the byte-scan sees every page, then scan the file.
    store.close();
    const reopened = new SqliteStore(join(dir, "telephony-mcp.sqlite3"));
    reopened.close();
    for (const file of ["telephony-mcp.sqlite3", "telephony-mcp.sqlite3-wal"]) {
      let bytes: Buffer;
      try {
        bytes = readFileSync(join(dir, file));
      } catch {
        continue; // sidecar may not exist post-checkpoint
      }
      expect(bytes.includes(Buffer.from(ADHOC)), file).toBe(false);
      expect(bytes.includes(Buffer.from(ADHOC.slice(1))), file).toBe(false); // digits sans '+'
    }
    expect(stderrWrites.join("")).not.toContain(ADHOC);
    // Re-open for afterEach close symmetry.
    store = new SqliteStore(join(dir, "telephony-mcp.sqlite3"));
  });
});
