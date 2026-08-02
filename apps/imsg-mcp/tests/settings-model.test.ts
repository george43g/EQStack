/**
 * Stage 6 — settings-panel model (pure view + edit logic) + a config-write
 * round-trip. No fs side effects except the round-trip, which uses a temp path
 * (never the real ~/.imsg-mcp/config.json).
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  AppConfigSchema,
  type InterpretConfigInput,
  InterpretConfigSchema,
  writeTuiConfig,
} from "../src/app-config.js";
import {
  applySettingsKey,
  buildSettingsRows,
  firstSelectableIndex,
  lastSelectableIndex,
  providerEnabled,
  type SettingsRow,
  stepSelectable,
} from "../src/tui/settings-model.js";

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

/** A non-default interpret block exercising every row kind. */
function sampleInterpret(): InterpretConfigInput {
  return InterpretConfigSchema.parse({
    auto: "free",
    inlineTranscripts: true,
    exportConfirmThreshold: 25,
    chains: {
      audio: ["apple", "local", "provider:openrouter"],
      image: ["provider:openrouter"],
      video: [],
    },
    providers: [
      { name: "openrouter", preset: "openrouter" },
      { name: "ollama", preset: "ollama" },
    ],
    nudge: { enabled: true, tier2SyncNow: false, timeoutSeconds: 30 },
  });
}

function rowOfKind(rows: SettingsRow[], kind: SettingsRow["kind"]): SettingsRow {
  const r = rows.find((x) => x.kind === kind);
  if (!r) throw new Error(`no row of kind ${kind}`);
  return r;
}

describe("buildSettingsRows", () => {
  it("emits General, Sync nudge, chain, and Providers sections", () => {
    const rows = buildSettingsRows(sampleInterpret(), { openrouter: true, ollama: false });
    const sections = [...new Set(rows.map((r) => r.section))];
    expect(sections).toEqual([
      "General",
      "Sync nudge",
      "Audio chain",
      "Image chain",
      "Video chain",
      "Providers",
    ]);
  });

  it("renders one selectable row per chain link and a placeholder for an empty chain", () => {
    const rows = buildSettingsRows(sampleInterpret(), {});
    const audio = rows.filter((r) => r.chain === "audio");
    expect(audio.map((r) => r.value)).toEqual(["#1", "#2", "#3"]);
    expect(audio.every((r) => r.selectable && r.kind === "chain")).toBe(true);
    const video = rows.filter((r) => r.section === "Video chain");
    expect(video).toHaveLength(1);
    expect(video[0].selectable).toBe(false);
    expect(video[0].label).toContain("empty");
  });

  it("shows provider key presence + chain membership, never the key itself", () => {
    const rows = buildSettingsRows(sampleInterpret(), { openrouter: true, ollama: false });
    const providers = rows.filter((r) => r.kind === "provider");
    expect(providers).toHaveLength(2);
    expect(providers.every((r) => r.selectable)).toBe(false); // read-only
    const or = providers.find((r) => r.label.startsWith("openrouter"));
    const ol = providers.find((r) => r.label.startsWith("ollama"));
    expect(or?.value).toContain("key set");
    expect(or?.value).toContain("in chain"); // referenced by provider:openrouter
    expect(ol?.value).toContain("no key");
    expect(ol?.value).toContain("unused"); // not referenced in any chain
    // No credential VALUE ever leaks into a row.
    expect(rows.some((r) => /sk-/.test(r.value))).toBe(false);
  });

  it("shows an empty-state note when no providers are configured", () => {
    const empty = InterpretConfigSchema.parse({});
    const rows = buildSettingsRows(empty, {});
    const note = rows.find((r) => r.section === "Providers");
    expect(note?.selectable).toBe(false);
    expect(note?.label).toContain("imsg setup");
  });
});

describe("providerEnabled", () => {
  it("is true only when provider:<name> appears in some chain", () => {
    const it0 = sampleInterpret();
    expect(providerEnabled(it0, "openrouter")).toBe(true);
    expect(providerEnabled(it0, "ollama")).toBe(false);
  });
});

describe("cursor navigation skips non-selectable rows", () => {
  it("first/last land on selectable rows; step hops over notes + providers", () => {
    const rows = buildSettingsRows(sampleInterpret(), {});
    const first = firstSelectableIndex(rows);
    const last = lastSelectableIndex(rows);
    expect(rows[first].selectable).toBe(true);
    expect(rows[last].selectable).toBe(true);
    // The last selectable row is the final image-chain link, not a provider row.
    expect(rows[last].kind).toBe("chain");
    // Stepping down from `last` stays put (only read-only rows remain below).
    expect(stepSelectable(rows, last, 1)).toBe(last);
    // Every step lands on a selectable row.
    let cur = first;
    for (let i = 0; i < rows.length + 2; i++) {
      cur = stepSelectable(rows, cur, 1);
      expect(rows[cur].selectable).toBe(true);
    }
  });
});

describe("applySettingsKey — edits", () => {
  it("cycles auto forward and backward (all · free · off)", () => {
    const it0 = sampleInterpret(); // auto: "free"
    const rows = buildSettingsRows(it0, {});
    const auto = rowOfKind(rows, "auto");
    expect(applySettingsKey(it0, auto, "right")?.auto).toBe("off");
    expect(applySettingsKey(it0, auto, "left")?.auto).toBe("all");
    expect(applySettingsKey(it0, auto, "toggle")?.auto).toBe("off");
  });

  it("toggles inline transcripts and nudge flags", () => {
    const it0 = sampleInterpret();
    const rows = buildSettingsRows(it0, {});
    expect(applySettingsKey(it0, rowOfKind(rows, "inline"), "toggle")?.inlineTranscripts).toBe(
      false,
    );
    expect(applySettingsKey(it0, rowOfKind(rows, "nudge"), "toggle")?.nudge.enabled).toBe(false);
    expect(applySettingsKey(it0, rowOfKind(rows, "nudge2"), "toggle")?.nudge.tier2SyncNow).toBe(
      true,
    );
  });

  it("adjusts the export threshold by ±5 and clamps at 0", () => {
    let it0 = sampleInterpret(); // 25
    const t = rowOfKind(buildSettingsRows(it0, {}), "threshold");
    expect(applySettingsKey(it0, t, "right")?.exportConfirmThreshold).toBe(30);
    expect(applySettingsKey(it0, t, "left")?.exportConfirmThreshold).toBe(20);
    // Walk down to 0 and confirm it never goes negative.
    it0 = { ...it0, exportConfirmThreshold: 3 };
    const t0 = rowOfKind(buildSettingsRows(it0, {}), "threshold");
    expect(applySettingsKey(it0, t0, "left")?.exportConfirmThreshold).toBe(0);
  });

  it("reorders a chain link and clamps at the ends", () => {
    const it0 = sampleInterpret(); // audio: apple, local, provider:openrouter
    const rows = buildSettingsRows(it0, {});
    const audio = rows.filter((r) => r.chain === "audio");
    // Move the middle link (local, index 1) up → swaps with apple.
    const up = applySettingsKey(it0, audio[1], "moveUp");
    expect(up?.chains.audio).toEqual(["local", "apple", "provider:openrouter"]);
    // Move the first link up → no-op (null).
    expect(applySettingsKey(it0, audio[0], "moveUp")).toBeNull();
    // Move the last link down → no-op (null).
    expect(applySettingsKey(it0, audio[2], "moveDown")).toBeNull();
    // Move the first link down → swaps with local.
    const down = applySettingsKey(it0, audio[0], "moveDown");
    expect(down?.chains.audio).toEqual(["local", "apple", "provider:openrouter"]);
  });

  it("treats read-only rows (providers, notes) as no-ops", () => {
    const it0 = sampleInterpret();
    const rows = buildSettingsRows(it0, {});
    const provider = rowOfKind(rows, "provider");
    for (const a of ["toggle", "left", "right", "moveUp", "moveDown"] as const) {
      expect(applySettingsKey(it0, provider, a)).toBeNull();
    }
    expect(applySettingsKey(it0, undefined, "toggle")).toBeNull();
  });

  it("never mutates the input block (edits return a new object)", () => {
    const it0 = sampleInterpret();
    const before = JSON.stringify(it0);
    const rows = buildSettingsRows(it0, {});
    applySettingsKey(it0, rowOfKind(rows, "inline"), "toggle");
    applySettingsKey(it0, rows.filter((r) => r.chain === "audio")[1], "moveUp");
    expect(JSON.stringify(it0)).toBe(before);
  });
});

describe("config-write round-trip (app-config)", () => {
  it("persists an edited interpret block and re-reads it validly", () => {
    const dir = mkdtempSync(join(tmpdir(), "imsg-settings-"));
    tempDirs.push(dir);
    const path = join(dir, "config.json");

    const it0 = sampleInterpret();
    const rows = buildSettingsRows(it0, {});
    // Simulate a user edit: disable inline transcripts + bump auto to "all".
    const edited = applySettingsKey(
      applySettingsKey(it0, rowOfKind(rows, "inline"), "toggle") as InterpretConfigInput,
      rowOfKind(rows, "auto"),
      "left",
    );
    expect(edited).not.toBeNull();

    const written = writeTuiConfig(
      { theme: "safe", accentColor: "#1982FC", interpret: edited as InterpretConfigInput },
      path,
    );
    expect(written).toBe(path);

    const reread = AppConfigSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    expect(reread.interpret?.inlineTranscripts).toBe(false);
    expect(reread.interpret?.auto).toBe("all");
    expect(reread.interpret?.chains.audio).toEqual(["apple", "local", "provider:openrouter"]);
  });
});
