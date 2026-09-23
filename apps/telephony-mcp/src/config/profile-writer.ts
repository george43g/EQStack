/**
 * Writes a named voice profile into config.json — the one place telephony-mcp
 * edits the human-owned config file, and only when George names a voice in a
 * preview session (src/domain/voice-preview.ts).
 *
 * Rules, each pinned in profile-writer.test.ts:
 *  - The new profile COPIES a base profile (default: `default`) — prompt,
 *    greeting, limits — and overrides only its voice, so a saved voice is a
 *    callable profile at once, not a fragment.
 *  - An existing profile is never replaced without `overwrite` (a misheard
 *    name must not clobber a real profile).
 *  - The whole next config must pass `parseConfig` before anything is written.
 *  - The write is atomic (temp file in the same directory + rename), keeps the
 *    file's mode, and leaves a timestamped backup of the previous file beside it.
 *  - Only `profiles.<name>` changes. Everything else is carried as parsed JSON
 *    (re-serialised with 2-space indentation; key order is preserved).
 */
import { copyFileSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ConfigError, parseConfig } from "./schema.js";

export interface VoiceProfileWrite {
  name: string;
  /** Profile whose prompt/greeting/limits the new one copies. */
  base: string;
  voice: {
    voiceId: string;
    speed: number;
    stability: number | null;
    similarity: number | null;
  };
  overwrite: boolean;
}

export interface VoiceProfilePlan {
  name: string;
  base: string;
  /** The profile object exactly as it will be written. */
  profile: Record<string, unknown>;
  /** True when a profile of this name already exists (and overwrite was given). */
  replaces: boolean;
  /** The whole next config, as JSON text. */
  nextText: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** PURE: current config text + request → the next config, validated. Throws ConfigError. */
export function planVoiceProfile(currentText: string, w: VoiceProfileWrite): VoiceProfilePlan {
  let raw: unknown;
  try {
    raw = JSON.parse(currentText);
  } catch (err) {
    throw new ConfigError(`config is not valid JSON: ${(err as Error).message}`);
  }
  if (!isRecord(raw) || !isRecord(raw.profiles)) {
    throw new ConfigError("config has no profiles object");
  }
  const profiles = raw.profiles;
  const base = profiles[w.base];
  if (!isRecord(base)) throw new ConfigError(`unknown base profile: ${w.base}`);
  const replaces = w.name in profiles;
  if (replaces && !w.overwrite) {
    throw new ConfigError(
      `profile "${w.name}" already exists — choose another name, or pass overwrite to replace it`,
    );
  }
  const baseVoice = isRecord(base.voice) ? base.voice : {};
  const voice: Record<string, unknown> = {
    ...structuredClone(baseVoice),
    voiceId: w.voice.voiceId,
    speed: w.voice.speed,
  };
  if (w.voice.stability !== null) voice.stability = w.voice.stability;
  else delete voice.stability;
  if (w.voice.similarity !== null) voice.similarity = w.voice.similarity;
  else delete voice.similarity;
  const profile: Record<string, unknown> = { ...structuredClone(base), voice };
  const next = { ...raw, profiles: { ...profiles, [w.name]: profile } };
  parseConfig(next); // throws ConfigError naming the field — nothing is written
  return {
    name: w.name,
    base: w.base,
    profile,
    replaces,
    nextText: `${JSON.stringify(next, null, 2)}\n`,
  };
}

/** Plans, then writes atomically with a backup. Returns the plan and the backup path. */
export function writeVoiceProfile(
  path: string,
  w: VoiceProfileWrite,
  nowMs: number = Date.now(),
): VoiceProfilePlan & { backupPath: string } {
  const current = readFileSync(path, "utf8");
  const plan = planVoiceProfile(current, w);
  const mode = statSync(path).mode & 0o777;
  const stamp = new Date(nowMs).toISOString().replace(/[:.]/g, "-");
  const backupPath = join(dirname(path), `${basename(path)}.bak-${stamp}`);
  copyFileSync(path, backupPath);
  const tmp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${nowMs}`);
  writeFileSync(tmp, plan.nextText, { mode });
  renameSync(tmp, path);
  return { ...plan, backupPath };
}
