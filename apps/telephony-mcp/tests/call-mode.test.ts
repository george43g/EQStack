/**
 * CallMode spec-table pins (Phase B step 8; verification items 7 and 8).
 *
 * Pins the D-34 taxonomy, the spec-table exhaustiveness, the "no string
 * branching on mode" rule in the session, normalization of legacy/unknown
 * values, and the unknown-mode degradation path through sqlite — so an older
 * binary reading a newer DB degrades to "byo-model" instead of type-lying.
 */
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CallModeInputSchema } from "../src/commands/contracts.js";
import {
  buildCallPlan,
  CallRequestError,
  CONSULT_HOST_NOTICE,
  createCallRequest,
} from "../src/domain/call-requests.js";
import { resolveRecipient } from "../src/domain/recipients.js";
import {
  CALL_MODE_SPECS,
  CALL_MODES,
  type CallModeSpec,
  normalizeCallMode,
} from "../src/domain/types.js";
import { SqliteStore } from "../src/stores/sqlite-store.js";
import {
  consultConfig,
  delegateConfig,
  FixedClock,
  seqIds,
  tempStateDir,
  testConfig,
} from "./helpers.js";

const SPEC_KEYS: ReadonlyArray<keyof CallModeSpec> = [
  "gatewayDrivesTurns",
  "hostAnswersTurns",
  "mediaPathOffDevice",
  "supportsConsult",
  "implemented",
];

describe("CALL_MODE_SPECS exhaustiveness (verification item 7)", () => {
  it("pins the D-34 taxonomy exactly", () => {
    expect([...CALL_MODES]).toEqual(["direct", "delegate", "consult", "byo-model"]);
  });

  it("every CALL_MODES member has a complete spec row", () => {
    // The Record<CallMode, CallModeSpec> type already makes a missing row a
    // compile error; this guards JS-level tampering and documents the intent.
    for (const mode of CALL_MODES) {
      const spec = CALL_MODE_SPECS[mode];
      expect(spec, `missing CALL_MODE_SPECS row for '${mode}'`).toBeDefined();
      for (const key of SPEC_KEYS) {
        expect(typeof spec[key], `${mode}.${key} must be a boolean`).toBe("boolean");
      }
    }
    // And no orphan rows for modes that are not in the vocabulary.
    expect(Object.keys(CALL_MODE_SPECS).sort()).toEqual([...CALL_MODES].sort());
  });
});

describe("no string branching on mode in the session (step 8 rule 1)", () => {
  it("session.ts branches on spec predicates, never on mode string equality", () => {
    const sessionPath = fileURLToPath(new URL("../src/gateway/session.ts", import.meta.url));
    const source = readFileSync(sessionPath, "utf8");
    expect(source).not.toContain('=== "direct"');
    expect(source).not.toContain('=== "llm"');
    // The predicate path must exist — the spec table is what replaced the ifs.
    expect(source).toContain("CALL_MODE_SPECS");
  });

  // Phase Q: the delegate path keys off `mediaPathOffDevice` (D-34) — the
  // mode's NAME appears nowhere in the code that routes it.
  it.each([
    "../src/gateway/call-service.ts",
    "../src/gateway/delegate-poller.ts",
    "../src/domain/call-requests.ts",
  ])("%s never names the 'delegate' mode as a string", (rel) => {
    const source = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
    expect(source).not.toMatch(/["'`]delegate["'`]/);
  });

  it("call-service.ts routes off-device calls by the mediaPathOffDevice predicate", () => {
    const path = fileURLToPath(new URL("../src/gateway/call-service.ts", import.meta.url));
    expect(readFileSync(path, "utf8")).toContain(".mediaPathOffDevice");
  });
});

describe("normalizeCallMode", () => {
  it("maps the legacy 'llm' alias to 'byo-model'", () => {
    expect(normalizeCallMode("llm")).toBe("byo-model");
  });

  it("maps each canonical member to itself", () => {
    for (const mode of CALL_MODES) {
      expect(normalizeCallMode(mode)).toBe(mode);
    }
  });

  it("degrades unknown and non-string values to 'byo-model'", () => {
    expect(normalizeCallMode("future-nonsense")).toBe("byo-model");
    expect(normalizeCallMode(undefined)).toBe("byo-model");
    expect(normalizeCallMode(null)).toBe("byo-model");
    expect(normalizeCallMode(42)).toBe("byo-model");
  });
});

describe("CallModeInputSchema", () => {
  it("parses the legacy 'llm' alias to 'byo-model'", () => {
    expect(CallModeInputSchema.parse("llm")).toBe("byo-model");
  });

  it("parses canonical members unchanged", () => {
    expect(CallModeInputSchema.parse("direct")).toBe("direct");
  });

  it("rejects values outside the vocabulary", () => {
    expect(CallModeInputSchema.safeParse("walkie-talkie").success).toBe(false);
  });
});

describe("unknown-mode degradation through sqlite (verification item 8)", () => {
  it("reads an unknown persisted mode back as 'byo-model' without throwing", () => {
    const dir = tempStateDir();
    const dbPath = join(dir, "test.sqlite3");
    try {
      const store = new SqliteStore(dbPath);
      const cfg0 = testConfig();
      const request = createCallRequest(
        buildCallPlan(cfg0, resolveRecipient(cfg0, "george"), {
          to: "george",
          objective: "pin unknown-mode degradation",
          mode: "direct",
        }),
        store,
        new FixedClock(),
        seqIds(),
      );
      expect(store.getCallRequest(request.id)?.mode).toBe("direct");
      store.close();

      // Simulate a newer binary having written a mode this one doesn't know.
      const raw = new DatabaseSync(dbPath);
      raw
        .prepare("UPDATE call_requests SET mode = ? WHERE id = ?")
        .run("some-future-mode", request.id);
      raw.close();

      const reopened = new SqliteStore(dbPath);
      const read = reopened.getCallRequest(request.id);
      expect(read).not.toBeNull();
      expect(read?.mode).toBe("byo-model");
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildCallPlan refuses unimplemented modes", () => {
  const cfg = testConfig();
  const clock = new FixedClock();

  function withStore(fn: (store: SqliteStore) => void): void {
    const dir = tempStateDir();
    const store = new SqliteStore(join(dir, "test.sqlite3"));
    try {
      fn(store);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("'consult' is implemented (Phase R) but refuses without its config blocks, naming each", () => {
    expect(CALL_MODE_SPECS.consult.implemented).toBe(true);
    const noPlatform = () =>
      buildCallPlan(cfg, resolveRecipient(cfg, "george"), {
        to: "george",
        objective: "x",
        mode: "consult",
      });
    expect(noPlatform).toThrow(CallRequestError);
    expect(noPlatform).toThrow(/'consult' needs the "agentPlatform" config block/);
    const dcfg = delegateConfig();
    const noConsult = () =>
      buildCallPlan(dcfg, resolveRecipient(dcfg, "george"), {
        to: "george",
        objective: "x",
        mode: "consult",
      });
    expect(noConsult).toThrow(CallRequestError);
    expect(noConsult).toThrow(/'consult' needs the "agentPlatform.consult" config block/);
  });

  it("'consult' plans once agentPlatform.consult is configured, with the host notice", () => {
    const ccfg = consultConfig();
    withStore((store) => {
      const plan = buildCallPlan(ccfg, resolveRecipient(ccfg, "george"), {
        to: "george",
        objective: "x",
        mode: "consult",
      });
      expect(plan.notices).toContain(CONSULT_HOST_NOTICE);
      const request = createCallRequest(plan, store, clock, seqIds());
      expect(request.mode).toBe("consult");
    });
  });

  it("'delegate' is implemented (Phase Q) but refuses without an agentPlatform block, naming it", () => {
    expect(CALL_MODE_SPECS.delegate.implemented).toBe(true);
    const attempt = () =>
      buildCallPlan(cfg, resolveRecipient(cfg, "george"), {
        to: "george",
        objective: "x",
        mode: "delegate",
      });
    expect(attempt).toThrow(CallRequestError);
    expect(attempt).toThrow(/'delegate' needs the "agentPlatform" config block/);
  });

  it("'delegate' plans once an agentPlatform is configured", () => {
    const dcfg = delegateConfig();
    withStore((store) => {
      const request = createCallRequest(
        buildCallPlan(dcfg, resolveRecipient(dcfg, "george"), {
          to: "george",
          objective: "x",
          mode: "delegate",
        }),
        store,
        clock,
        seqIds(),
      );
      expect(request.mode).toBe("delegate");
    });
  });

  it.each(["direct", "byo-model"] as const)("accepts implemented mode '%s'", (mode) => {
    withStore((store) => {
      const request = createCallRequest(
        buildCallPlan(cfg, resolveRecipient(cfg, "george"), { to: "george", objective: "x", mode }),
        store,
        clock,
        seqIds(),
      );
      expect(request.mode).toBe(mode);
    });
  });
});
