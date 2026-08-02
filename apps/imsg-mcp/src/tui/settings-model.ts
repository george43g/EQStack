/**
 * Settings-panel model (Stage 6) — PURE, side-effect-free view + mutation logic
 * for the TUI settings mode. Frontends stay render-only: this module turns the
 * persisted `interpret` block into a flat list of navigable rows and applies
 * edits, returning a NEW block the caller persists via `app-config`.
 *
 * The panel is deliberately read-heavy: it shows provider key *presence* (a
 * check), never the key value. Editing keys stays in the wizard/file to avoid
 * TUI secret handling.
 *
 * `loadSettingsState` is the one fs-reading glue (config + credentials); the
 * rest is pure and unit-tested directly.
 */
import type { Dispatch } from "react";
import {
  defaultTuiConfigPath,
  type InterpretConfigInput,
  InterpretConfigSchema,
  loadTuiConfig,
  readCredentials,
} from "../app-config.js";
import type { Action } from "./types.js";

/** One navigable (or informational) line in the settings panel. */
export interface SettingsRow {
  /** Section this row belongs to; the renderer prints a header when it changes. */
  section: string;
  /** Selectable rows accept edits; `note`/provider rows are display-only. */
  selectable: boolean;
  kind: "auto" | "inline" | "threshold" | "nudge" | "nudge2" | "chain" | "provider" | "note";
  label: string;
  /** Right-hand rendered value/state (e.g. "on", "free", "#1", "key set"). */
  value: string;
  /** Contextual key hint shown when this row is selected. */
  hint?: string;
  // Chain-row specifics — which chain + position, so a reorder knows its target.
  chain?: "audio" | "image" | "video";
  index?: number;
  total?: number;
}

/** The key actions the panel maps onto the selected row. */
export type SettingsKeyAction = "toggle" | "left" | "right" | "moveUp" | "moveDown";

const AUTO_ORDER = ["all", "free", "off"] as const;
const THRESHOLD_STEP = 5;

function cap(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

/** Human label for one chain link ("apple" / "local" / "provider:openrouter"). */
export function linkLabel(link: string): string {
  if (link === "apple") return "Apple transcript (instant, free)";
  if (link === "local") return "Local tools (hear/yap/whisper)";
  if (link.startsWith("provider:")) return `Provider: ${link.slice("provider:".length)}`;
  return link;
}

/** A provider is "enabled" when it's referenced by `provider:<name>` in a chain. */
export function providerEnabled(interpret: InterpretConfigInput, name: string): boolean {
  const tag = `provider:${name}`;
  return (
    interpret.chains.audio.includes(tag) ||
    interpret.chains.image.includes(tag) ||
    interpret.chains.video.includes(tag)
  );
}

function chainRows(
  interpret: InterpretConfigInput,
  chain: "audio" | "image" | "video",
): SettingsRow[] {
  const items = interpret.chains[chain];
  const section = `${cap(chain)} chain`;
  if (items.length === 0) {
    return [{ section, selectable: false, kind: "note", label: "(empty — no links)", value: "" }];
  }
  return items.map((item, i) => ({
    section,
    selectable: true,
    kind: "chain",
    chain,
    index: i,
    total: items.length,
    label: linkLabel(item),
    value: `#${i + 1}`,
    hint: "K/J reorder",
  }));
}

/**
 * Flatten the `interpret` block + provider key presence into the ordered row
 * list the panel renders and navigates. Pure.
 */
export function buildSettingsRows(
  interpret: InterpretConfigInput,
  keyPresence: Record<string, boolean>,
): SettingsRow[] {
  const rows: SettingsRow[] = [];

  // ── General ──────────────────────────────────────────────────────────
  rows.push({
    section: "General",
    selectable: true,
    kind: "auto",
    label: "Auto interpretation",
    value: interpret.auto,
    hint: "␣/←→ cycle (all · free · off)",
  });
  rows.push({
    section: "General",
    selectable: true,
    kind: "inline",
    label: "Inline transcripts in reads",
    value: interpret.inlineTranscripts ? "on" : "off",
    hint: "␣ toggle",
  });
  rows.push({
    section: "General",
    selectable: true,
    kind: "threshold",
    label: "Export cloud-confirm threshold",
    value: String(interpret.exportConfirmThreshold),
    hint: "←/→ ±5",
  });

  // ── Sync nudge ───────────────────────────────────────────────────────
  rows.push({
    section: "Sync nudge",
    selectable: true,
    kind: "nudge",
    label: "Attachment sync nudge",
    value: interpret.nudge.enabled ? "on" : "off",
    hint: "␣ toggle",
  });
  rows.push({
    section: "Sync nudge",
    selectable: true,
    kind: "nudge2",
    label: "Tier-2 'Sync Now' (Accessibility)",
    value: interpret.nudge.tier2SyncNow ? "on" : "off",
    hint: "␣ toggle",
  });

  // ── Chains ───────────────────────────────────────────────────────────
  rows.push(...chainRows(interpret, "audio"));
  rows.push(...chainRows(interpret, "image"));
  rows.push(...chainRows(interpret, "video"));

  // ── Providers (read-only; key presence only, never the value) ────────
  if (interpret.providers.length === 0) {
    rows.push({
      section: "Providers",
      selectable: false,
      kind: "note",
      label: "None configured — run `imsg setup`",
      value: "",
    });
  } else {
    for (const p of interpret.providers) {
      const target = p.preset ?? p.baseUrl ?? "custom";
      const enabled = providerEnabled(interpret, p.name);
      const hasKey = Boolean(keyPresence[p.name]);
      rows.push({
        section: "Providers",
        selectable: false,
        kind: "provider",
        label: `${p.name} (${target})`,
        value: `${enabled ? "in chain" : "unused"} · ${hasKey ? "key set" : "no key"}`,
      });
    }
  }

  return rows;
}

// ── Cursor navigation over selectable rows ─────────────────────────────────

export function firstSelectableIndex(rows: SettingsRow[]): number {
  const i = rows.findIndex((r) => r.selectable);
  return i < 0 ? 0 : i;
}

export function lastSelectableIndex(rows: SettingsRow[]): number {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].selectable) return i;
  }
  return 0;
}

/** Move the cursor `dir` (±1) to the next selectable row; stay put if none. */
export function stepSelectable(rows: SettingsRow[], from: number, dir: 1 | -1): number {
  let j = from + dir;
  while (j >= 0 && j < rows.length && !rows[j].selectable) j += dir;
  if (j < 0 || j >= rows.length) return from;
  return j;
}

// ── Edits (pure — return a NEW block, or null when the key is a no-op) ──────

function cycleAuto(cur: InterpretConfigInput["auto"], dir: 1 | -1): InterpretConfigInput["auto"] {
  const idx = AUTO_ORDER.indexOf(cur);
  const at = idx < 0 ? 0 : idx;
  return AUTO_ORDER[(at + dir + AUTO_ORDER.length) % AUTO_ORDER.length];
}

function moveChain(
  interpret: InterpretConfigInput,
  chain: "audio" | "image" | "video",
  index: number,
  dir: 1 | -1,
): InterpretConfigInput | null {
  const arr = [...interpret.chains[chain]];
  const j = index + dir;
  if (j < 0 || j >= arr.length) return null;
  const tmp = arr[index];
  arr[index] = arr[j];
  arr[j] = tmp;
  return { ...interpret, chains: { ...interpret.chains, [chain]: arr } };
}

/**
 * Apply one key action to the selected row. Returns the mutated block to
 * persist, or `null` when the action is a no-op for that row (read-only row,
 * reorder past an end, etc.). Pure.
 */
export function applySettingsKey(
  interpret: InterpretConfigInput,
  row: SettingsRow | undefined,
  action: SettingsKeyAction,
): InterpretConfigInput | null {
  if (!row || !row.selectable) return null;

  switch (row.kind) {
    case "auto": {
      if (action === "left") return { ...interpret, auto: cycleAuto(interpret.auto, -1) };
      if (action === "right" || action === "toggle")
        return { ...interpret, auto: cycleAuto(interpret.auto, 1) };
      return null;
    }
    case "inline": {
      if (action === "toggle")
        return { ...interpret, inlineTranscripts: !interpret.inlineTranscripts };
      if (action === "left") return { ...interpret, inlineTranscripts: false };
      if (action === "right") return { ...interpret, inlineTranscripts: true };
      return null;
    }
    case "threshold": {
      if (action === "left")
        return {
          ...interpret,
          exportConfirmThreshold: Math.max(0, interpret.exportConfirmThreshold - THRESHOLD_STEP),
        };
      if (action === "right")
        return {
          ...interpret,
          exportConfirmThreshold: interpret.exportConfirmThreshold + THRESHOLD_STEP,
        };
      return null;
    }
    case "nudge": {
      if (action === "toggle")
        return { ...interpret, nudge: { ...interpret.nudge, enabled: !interpret.nudge.enabled } };
      if (action === "left") return { ...interpret, nudge: { ...interpret.nudge, enabled: false } };
      if (action === "right") return { ...interpret, nudge: { ...interpret.nudge, enabled: true } };
      return null;
    }
    case "nudge2": {
      if (action === "toggle")
        return {
          ...interpret,
          nudge: { ...interpret.nudge, tier2SyncNow: !interpret.nudge.tier2SyncNow },
        };
      if (action === "left")
        return { ...interpret, nudge: { ...interpret.nudge, tier2SyncNow: false } };
      if (action === "right")
        return { ...interpret, nudge: { ...interpret.nudge, tier2SyncNow: true } };
      return null;
    }
    case "chain": {
      if (row.chain == null || row.index == null) return null;
      if (action === "moveUp") return moveChain(interpret, row.chain, row.index, -1);
      if (action === "moveDown") return moveChain(interpret, row.chain, row.index, 1);
      return null;
    }
    default:
      return null;
  }
}

// ── Open glue (fs reads: config + credentials → OPEN_SETTINGS payload) ──────

export interface OpenSettingsPayload {
  interpret: InterpretConfigInput;
  /** provider name → whether a credential is present (never the key itself). */
  keyPresence: Record<string, boolean>;
  /** File the panel writes back to (existing config, or the default path). */
  configPath: string;
  warnings: string[];
}

/** Read the current config + credential presence into an OPEN_SETTINGS payload. */
export function loadSettingsState(): OpenSettingsPayload {
  const loaded = loadTuiConfig();
  const interpret = InterpretConfigSchema.parse(loaded.config.interpret ?? {});
  const creds = readCredentials();
  const keyPresence: Record<string, boolean> = {};
  for (const p of interpret.providers) keyPresence[p.name] = Boolean(creds[p.name]);
  return {
    interpret,
    keyPresence,
    configPath: loaded.source ?? defaultTuiConfigPath(),
    warnings: loaded.warnings,
  };
}

/** Dispatch OPEN_SETTINGS after loading config — shared by the `,` key + palette. */
export function openSettings(dispatch: Dispatch<Action>): void {
  dispatch({ type: "OPEN_SETTINGS", ...loadSettingsState() });
}
