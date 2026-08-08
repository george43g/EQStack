import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixedClock, seqIds, tempStateDir, testConfig } from "../../tests/helpers.js";
import { SqliteStore } from "../stores/sqlite-store.js";
import { CallRequestError, prepareCallRequest, resolveStartableRequest } from "./call-requests.js";
import { ConsentError } from "./consent.js";

describe("two-stage call request flow", () => {
  let dir: string;
  let store: SqliteStore;
  const cfg = testConfig();
  const clock = new FixedClock();

  beforeEach(() => {
    dir = tempStateDir();
    store = new SqliteStore(join(dir, "test.sqlite3"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("prepare resolves the alias and exposes only the number suffix", () => {
    const request = prepareCallRequest(cfg, store, clock, seqIds(), {
      recipient: "george",
      objective: "book a table for two",
    });
    expect(request.numberSuffix).toBe("1222");
    expect(JSON.stringify(request)).not.toContain("+61400111222");
    expect(request.recordingEnabled).toBe(true); // preconsented default
    expect(request.expiresAtMs).toBe(clock.nowMs() + 10 * 60_000);
    expect(request.maxDurationSec).toBe(15 * 60);
    expect(store.getCallRequest(request.id)).not.toBeNull();
  });

  it("rejects recipients that are not allowlisted", () => {
    expect(() =>
      prepareCallRequest(cfg, store, clock, seqIds(), {
        recipient: "stranger",
        objective: "x",
      }),
    ).toThrow(CallRequestError);
  });

  it("applies consent rules at prepare time", () => {
    const manual = prepareCallRequest(cfg, store, clock, seqIds("m"), {
      recipient: "friend",
      objective: "catch up",
    });
    expect(manual.recordingEnabled).toBe(false);
    expect(() =>
      prepareCallRequest(cfg, store, clock, seqIds("n"), {
        recipient: "private",
        objective: "x",
        record: true,
      }),
    ).toThrow(ConsentError);
    expect(() =>
      prepareCallRequest(cfg, store, clock, seqIds("o"), {
        recipient: "private",
        objective: "x",
        record: true,
      }),
    ).toThrow(/never/);
  });

  it("requires explicit confirmation to start", () => {
    const request = prepareCallRequest(cfg, store, clock, seqIds(), {
      recipient: "george",
      objective: "x",
    });
    expect(() => resolveStartableRequest(store, clock, request.id, false)).toThrow(/confirmation/);
    expect(resolveStartableRequest(store, clock, request.id, true).id).toBe(request.id);
  });

  it("expires unstarted requests after the TTL", () => {
    const request = prepareCallRequest(cfg, store, clock, seqIds(), {
      recipient: "george",
      objective: "x",
    });
    const late = new FixedClock(clock.nowMs() + 11 * 60_000);
    expect(() => resolveStartableRequest(store, late, request.id, true)).toThrow(/expired/);
  });

  it("started requests never expire — retries must find the existing call", () => {
    const request = prepareCallRequest(cfg, store, clock, seqIds(), {
      recipient: "george",
      objective: "x",
    });
    store.markRequestStarted(request.id, "call-1");
    const late = new FixedClock(clock.nowMs() + 60 * 60_000);
    const resolved = resolveStartableRequest(store, late, request.id, true);
    expect(resolved.startedCallId).toBe("call-1");
  });

  it("rejects unknown request ids", () => {
    expect(() => resolveStartableRequest(store, clock, "nope", true)).toThrow(/unknown/);
  });
});
