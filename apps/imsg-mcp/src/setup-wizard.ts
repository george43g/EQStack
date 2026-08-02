/**
 * Interactive `imsg setup --interactive` wizard for media interpretation.
 *
 * The interactive prompt loop is a THIN shell over pure functions
 * (`chainRecipes`, `buildProviderConfig`, `suggestChains`,
 * `validateInterpretConfig`, `applyWizardResult`) so all the real logic is
 * unit-tested without a TTY. `@inquirer/prompts` is dynamically imported only in
 * `runSetupWizard`, so importing this module never pulls in the prompt UI.
 */

import { execFileSync } from "node:child_process";
import type { AppConfig, InterpretConfigInput, ResolvedInterpretConfig } from "./app-config.js";
import { loadTuiConfig, readCredentials, setCredential, writeTuiConfig } from "./app-config.js";
import type { AutoMode, InterpretChains } from "./media-intel.js";
import {
  PROVIDER_PRESETS,
  type ProviderCapabilities,
  type ProviderConfig,
  type ProviderPreset,
} from "./media-providers.js";
import { probeMachine } from "./setup.js";

export const PROVIDER_PRESET_NAMES = Object.keys(PROVIDER_PRESETS) as ProviderPreset[];

// ── Local-tool probing (doctor step) ───────────────────────────────────────

export interface LocalTools {
  yap: boolean;
  hear: boolean;
  whisperCli: boolean;
  ffmpeg: boolean;
  mpv: boolean;
}

function onPath(tool: string): boolean {
  try {
    execFileSync("which", [tool], { stdio: "ignore", timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
}

export function probeLocalTools(): LocalTools {
  return {
    yap: onPath("yap"),
    hear: onPath("hear"),
    whisperCli: onPath("whisper-cli"),
    ffmpeg: onPath("ffmpeg"),
    mpv: onPath("mpv"),
  };
}

/** `brew install` one-liner for a supported optional tool, or null. */
export function brewHintFor(tool: keyof LocalTools): string | null {
  switch (tool) {
    case "yap":
      return "brew install yap";
    case "hear":
      return "brew install sveinbjornt/hear/hear";
    case "whisperCli":
      return "brew install whisper-cpp";
    case "ffmpeg":
      return "brew install ffmpeg";
    case "mpv":
      return "brew install mpv";
  }
}

/** Human-readable doctor lines (pure) for a probed machine + tool set. */
export function buildDoctorLines(
  fda: boolean,
  tools: LocalTools,
): Array<{ ok: boolean; text: string; hint?: string }> {
  const out: Array<{ ok: boolean; text: string; hint?: string }> = [];
  out.push({
    ok: fda,
    text: fda
      ? "Full Disk Access — chat.db is readable"
      : "Full Disk Access missing — grant it in System Settings → Privacy & Security → Full Disk Access",
  });
  const anyTranscriber = tools.yap || tools.hear || tools.whisperCli;
  out.push({
    ok: anyTranscriber,
    text: anyTranscriber
      ? `On-device transcriber found (${[tools.yap && "yap", tools.whisperCli && "whisper-cli", tools.hear && "hear"].filter(Boolean).join(", ")})`
      : "No on-device transcriber found — voice notes need one (or a cloud provider)",
    hint: anyTranscriber ? undefined : (brewHintFor("yap") ?? undefined),
  });
  if (!tools.ffmpeg) {
    out.push({
      ok: true,
      text: "ffmpeg not found — optional (sparse video frames); poster-frame still works",
      hint: brewHintFor("ffmpeg") ?? undefined,
    });
  }
  if (!tools.mpv) {
    out.push({
      ok: true,
      text: "mpv not found — optional (TUI video playback)",
      hint: brewHintFor("mpv") ?? undefined,
    });
  }
  return out;
}

// ── Provider capabilities ──────────────────────────────────────────────────

const CUSTOM_CAPS: ProviderCapabilities = { transcribe: true, vision: true, audioChat: true };

/** Capabilities for a configured provider (preset table, or all-true for custom URLs). */
export function providerCapabilities(p: Pick<ProviderConfig, "preset">): ProviderCapabilities {
  return p.preset ? PROVIDER_PRESETS[p.preset].capabilities : CUSTOM_CAPS;
}

function canDoAudio(caps: ProviderCapabilities): boolean {
  return caps.transcribe || caps.audioChat;
}

// ── Provider config assembly (pure) ────────────────────────────────────────

export interface WizardProviderAnswer {
  name: string;
  preset?: ProviderPreset;
  baseUrl?: string;
  accountId?: string;
  /** Entered key — routed to credentials.json, never into config.json. */
  apiKey?: string;
  models?: { transcribe?: string; vision?: string };
}

/** Strip the transient apiKey to produce the config-stored ProviderConfig. Throws on misconfig. */
export function buildProviderConfig(a: WizardProviderAnswer): ProviderConfig {
  if (!a.name.trim()) throw new Error("provider name is required");
  if (!a.preset && !a.baseUrl) throw new Error("provider needs a preset or a custom baseUrl");
  if (a.preset && PROVIDER_PRESETS[a.preset].needsAccountId && !a.accountId) {
    throw new Error(`provider "${a.name}" (${a.preset}) needs an accountId`);
  }
  const cfg: ProviderConfig = { name: a.name.trim() };
  if (a.preset) cfg.preset = a.preset;
  if (a.baseUrl) cfg.baseUrl = a.baseUrl;
  if (a.accountId) cfg.accountId = a.accountId;
  const models: { transcribe?: string; vision?: string } = {};
  if (a.models?.transcribe) models.transcribe = a.models.transcribe;
  if (a.models?.vision) models.vision = a.models.vision;
  if (models.transcribe || models.vision) cfg.models = models;
  return cfg;
}

// ── Chain recipes (pure) — the "ordered select" options per media type ─────

export interface ChainRecipe {
  label: string;
  chain: string[];
}

export function chainRecipes(
  kind: "audio" | "image" | "video",
  providers: ProviderConfig[],
): ChainRecipe[] {
  if (kind === "audio") {
    const recipes: ChainRecipe[] = [
      { label: "Free only — Apple transcript, then on-device", chain: ["apple", "local"] },
    ];
    for (const p of providers) {
      if (!canDoAudio(providerCapabilities(p))) continue;
      recipes.push({
        label: `Free first, then ${p.name} (cloud)`,
        chain: ["apple", "local", `provider:${p.name}`],
      });
      recipes.push({ label: `${p.name} only (cloud)`, chain: [`provider:${p.name}`] });
    }
    recipes.push({ label: "Off — no audio interpretation", chain: [] });
    return recipes;
  }
  // image / video
  const recipes: ChainRecipe[] = [{ label: "Off — no interpretation", chain: [] }];
  for (const p of providers) {
    if (!providerCapabilities(p).vision) continue;
    recipes.push({ label: `${p.name} (cloud)`, chain: [`provider:${p.name}`] });
  }
  return recipes;
}

/** A free-first chain suggestion given the configured providers (pure). */
export function suggestChains(providers: ProviderConfig[]): InterpretChains {
  const audioProvider = providers.find((p) => canDoAudio(providerCapabilities(p)));
  const visionProvider = providers.find((p) => providerCapabilities(p).vision);
  return {
    audio: audioProvider
      ? ["apple", "local", `provider:${audioProvider.name}`]
      : ["apple", "local"],
    image: visionProvider ? [`provider:${visionProvider.name}`] : [],
    video: visionProvider ? [`provider:${visionProvider.name}`] : [],
  };
}

// ── Config validation (pure) ───────────────────────────────────────────────

/** Warnings for chains that reference unknown providers or missing capabilities. */
export function validateInterpretConfig(block: {
  chains: InterpretChains;
  providers: ProviderConfig[];
}): string[] {
  const warnings: string[] = [];
  const byName = new Map(block.providers.map((p) => [p.name, p]));
  const checkLink = (link: string, kind: "audio" | "image" | "video") => {
    if (!link.startsWith("provider:")) return;
    const name = link.slice("provider:".length);
    const p = byName.get(name);
    if (!p) {
      warnings.push(`${kind} chain references unknown provider "${name}"`);
      return;
    }
    const caps = providerCapabilities(p);
    if (kind === "audio" && !canDoAudio(caps)) {
      warnings.push(`provider "${name}" can't handle audio (no transcribe/audioChat)`);
    }
    if ((kind === "image" || kind === "video") && !caps.vision) {
      warnings.push(`provider "${name}" has no vision capability for ${kind}`);
    }
  };
  for (const l of block.chains.audio) checkLink(l, "audio");
  for (const l of block.chains.image) checkLink(l, "image");
  for (const l of block.chains.video) checkLink(l, "video");
  return warnings;
}

// ── Wizard result → written artifacts (pure) ───────────────────────────────

export interface WizardResult {
  providers: WizardProviderAnswer[];
  chains: InterpretChains;
  auto: AutoMode;
  inlineTranscripts: boolean;
  exportConfirmThreshold: number;
  nudge: { enabled: boolean; tier2SyncNow: boolean; timeoutSeconds: number };
}

/**
 * Turn collected wizard answers into the artifacts to persist: the new
 * `AppConfig` (theme keys from `base` preserved) and the credential entries the
 * wizard collected (provider name → apiKey). Keys are kept OUT of the config.
 */
export function applyWizardResult(
  base: AppConfig,
  result: WizardResult,
): { config: AppConfig; credentials: Record<string, string> } {
  const providers = result.providers.map(buildProviderConfig);
  const interpret: InterpretConfigInput = {
    auto: result.auto,
    inlineTranscripts: result.inlineTranscripts,
    exportConfirmThreshold: result.exportConfirmThreshold,
    chains: result.chains,
    providers,
    nudge: result.nudge,
  };
  const config: AppConfig = {
    theme: base.theme,
    accentColor: base.accentColor,
    interpret,
  };
  const credentials: Record<string, string> = {};
  for (const p of result.providers) {
    if (p.apiKey) credentials[p.name.trim()] = p.apiKey;
  }
  return { config, credentials };
}

/** Mask an API key for summary display (`sk-…last4`). */
export function maskKey(key: string): string {
  if (key.length <= 4) return "…";
  return `…${key.slice(-4)}`;
}

// ── Interactive runner (thin I/O shell) ─────────────────────────────────────

const AUTO_MODE_CHOICES: Array<{ name: string; value: AutoMode; description: string }> = [
  {
    name: "free — auto-run free links only (Apple + on-device); cloud on explicit request",
    value: "free",
    description: "Never sends media off-device automatically. Recommended.",
  },
  {
    name: "all — auto-run the full chain including cloud providers",
    value: "all",
    description: "Images/audio may leave your device automatically (per your chains).",
  },
  { name: "off — never interpret automatically", value: "off", description: "Manual only." },
];

/**
 * Run the interactive setup wizard. Dynamically imports `@inquirer/prompts`.
 * Writes config.json + credentials.json (0600) and prints a summary.
 */
export async function runSetupWizard(): Promise<void> {
  const prompts = await import("@inquirer/prompts");
  const { select, input, password, confirm } = prompts;

  const out = (s = "") => process.stdout.write(`${s}\n`);

  out("");
  out("  imsg — media interpretation setup");
  out("  ─────────────────────────────────");

  // 1) Doctor probe
  const report = probeMachine();
  const tools = probeLocalTools();
  out("");
  out("  Environment check:");
  for (const line of buildDoctorLines(report.imsgDb.readable, tools)) {
    out(`    ${line.ok ? "✓" : "✗"} ${line.text}`);
    if (line.hint) out(`        → ${line.hint}`);
  }

  // 2) Providers
  const base = loadTuiConfig().config;
  const existing = base.interpret?.providers ?? [];
  const providerAnswers: WizardProviderAnswer[] = [];
  const existingCreds = readCredentials();

  let addMore = await confirm({
    message:
      existing.length > 0
        ? `You have ${existing.length} provider(s). Reconfigure providers?`
        : "Add a cloud provider (OpenRouter, OpenAI, Ollama, …)?",
    default: existing.length === 0,
  });

  while (addMore) {
    const preset = (await select({
      message: "Provider preset:",
      choices: [
        ...PROVIDER_PRESET_NAMES.map((p) => ({ name: p, value: p as string })),
        { name: "custom (OpenAI-compatible base URL)", value: "__custom__" },
      ],
    })) as string;

    const isCustom = preset === "__custom__";
    const presetKey = isCustom ? undefined : (preset as ProviderPreset);
    const info = presetKey ? PROVIDER_PRESETS[presetKey] : undefined;

    const name = await input({
      message: "Name for this provider (used in chains):",
      default: isCustom ? "custom" : preset,
      validate: (v) => (v.trim().length > 0 ? true : "required"),
    });

    let baseUrl: string | undefined;
    if (isCustom) {
      baseUrl = await input({
        message: "OpenAI-compatible base URL (e.g. https://host/v1):",
        validate: (v) => (/^https?:\/\//.test(v.trim()) ? true : "must be an http(s) URL"),
      });
    }

    let accountId: string | undefined;
    if (info?.needsAccountId) {
      accountId = await input({
        message: "Cloudflare account id:",
        validate: (v) => (v.trim().length > 0 ? true : "required"),
      });
    }

    let apiKey: string | undefined;
    const needsKey = isCustom || (info?.needsApiKey ?? true);
    if (needsKey) {
      const entered = await password({
        message: `API key for ${name}${existingCreds[name] ? " (blank keeps existing)" : ""}:`,
        mask: "•",
      });
      apiKey = entered.trim() || undefined;
    }

    providerAnswers.push({
      name: name.trim(),
      preset: presetKey,
      baseUrl,
      accountId,
      apiKey,
    });

    addMore = await confirm({ message: "Add another provider?", default: false });
  }

  // Carry forward existing providers the user did not re-enter (by name).
  const enteredNames = new Set(providerAnswers.map((p) => p.name));
  for (const p of existing) {
    if (!enteredNames.has(p.name)) {
      providerAnswers.push({ ...p, apiKey: undefined });
    }
  }
  const providerConfigs = providerAnswers.map(buildProviderConfig);

  // 3) Chains per media type
  const pickChain = async (kind: "audio" | "image" | "video"): Promise<string[]> => {
    const recipes = chainRecipes(kind, providerConfigs);
    if (recipes.length === 1) return recipes[0].chain;
    const idx = await select({
      message: `${kind[0].toUpperCase()}${kind.slice(1)} interpretation:`,
      choices: recipes.map((r, i) => ({ name: r.label, value: i })),
    });
    return recipes[idx].chain;
  };
  const chains: InterpretChains = {
    audio: await pickChain("audio"),
    image: await pickChain("image"),
    video: await pickChain("video"),
  };

  // 4) Toggles
  const auto = (await select({
    message: "Auto-interpretation mode:",
    choices: AUTO_MODE_CHOICES.map((c) => ({
      name: c.name,
      value: c.value,
      description: c.description,
    })),
    default: "free",
  })) as AutoMode;

  const inlineTranscripts = await confirm({
    message: "Inline cached transcripts/captions in message output?",
    default: true,
  });

  const thresholdRaw = await input({
    message: "Confirm before an export triggers more than N uncached cloud calls:",
    default: "25",
    validate: (v) => (/^\d+$/.test(v.trim()) ? true : "enter a non-negative integer"),
  });
  const exportConfirmThreshold = Number.parseInt(thresholdRaw.trim(), 10);

  const nudgeEnabled = await confirm({
    message: "Nudge Messages.app to download missing attachments on demand?",
    default: true,
  });
  let tier2SyncNow = false;
  if (nudgeEnabled) {
    tier2SyncNow = await confirm({
      message: 'Also allow UI-scripted "Sync Now" (needs Accessibility permission)?',
      default: false,
    });
  }

  // 5) Assemble, validate, write
  const result: WizardResult = {
    providers: providerAnswers,
    chains,
    auto,
    inlineTranscripts,
    exportConfirmThreshold,
    nudge: { enabled: nudgeEnabled, tier2SyncNow, timeoutSeconds: 30 },
  };
  const warnings = validateInterpretConfig({ chains, providers: providerConfigs });
  const { config, credentials } = applyWizardResult(base, result);

  const configPath = writeTuiConfig(config);
  for (const [pname, key] of Object.entries(credentials)) setCredential(pname, key);

  out("");
  out(`  ✓ Config written: ${configPath}`);
  if (Object.keys(credentials).length > 0) {
    out("  ✓ Credentials saved (chmod 600):");
    for (const [pname, key] of Object.entries(credentials)) out(`      ${pname}: ${maskKey(key)}`);
  }
  out("");
  out("  Chains:");
  out(`      audio: ${chains.audio.join(" → ") || "(off)"}`);
  out(`      image: ${chains.image.join(" → ") || "(off)"}`);
  out(`      video: ${chains.video.join(" → ") || "(off)"}`);
  out(`  Auto mode: ${auto}`);
  for (const w of warnings) out(`  ⚠ ${w}`);
  out("");
}

/** Re-export the resolved-config type for CLI use. */
export type { ResolvedInterpretConfig };
