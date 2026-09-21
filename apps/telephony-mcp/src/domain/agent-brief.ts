/**
 * Agent briefs (Phase Q step 4) — PURE: config in, AgentBrief out, no I/O.
 *
 * A delegate call briefs its agent from the same `profiles.<name>` a direct
 * call uses (no second config concept). One agent per (profile, recording)
 * pair, not one per call: the per-call objective and context reach the agent
 * as dynamic variables, so the agent itself only changes when the profile
 * does — and `briefHash` makes that detectable, which is what makes
 * provisioning idempotent.
 *
 * Why recording splits the agent: ElevenLabs' recording switch
 * (`platform_settings.privacy.record_voice`) is an agent setting with no
 * per-conversation override, so a recorded and an unrecorded call cannot
 * share one agent without mutating it per call (D-76, PHASE-Q notes).
 *
 * O-24 lands here: the agent prompt IS the conversation harness.
 */
import { createHash } from "node:crypto";
import { type Config, effectiveCallSettings } from "../config/schema.js";
import type { AgentBrief, AgentProfileRecord } from "./ports.js";

/**
 * The conversation-harness preamble (O-24, George 2026-09-04, from the live
 * call where "cloudflare" arrived as "cloud flood"). Mode-agnostic on purpose:
 * Phase T attaches O-25's structured-output turn contract to the same text.
 */
export const HARNESS_PREAMBLE = [
  "You are speaking with a real person on a live phone call.",
  'What you receive is a speech-to-text transcript of what they said, and it is approximate: speech recognition often mangles proper nouns and technical terms phonetically — for example "Cloudflare" may arrive as "cloud flood", and "Claude Code" as "cord code".',
  "Correct obvious mis-hearings charitably, using the context of the conversation to infer the word the person most likely meant.",
  "But for anything important — a name, a number, a command, or a confirmation — do NOT guess. Say the line broke up for a moment, and ask them to repeat it or spell it out.",
].join("\n");

/** Dynamic-variable names the prompt template references (per-call values). */
export const OBJECTIVE_VARIABLE = "call_objective";
export const CONTEXT_VARIABLE = "call_context";

/**
 * Bump when the ADAPTER's mapping of a brief onto the platform changes (a new
 * field sent, a tool enabled): it is folded into the hash so every existing
 * agent is re-updated once, instead of silently keeping the old shape.
 */
export const AGENT_BRIEF_VERSION = 1;

/** sqlite key for the agent serving (profile, recording). */
export function agentKey(profile: string, recordVoice: boolean): string {
  return recordVoice ? `${profile}+recorded` : profile;
}

/** Workspace-visible agent name. Profile names match ^[a-z0-9][a-z0-9-]*$ — never a number. */
export function agentName(profile: string, recordVoice: boolean): string {
  return recordVoice ? `eqstack-${profile}-recorded` : `eqstack-${profile}`;
}

/** harness preamble + profile prompt + the per-call objective block (mirrors RelaySession). */
export function composeAgentPrompt(systemPrompt: string, preamble = HARNESS_PREAMBLE): string {
  return [
    preamble,
    systemPrompt,
    [
      `Objective of this call: {{${OBJECTIVE_VARIABLE}}}`,
      `Context from the initiating agent: {{${CONTEXT_VARIABLE}}}`,
    ].join("\n"),
  ].join("\n\n");
}

/** BCP 47 "en-AU" → ISO 639-1 "en" (the platform's agent language code). */
export function agentLanguage(bcp47: string): string {
  return (bcp47.split("-")[0] ?? bcp47).toLowerCase();
}

export function buildBrief(
  cfg: Config,
  profileName: string,
  recordVoice: boolean,
  preamble = HARNESS_PREAMBLE,
): AgentBrief {
  const settings = effectiveCallSettings(cfg, profileName);
  const v = settings.voice;
  return {
    name: agentName(profileName, recordVoice),
    prompt: composeAgentPrompt(settings.profile.systemPrompt, preamble),
    firstMessage: settings.profile.greeting ?? null,
    language: agentLanguage(v.language),
    voice: {
      voiceId: v.voiceId,
      speed: v.speed,
      stability: v.stability ?? null,
      similarityBoost: v.similarity ?? null,
    },
    maxDurationSec: settings.maxDurationSec,
    recordVoice,
  };
}

/** JSON with sorted keys at every depth, so the hash never depends on key order. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export function briefHash(brief: AgentBrief): string {
  return createHash("sha256")
    .update(stableStringify({ v: AGENT_BRIEF_VERSION, brief }))
    .digest("hex");
}

/** The per-call values. Never a phone number (INV-11) — objective and context only. */
export function buildDynamicVariables(
  objective: string,
  context: string | null,
): Record<string, string> {
  return {
    [OBJECTIVE_VARIABLE]: objective,
    [CONTEXT_VARIABLE]: context ?? "(none provided)",
  };
}

export type AgentAction = "create" | "update" | "reuse";

/**
 * What a delegate place_call shows about its agent: on dryRun, what WOULD
 * happen (nothing is created); on a dial, what did.
 */
export interface AgentPreview {
  platform: string;
  name: string;
  /** Null when the agent does not exist yet (dryRun of a first call). */
  agentId: string | null;
  action: AgentAction;
  briefHash: string;
  /** dryRun only: the full brief and per-call variables the agent would get. */
  brief?: AgentBrief | undefined;
  dynamicVariables?: Record<string, string> | undefined;
}

/** What provisioning would do for this brief, given the stored mapping. */
export function planAgentAction(existing: AgentProfileRecord | null, hash: string): AgentAction {
  if (!existing) return "create";
  return existing.briefHash === hash ? "reuse" : "update";
}
