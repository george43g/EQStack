/**
 * Agent briefs (Phase Q step 4) — PURE: config in, AgentBrief out, no I/O.
 *
 * A delegate call briefs its agent from the same `profiles.<name>` a direct
 * call uses (no second config concept). One agent per (profile, recording,
 * consult) variant, not one per call: the per-call objective and context reach the agent
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
import {
  type Config,
  consultResponseTimeoutSecs,
  effectiveCallSettings,
} from "../config/schema.js";
import type { AgentBrief, AgentProfileRecord, ConsultToolSpec } from "./ports.js";

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

/**
 * What splits one profile into separate platform agents: recording (D-80)
 * and the consult tool (D-92). Both are agent-level on the platform, so a
 * profile maps to at most four agents.
 */
export interface AgentVariant {
  recordVoice: boolean;
  consult?: boolean | undefined;
}

/** sqlite key for the agent serving (profile, variant): `<profile>[+consult][+recorded]`. */
export function agentKey(profile: string, variant: AgentVariant): string {
  return `${profile}${variant.consult ? "+consult" : ""}${variant.recordVoice ? "+recorded" : ""}`;
}

/** Workspace-visible agent name. Profile names match ^[a-z0-9][a-z0-9-]*$ — never a number. */
export function agentName(profile: string, variant: AgentVariant): string {
  return `eqstack-${profile}${variant.consult ? "-consult" : ""}${variant.recordVoice ? "-recorded" : ""}`;
}

// ── Consult (Phase R, D-90..D-94) ─────────────────────────────────────────

/** The tool EL's agent sees. Registered on the platform, not in our registry (INV-1 style). */
export const CONSULT_TOOL_NAME = "consult_originator";

/**
 * The per-call bearer's dynamic-variable name. The `secret__` prefix is what
 * keeps it from the LLM: EL docs (dynamic-variables) — secret variables
 * "should only be used in dynamic variable headers and never sent to an LLM
 * provider as part of an agent's system prompt or first message" (D-90).
 */
export const CONSULT_BEARER_VARIABLE = "secret__consult_bearer";

/** The only path the tool listener serves (D-91). */
export const CONSULT_ROUTE_PATH = "/v1/consult";

/**
 * The consult block of the EL agent's harness (PHASE-R § 6). Pinned by a unit
 * test like the preamble: tighten wording, never drop a rule.
 */
export const CONSULT_HARNESS = [
  "You were sent on this call by someone who is not on the line: the originator. You can ask them a question with the `consult_originator` tool.",
  "Consult rather than guess when the person asks for a fact, decision, commitment or permission that your objective and context do not cover — a date, a price, an agreement, personal details, anything you would otherwise have to invent. Do not consult for small talk or for anything already in your context.",
  'Make each question self-contained — the originator cannot hear this call. Include what they need to decide: "They offer Tuesday 3pm or Thursday 10am — which should I accept?", not "Which one?". One question per call of the tool.',
  'Before you call it, tell the person briefly that you are checking: "Let me check that — one moment." While you wait, do not fill the silence with guesses.',
  "If the result is `answered`: relay the answer naturally and add nothing it does not say. If `pending`: say you have not heard back yet, offer to carry on, and later — at the latest before you end the call — call the tool once more with `collect_question_id` set to the id you were given. If `unavailable`, `busy`, `call_ended` or an error: do not retry; tell the person you will pass the question on and that someone will follow up.",
  "Never make up an answer the originator did not give.",
].join("\n");

/** EL's LLM picks a tool by its description, so it repeats the first two rules in one line. */
export const CONSULT_TOOL_DESCRIPTION =
  "Ask the originator — who sent you on this call and cannot hear it — one self-contained question, whenever the person asks for a fact, decision, commitment or permission your objective and context do not cover. Consult rather than guess; never for small talk.";

/** The consult tool as data (D-89): EL owns the filler speech, hold sound and timeout. */
export function buildConsultToolSpec(cfg: Config): ConsultToolSpec {
  const consult = cfg.agentPlatform?.consult;
  if (!consult) throw new Error('consult needs the "agentPlatform.consult" config block');
  return {
    name: CONSULT_TOOL_NAME,
    description: CONSULT_TOOL_DESCRIPTION,
    url: `${consult.toolsBaseUrl.replace(/\/$/, "")}${CONSULT_ROUTE_PATH}`,
    responseTimeoutSecs: consultResponseTimeoutSecs(consult),
    bearerVariable: CONSULT_BEARER_VARIABLE,
    preToolSpeech: "force",
    toolCallSound: "typing",
    toolCallSoundBehavior: "always",
    executionMode: "immediate",
    // Step 10 measures what callee speech does to a pending call under "allow".
    interruptionMode: "allow",
    toolErrorHandlingMode: "summarized",
  };
}

/**
 * harness preamble [+ consult block] + profile prompt + the per-call
 * objective block (mirrors RelaySession). The consult block sits between the
 * preamble and the profile, and only on consult briefs (PHASE-R § 6).
 */
export function composeAgentPrompt(
  systemPrompt: string,
  preamble = HARNESS_PREAMBLE,
  consultBlock: string | null = null,
): string {
  return [
    preamble,
    ...(consultBlock ? [consultBlock] : []),
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
  variant: AgentVariant,
  preamble = HARNESS_PREAMBLE,
): AgentBrief {
  const settings = effectiveCallSettings(cfg, profileName);
  const v = settings.voice;
  const { recordVoice } = variant;
  // Undefined — not absent-by-accident — for delegate briefs: stableStringify
  // drops undefined keys, so no existing delegate agent's hash moves (D-92).
  const consultTool = variant.consult ? buildConsultToolSpec(cfg) : undefined;
  return {
    name: agentName(profileName, variant),
    prompt: composeAgentPrompt(
      settings.profile.systemPrompt,
      preamble,
      consultTool ? CONSULT_HARNESS : null,
    ),
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
    consultTool,
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

/**
 * The per-call values. Never a phone number (INV-11) — objective and context,
 * plus, on a consult call only, the bearer header value. EL fails a call when
 * a referenced variable is missing (PHASE-Q note 7), so a consult agent always
 * gets the bearer and a delegate agent never does (it references none).
 */
export function buildDynamicVariables(
  objective: string,
  context: string | null,
  consultBearerToken: string | null = null,
): Record<string, string> {
  return {
    [OBJECTIVE_VARIABLE]: objective,
    [CONTEXT_VARIABLE]: context ?? "(none provided)",
    ...(consultBearerToken !== null
      ? { [CONSULT_BEARER_VARIABLE]: `Bearer ${consultBearerToken}` }
      : {}),
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
