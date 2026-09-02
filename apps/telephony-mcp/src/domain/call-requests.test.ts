import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixedClock, seqIds, tempStateDir, testConfig } from "../../tests/helpers.js";
import { SqliteStore } from "../stores/sqlite-store.js";
import {
  buildCallPlan,
  CallRequestError,
  createCallRequest,
  type PlaceCallInput,
} from "./call-requests.js";
import { ConsentError } from "./consent.js";
import { resolveRecipient } from "./recipients.js";

describe("one-shot call planning (Phase C)", () => {
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

  function plan(input: PlaceCallInput) {
    return buildCallPlan(cfg, resolveRecipient(cfg, input.to), input);
  }

  it("resolves a config alias and exposes only the number suffix", () => {
    const p = plan({ to: "george", objective: "book a table for two" });
    expect(p.recipientAlias).toBe("george");
    expect(p.numberSuffix).toBe("1222");
    expect(p.source).toBe("config");
    expect(JSON.stringify(p)).not.toContain("+61400111222");
  });

  it("resolves a raw E.164 absent from config as an ad-hoc recipient (INV-2, D-4)", () => {
    const p = plan({ to: "+61400999888", objective: "ad-hoc hello" });
    expect(p.recipientAlias).toBe("adhoc-9888");
    expect(p.source).toBe("adhoc");
    expect(p.recordingPolicy).toBe("manual");
    expect(p.recordingEnabled).toBe(false); // connects, starts unrecorded
    expect(JSON.stringify(p)).not.toContain("+61400999888");
  });

  it("a name that is neither alias nor E.164 is a parse error, not a permission gate", () => {
    const attempt = () => resolveRecipient(cfg, "mum");
    expect(attempt).toThrow(CallRequestError);
    expect(attempt).toThrow(/neither a configured alias nor E\.164/);
  });

  it("ad-hoc + record: true is a ConsentError (manual policy — INV-3 unchanged)", () => {
    expect(() => plan({ to: "+61400999888", objective: "x", record: true })).toThrow(ConsentError);
  });

  it("'never' recipients still cannot be recorded", () => {
    expect(() => plan({ to: "private", objective: "x", record: true })).toThrow(ConsentError);
  });

  it("createCallRequest persists the plan without a TTL and stays readable", () => {
    const p = plan({ to: "george", objective: "persist me", mode: "direct" });
    const request = createCallRequest(p, store, clock, seqIds());
    const read = store.getCallRequest(request.id);
    expect(read?.mode).toBe("direct");
    expect(read?.objective).toBe("persist me");
    expect("expiresAtMs" in (read as object)).toBe(false);
    expect(read?.startedCallId).toBeNull();
  });
});
