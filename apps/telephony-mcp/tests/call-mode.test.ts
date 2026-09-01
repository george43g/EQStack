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
import { CallRequestError, prepareCallRequest } from "../src/domain/call-requests.js";
import {
  CALL_MODE_SPECS,
  CALL_MODES,
  type CallModeSpec,
  normalizeCallMode,
} from "../src/domain/types.js";
import { SqliteStore } from "../src/stores/sqlite-store.js";
import { FixedClock, seqIds, tempStateDir, testConfig } from "./helpers.js";

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
      const request = prepareCallRequest(testConfig(), store, new FixedClock(), seqIds(), {
        recipient: "george",
        objective: "pin unknown-mode degradation",
        mode: "direct",
      });
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

describe("prepareCallRequest refuses unimplemented modes", () => {
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

  it.each(["delegate", "consult"] as const)("refuses '%s' until its phase ships", (mode) => {
    withStore((store) => {
      const attempt = () =>
        prepareCallRequest(cfg, store, clock, seqIds(), {
          recipient: "george",
          objective: "x",
          mode,
        });
      expect(attempt).toThrow(CallRequestError);
      expect(attempt).toThrow(/not implemented/);
    });
  });

  it.each(["direct", "byo-model"] as const)("accepts implemented mode '%s'", (mode) => {
    withStore((store) => {
      const request = prepareCallRequest(cfg, store, clock, seqIds(), {
        recipient: "george",
        objective: "x",
        mode,
      });
      expect(request.mode).toBe(mode);
    });
  });
});
