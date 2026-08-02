/**
 * Canonical persistent configuration for imsg-mcp — one JSON file that carries
 * both the flat TUI keys (theme / accentColor) AND the `interpret` block that
 * configures media interpretation (Stage 2 core: chains, providers, toggles).
 *
 * Resolution order (first one found wins) — unchanged from the original
 * tui-config module so existing files keep loading:
 *   1. $XDG_CONFIG_HOME/imsg-mcp/config.json
 *   2. $HOME/.config/imsg-mcp/config.json
 *   3. $HOME/.imsg-mcp/config.json     (matches the slugs.db location)
 *
 * `src/tui-config.ts` re-exports this module verbatim for back-compat.
 *
 * API keys are NEVER stored in config.json. They live in
 * `~/.imsg-mcp/credentials.json` (chmod 600, `{ "<providerName>": "sk-…" }`)
 * or the legacy `IMSG_TRANSCRIBE_*` env vars, and are merged into providers only
 * at resolution time (`resolveInterpretConfig`).
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { getTranscribeCloudConfig } from "./config.js";
import type { AutoMode, InterpretChains, InterpretConfig } from "./media-intel.js";
import type { ProviderConfig, ProviderPreset } from "./media-providers.js";

// ── Schema ────────────────────────────────────────────────────────────────

const HEX6 = /^#[0-9a-fA-F]{6}$/;

/** Preset names accepted in the `interpret.providers[].preset` field. Kept as a
 *  literal tuple so Zod can build an enum without a runtime import of the
 *  providers module (and asserted to stay in sync with `ProviderPreset`). */
const PROVIDER_PRESET_NAMES = [
  "openai",
  "groq",
  "openrouter",
  "cloudflare",
  "huggingface",
  "ollama",
] as const satisfies readonly ProviderPreset[];

const ProviderModelsSchema = z
  .object({ transcribe: z.string().optional(), vision: z.string().optional() })
  .optional();

/** A provider profile as stored in config.json — NO apiKey (that lives in
 *  credentials.json / env and is merged in at resolution time). */
const ProviderConfigSchema = z
  .object({
    name: z.string().min(1),
    preset: z.enum(PROVIDER_PRESET_NAMES).optional(),
    baseUrl: z.string().url().optional(),
    accountId: z.string().optional(),
    models: ProviderModelsSchema,
  })
  .refine((p) => Boolean(p.preset) || Boolean(p.baseUrl), {
    message: "provider needs either a preset or a baseUrl",
  });

const ChainsSchema = z
  .object({
    audio: z.array(z.string()).default(["apple", "local"]),
    image: z.array(z.string()).default([]),
    video: z.array(z.string()).default([]),
  })
  .default({});

const NudgeSchema = z
  .object({
    enabled: z.boolean().default(true),
    tier2SyncNow: z.boolean().default(false),
    timeoutSeconds: z.number().int().positive().default(30),
  })
  .default({});

export const InterpretConfigSchema = z.object({
  /** Auto-interpretation gate. "free" (default) never makes a paid call without
   *  an explicit force; "all" runs the full chain incl. cloud; "off" disables. */
  auto: z.enum(["all", "free", "off"]).default("free"),
  /** Inline cached transcripts/captions in read surfaces (get_messages, TUI). */
  inlineTranscripts: z.boolean().default(true),
  /** Confirm before an export triggers more than this many uncached cloud calls. */
  exportConfirmThreshold: z.number().int().nonnegative().default(25),
  chains: ChainsSchema,
  providers: z.array(ProviderConfigSchema).default([]),
  nudge: NudgeSchema,
});

export const AppConfigSchema = z.object({
  /** Glyph preset. "safe" is the universally-renderable default. */
  theme: z.enum(["safe", "powerline"]).default("safe"),
  /** 6-digit hex color used to derive the whole UI palette. */
  accentColor: z.string().regex(HEX6, "must be a 6-digit hex like #RRGGBB").default("#1982FC"),
  /** Media-interpretation config (optional — absent on TUI-only configs). */
  interpret: InterpretConfigSchema.optional(),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
export type InterpretConfigInput = z.infer<typeof InterpretConfigSchema>;

/** Back-compat alias — the TUI only ever reads theme/accentColor. */
export const TuiConfigSchema = AppConfigSchema;
export type TuiConfig = AppConfig;

export const DEFAULT_TUI_CONFIG: TuiConfig = {
  theme: "safe",
  accentColor: "#1982FC",
};

/** Free-first interpret defaults used when the block is absent from config. */
export const DEFAULT_INTERPRET_CONFIG: InterpretConfigInput = InterpretConfigSchema.parse({});

// ── Path resolution ───────────────────────────────────────────────────────

/** Candidate paths we try to read from, in order. Per the XDG spec, `~/.config`
 *  is the DEFAULT VALUE of `$XDG_CONFIG_HOME` — not an additional search path —
 *  so when the env var is set we must not fall through to the real `~/.config`
 *  (that fall-through also let a dev machine's real config leak into tests that
 *  point XDG at a temp dir). */
function candidatePaths(): string[] {
  const home = homedir();
  const xdgBase = process.env.XDG_CONFIG_HOME || join(home, ".config");
  return [join(xdgBase, "imsg-mcp", "config.json"), join(home, ".imsg-mcp", "config.json")];
}

/** Where the file actually lives (first existing candidate), or null. */
export function findTuiConfigPath(): string | null {
  for (const p of candidatePaths()) {
    if (existsSync(p)) return p;
  }
  return null;
}

/** Where to write a fresh config file. Returns the *first* candidate so
 *  XDG-style wins on a clean machine. */
export function defaultTuiConfigPath(): string {
  return candidatePaths()[0] ?? candidatePaths()[1];
}

// ── Loader ────────────────────────────────────────────────────────────────

export interface LoadedTuiConfig {
  config: AppConfig;
  /** Path of the file we read from, or `null` if defaults were used. */
  source: string | null;
  /** Human-readable warnings (parse errors, schema errors). Empty when clean. */
  warnings: string[];
}

export function loadTuiConfig(): LoadedTuiConfig {
  const warnings: string[] = [];
  const path = findTuiConfigPath();
  if (!path) return { config: { ...DEFAULT_TUI_CONFIG }, source: null, warnings };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    warnings.push(
      `config: failed to read ${path} (${err instanceof Error ? err.message : String(err)}); using defaults`,
    );
    return { config: { ...DEFAULT_TUI_CONFIG }, source: path, warnings };
  }

  const result = AppConfigSchema.safeParse(parsed);
  if (result.success) return { config: result.data, source: path, warnings };

  // Full parse failed. Degrade gracefully: if the flat TUI keys alone are valid,
  // keep them (a malformed `interpret` block should not blow away the theme).
  const tuiOnly = AppConfigSchema.pick({ theme: true, accentColor: true }).safeParse(parsed);
  const issues = result.error.issues
    .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
    .join("; ");
  if (tuiOnly.success) {
    warnings.push(`config: ${path} has invalid fields (${issues}); ignoring them`);
    return { config: { ...tuiOnly.data }, source: path, warnings };
  }
  warnings.push(`config: ${path} has invalid fields (${issues}); using defaults`);
  return { config: { ...DEFAULT_TUI_CONFIG }, source: path, warnings };
}

// ── Writer (used by `imsg config edit` + `imsg setup`) ────────────────────

export function writeTuiConfig(config: AppConfig, path = defaultTuiConfigPath()): string {
  // Validate before writing so we never persist garbage.
  const validated = AppConfigSchema.parse(config);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(validated, null, 2)}\n`);
  return path;
}

// ── Credentials (chmod 600) ───────────────────────────────────────────────

/** `~/.imsg-mcp/credentials.json` — `{ "<providerName>": "<apiKey>" }`. */
export function credentialsPath(): string {
  return join(homedir(), ".imsg-mcp", "credentials.json");
}

export function readCredentials(): Record<string, string> {
  const path = credentialsPath();
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "string") out[k] = v;
      }
      return out;
    }
  } catch {
    // Corrupt credentials file — treat as empty (never throw on read).
  }
  return {};
}

/** Write the whole credentials map, enforcing 0600 on the file (and 0700 dir). */
export function writeCredentials(creds: Record<string, string>): string {
  const path = credentialsPath();
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Best-effort — a shared dir may already exist with other perms.
  }
  writeFileSync(path, `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600 });
  // writeFileSync's `mode` is masked by umask on CREATE and ignored when the
  // file already exists — chmod unconditionally so 0600 is guaranteed.
  chmodSync(path, 0o600);
  return path;
}

/** Set (or clear, when key is empty) one provider's credential. */
export function setCredential(name: string, key: string): void {
  const creds = readCredentials();
  if (key) creds[name] = key;
  else delete creds[name];
  writeCredentials(creds);
}

// ── Interpret-config resolution (config + credentials + env → service) ─────

/** The env-mapped implicit provider name (legacy IMSG_TRANSCRIBE_* path). */
export const ENV_PROVIDER_NAME = "env";

/** Interpret config ready for `MediaIntelService`, plus the surfacing toggles
 *  that frontends (Stage 4/6/7) read. Providers carry their merged apiKey. */
export interface ResolvedInterpretConfig extends InterpretConfig {
  inlineTranscripts: boolean;
  exportConfirmThreshold: number;
  nudge: { enabled: boolean; tier2SyncNow: boolean; timeoutSeconds: number };
  /** Where the config was read from (null = defaults). */
  configPath: string | null;
  warnings: string[];
}

/**
 * Resolve the full interpret configuration:
 *   - start from the config file's `interpret` block (or free-first defaults),
 *   - merge API keys from credentials.json into each named provider,
 *   - map the legacy `IMSG_TRANSCRIBE_*` env vars to an implicit `env` provider
 *     (and append `provider:env` to the audio chain if it has no provider yet),
 *     preserving the shipped v1.7.0 cloud-transcription fallback.
 */
export function resolveInterpretConfig(): ResolvedInterpretConfig {
  const loaded = loadTuiConfig();
  const warnings = [...loaded.warnings];
  const block = InterpretConfigSchema.parse(loaded.config.interpret ?? {});
  const creds = readCredentials();

  const providers: ProviderConfig[] = block.providers.map((p) => ({
    ...p,
    apiKey: creds[p.name],
  }));
  const chains: InterpretChains = {
    audio: [...block.chains.audio],
    image: [...block.chains.image],
    video: [...block.chains.video],
  };

  // Legacy env fallback → implicit provider, if not already configured by name.
  const envCloud = getTranscribeCloudConfig();
  if (envCloud && !providers.some((p) => p.name === ENV_PROVIDER_NAME)) {
    providers.push({
      name: ENV_PROVIDER_NAME,
      baseUrl: envCloud.baseUrl,
      apiKey: envCloud.apiKey,
      models: { transcribe: envCloud.model },
    });
    if (!chains.audio.some((l) => l.startsWith("provider:"))) {
      chains.audio.push(`provider:${ENV_PROVIDER_NAME}`);
    }
  }

  const auto: AutoMode = block.auto;
  return {
    auto,
    chains,
    providers,
    inlineTranscripts: block.inlineTranscripts,
    exportConfirmThreshold: block.exportConfirmThreshold,
    nudge: block.nudge,
    configPath: loaded.source,
    warnings,
  };
}

// ── Layered resolution (CLI > env > config > defaults) — TUI theme/accent ──

export interface TuiConfigOverrides {
  /** From `imsg --theme=...` */
  cliTheme?: string;
  /** From `imsg --accent=...` */
  cliAccent?: string;
}

export interface ResolvedTuiConfig {
  theme: TuiConfig["theme"];
  accentColor: string;
  /** Where each value came from, useful for `imsg config show`. */
  origin: {
    theme: "cli" | "env" | "config" | "default";
    accentColor: "cli" | "env" | "config" | "default";
  };
  /** The on-disk file path that contributed (or `null` if no file). */
  configPath: string | null;
  /** Any warnings raised during loading (malformed file, invalid env, etc). */
  warnings: string[];
}

export function resolveTuiConfig(overrides: TuiConfigOverrides = {}): ResolvedTuiConfig {
  const loaded = loadTuiConfig();
  const warnings = [...loaded.warnings];

  // Theme precedence: CLI > env > config > default
  let theme: TuiConfig["theme"] = loaded.config.theme;
  let themeOrigin: ResolvedTuiConfig["origin"]["theme"] = loaded.source ? "config" : "default";

  if (process.env.IMSG_TUI_THEME) {
    const t = process.env.IMSG_TUI_THEME;
    if (t === "safe" || t === "powerline") {
      theme = t;
      themeOrigin = "env";
    } else {
      warnings.push(`IMSG_TUI_THEME="${t}" is not "safe" or "powerline"; ignoring`);
    }
  }
  if (overrides.cliTheme !== undefined) {
    if (overrides.cliTheme === "safe" || overrides.cliTheme === "powerline") {
      theme = overrides.cliTheme;
      themeOrigin = "cli";
    } else {
      warnings.push(`--theme="${overrides.cliTheme}" is not "safe" or "powerline"; ignoring`);
    }
  }

  // Accent precedence: CLI > env > config > default
  let accentColor = loaded.config.accentColor;
  let accentOrigin: ResolvedTuiConfig["origin"]["accentColor"] = loaded.source
    ? "config"
    : "default";

  if (process.env.IMSG_TUI_ACCENT) {
    if (HEX6.test(process.env.IMSG_TUI_ACCENT)) {
      accentColor = process.env.IMSG_TUI_ACCENT;
      accentOrigin = "env";
    } else {
      warnings.push(
        `IMSG_TUI_ACCENT="${process.env.IMSG_TUI_ACCENT}" is not a 6-digit hex; ignoring`,
      );
    }
  }
  if (overrides.cliAccent !== undefined) {
    if (HEX6.test(overrides.cliAccent)) {
      accentColor = overrides.cliAccent;
      accentOrigin = "cli";
    } else {
      warnings.push(`--accent="${overrides.cliAccent}" is not a 6-digit hex; ignoring`);
    }
  }

  return {
    theme,
    accentColor,
    origin: { theme: themeOrigin, accentColor: accentOrigin },
    configPath: loaded.source,
    warnings,
  };
}
