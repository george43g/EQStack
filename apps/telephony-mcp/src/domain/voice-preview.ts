/**
 * Voice-profile preview session — PURE: candidates in, agent spec out; tool
 * calls in, adjustments and saves out. No I/O (the service does that).
 *
 * George, 2026-09-23: *"set up a call where i can just preview the different
 * profiles, speak to them to listen to them and then just verbally adjust
 * them and name the one i like"*. Built on `ELEVENLABS-REALTIME.md`
 * Recommendation 3: ONE agent carrying multi-voice
 * (`conversation_config.tts.supported_voices`, max 10 incl. the default,
 * `<LABEL>text</LABEL>` markup, per-voice speed/stability/similarity), talked
 * to on the laptop through ElevenLabs' own hosted talk-to page.
 *
 * What was MEASURED on 2026-09-23 (text-driven conversation WebSocket against
 * the real agent), and what the design therefore assumes:
 *  - Library voices (not added to the account) speak inside `<LABEL>` tags.
 *  - A PATCH to the agent does NOT reach a session in progress — neither a
 *    prompt change nor a voice's speed (same sentence, same voice: 159,760 /
 *    164,602 audio bytes before a 0.9 → 1.2 speed PATCH, 154,918 after; a
 *    33 % speed-up would have been ~120k). So an adjustment is RECORDED in the
 *    session (tool call), applied between sessions, and heard on reconnect.
 *  - Client tools with `expects_response: false` are acknowledged by EL
 *    itself (`agent_tool_response … status: success`) with no client code
 *    answering, and land in `GET conversation` as `tool_calls[].params_as_json`
 *    once the conversation is `done`. That is the pull path: no public route.
 */
import { z } from "zod";

/** Workspace-visible name of the one preview agent. Matched exactly when looked up. */
export const PREVIEW_AGENT_NAME = "eqstack-preview-voices";

/** EL: "Maximum of 10 supported voices per agent (including default)". */
export const MAX_PREVIEW_CANDIDATES = 9;

/** EL agent TTS accepts 0.7–1.2; outside it a PATCH is rejected. */
export const SPEED_RANGE = { min: 0.7, max: 1.2 } as const;

export const ADJUST_TOOL = "adjust_voice";
export const SAVE_TOOL = "save_profile";

/** A candidate as the session plays it. Settings null = the platform default. */
export interface PreviewVoice {
  /** The markup tag, `<Label>…</Label>`. One capitalised word. */
  label: string;
  voiceId: string;
  /** Library name, for the table George reads. */
  name: string;
  accent: "australian" | "british" | "american";
  gender: "female" | "male";
  /** Spoken to the host agent so it can suggest a fit ("deepest", "calmest"). */
  description: string;
  speed: number;
  stability: number | null;
  similarityBoost: number | null;
  /** Why it is in the line-up (recorded for the next agent; never sent to EL). */
  why: string;
}

/**
 * The host speaks untagged text. River is a premade, gender-neutral, relaxed
 * voice — deliberately NOT one of the accents on audition, so it never
 * sounds like a candidate.
 */
export const PREVIEW_HOST_VOICE = { voiceId: "SAz9YHcvj6GT2YYXdXww", name: "River" } as const;

/**
 * The line-up. Ordered so any prefix (`--candidates N`) still mixes accent
 * and gender. Voice ids are from `GET /v1/voices` (premade + George's own
 * library) and `GET /v1/shared-voices?accent=…&use_cases=conversational`
 * (sorted by a year's usage), read 2026-09-23. George's brief was "less
 * generic, cooler" after hearing Charlie (the current default): so mostly
 * conversational voices tagged relaxed/casual/calm, a lower stability than
 * the 0.7 the default agent runs (lower = more expressive, less "AI-even"),
 * and speeds a notch under 1 on the laid-back ones.
 */
export const PREVIEW_CANDIDATES: readonly PreviewVoice[] = [
  {
    label: "Hannah",
    voiceId: "M7ya1YbaeFaPXljg9BpK",
    name: "Hannah - Natural Australian",
    accent: "australian",
    gender: "female",
    description: "Australian woman, young, natural and warm, confident",
    speed: 1.0,
    stability: 0.5,
    similarityBoost: 0.8,
    why: "Natural, warm Australian female from the shared library (34k adds) — picked over the more-added Arabella (raspy) and Emma (neutral presenter) for an un-polished conversational sound.",
  },
  {
    label: "Ollie",
    voiceId: "jRAAK67SEFE9m7ci5DhD",
    name: "Ollie - Natural & Relaxed British Voice",
    accent: "british",
    gender: "male",
    description: "British man, relaxed and grounded, understated",
    speed: 0.95,
    stability: 0.45,
    similarityBoost: 0.8,
    why: "Relaxed British conversational voice — the 'cooler' British option, not the broadcaster (Daniel) or storyteller (George) premades.",
  },
  {
    label: "David",
    voiceId: "ouFAjcjtdrVBT9bRFhFQ",
    name: "David - Young Australian Male, Deep, Calming",
    accent: "australian",
    gender: "male",
    description: "Australian man, young, deep and calm, casual",
    speed: 0.95,
    stability: 0.5,
    similarityBoost: 0.8,
    why: "The deepest, calmest Australian male in the conversational set — the answer to 'try it deeper' with an Aussie accent.",
  },
  {
    label: "Lily",
    voiceId: "pFZP5JQG7iQjIQuC4Bku",
    name: "Lily - Velvety Actress",
    accent: "british",
    gender: "female",
    description: "British woman, velvety and composed",
    speed: 1.0,
    stability: 0.5,
    similarityBoost: 0.8,
    why: "Premade British female (always available, no library dependency); smooth rather than chirpy.",
  },
  {
    label: "Roger",
    voiceId: "CwhRBWXzGAHq8TQ4Fs17",
    name: "Roger - Laid-Back, Casual, Resonant",
    accent: "american",
    gender: "male",
    description: "American man, laid-back, casual, resonant and deep",
    speed: 0.9,
    stability: 0.45,
    similarityBoost: 0.8,
    why: "Premade laid-back American — the deliberate out-of-accent contrast, slowed to 0.9 for the 'cool' end of the range.",
  },
  {
    label: "Liam",
    voiceId: "bVxvWZpqo0NXHobrj0ri",
    name: "Liam - Aussie Car Chat & POV Narrator",
    accent: "australian",
    gender: "male",
    description: "Australian man, young, chill, chatty",
    speed: 1.05,
    stability: 0.45,
    similarityBoost: 0.8,
    why: "Already in George's own voice library (a professional voice he added), so one he has shown interest in; the livelier Aussie male.",
  },
  {
    label: "Lucy",
    voiceId: "lcMyyd2HUfFzxdCaC4Ta",
    name: "Lucy - Fresh & Casual",
    accent: "british",
    gender: "female",
    description: "British woman, young, fresh and casual, energetic",
    speed: 1.05,
    stability: 0.45,
    similarityBoost: 0.8,
    why: "The livelier, faster British female — the other end of the energy range from Lily.",
  },
  {
    label: "Archer",
    voiceId: "Fahco4VZzobUeiPqni1S",
    name: "Archer - Conversational",
    accent: "british",
    gender: "male",
    description: "British man, thirties, calm and casual, podcast-style",
    speed: 1.0,
    stability: 0.5,
    similarityBoost: 0.8,
    why: "The single most-used conversational British voice in the library (322k adds) — the safe benchmark against Ollie.",
  },
  {
    label: "Charlie",
    voiceId: "IKne3meq5aSn9XLyUdCD",
    name: "Charlie - Deep, Confident, Energetic",
    accent: "australian",
    gender: "male",
    description: "Australian man, deep, confident and energetic",
    speed: 1.0,
    stability: 0.7,
    similarityBoost: 0.8,
    why: "The CURRENT default (eqstack-default's voice, at its 0.7 stability) — kept as the baseline George called generic, so every other voice is heard against it.",
  },
];

/** What the adapter provisions. Platform-neutral; the EL body is built in the adapter. */
export interface PreviewAgentSpec {
  name: string;
  prompt: string;
  firstMessage: string;
  language: string;
  hostVoiceId: string;
  voices: PreviewVoice[];
  maxDurationSec: number;
}

/** The per-label settings a live agent currently carries (the state George's tweaks live in). */
export interface PreviewVoiceState {
  label: string;
  voiceId: string;
  speed: number | null;
  stability: number | null;
  similarityBoost: number | null;
}

export function clampSpeed(v: number): number {
  return Math.round(Math.min(SPEED_RANGE.max, Math.max(SPEED_RANGE.min, v)) * 100) / 100;
}

function clampUnit(v: number): number {
  return Math.round(Math.min(1, Math.max(0, v)) * 100) / 100;
}

/**
 * The first `count` candidates, with any settings the live agent already
 * carries for the same (label, voice) kept — so a re-run does not undo
 * George's earlier adjustments. `reset` goes back to the catalogue.
 */
export function selectCandidates(
  count: number,
  current: readonly PreviewVoiceState[] = [],
  reset = false,
): PreviewVoice[] {
  const n = Math.max(1, Math.min(MAX_PREVIEW_CANDIDATES, Math.trunc(count)));
  return PREVIEW_CANDIDATES.slice(0, n).map((c) => {
    const live = reset ? undefined : current.find((s) => s.label === c.label);
    if (!live || live.voiceId !== c.voiceId) return { ...c };
    return {
      ...c,
      speed: live.speed ?? c.speed,
      stability: live.stability ?? c.stability,
      similarityBoost: live.similarityBoost ?? c.similarityBoost,
    };
  });
}

function settingsLine(v: PreviewVoice): string {
  const parts = [`speed ${v.speed}`];
  if (v.stability !== null) parts.push(`stability ${v.stability}`);
  if (v.similarityBoost !== null) parts.push(`similarity ${v.similarityBoost}`);
  return parts.join(", ");
}

export function composePreviewPrompt(voices: readonly PreviewVoice[]): string {
  const roster = voices
    .map((v, i) => `${i + 1}. ${v.label} — ${v.description} — ${settingsLine(v)}`)
    .join("\n");
  const example = voices[0]?.label ?? "Hannah";
  return [
    "You are the host of a voice audition. George is choosing the voice his phone assistant will use when it calls people for him. He is talking to you through his laptop.",
    `The candidates (number, tag, description, current settings):\n${roster}`,
    `To speak AS a candidate, wrap the words in its tag, exactly as listed: <${example}>Hey, it's ${example}.</${example}>. Tags are case-sensitive. Never say a tag, a setting or a number aloud unless George asks for the settings. Your own untagged voice is the host voice — keep it brief.`,
    [
      "How to run the session:",
      "- When George is ready, play the candidates in order. For each: say its number in your own voice, then let the candidate say one or two natural, casual sentences a phone assistant would really say — confirming a booking, asking a quick question, leaving a message. Vary the lines between candidates. After every three, check whether he wants to keep going.",
      "- He may ask to hear one again, compare two back to back, or hear one say something specific. Do exactly that.",
      `- When he asks to change a candidate, call ${ADJUST_TOOL} with its tag as label and the NEW absolute values. speed ${SPEED_RANGE.min}–${SPEED_RANGE.max}: slower is lower, a noticeable step is 0.1. stability 0–1: lower sounds more expressive and varied, higher steadier and more even. similarity 0–1: how closely it sticks to the original voice. "More relaxed" usually means about 0.05–0.1 slower and a little lower stability. Put his words in note.`,
      "- Be honest about timing: a change is recorded now and he hears it after he hangs up and reconnects, because a voice cannot change in the middle of this session. Never claim it already sounds different.",
      `- Pitch ("deeper", "higher") and accent belong to the voice itself, not its settings. Suggest the candidates that fit (from the descriptions) and play them. Still call ${ADJUST_TOOL} with just the label and a note, so the request is recorded.`,
      `- When he picks one and names it ("call that one Harbour"), call ${SAVE_TOOL} with the tag as label and the name exactly as he said it, then confirm: "Saved ${example} as Harbour." If he picks one without a name, ask for a name. If it is unclear which one he means, ask.`,
      "- When he is done, say goodbye and end the call.",
    ].join("\n"),
  ].join("\n\n");
}

export function previewFirstMessage(voices: readonly PreviewVoice[]): string {
  return `Hey George — voice audition. I've got ${voices.length} voices for you. I'll play them one at a time; stop me whenever, ask for any by name, tell me what to change, and when you like one, just give it a name. Ready?`;
}

export function buildPreviewSpec(voices: PreviewVoice[], maxDurationSec = 900): PreviewAgentSpec {
  return {
    name: PREVIEW_AGENT_NAME,
    prompt: composePreviewPrompt(voices),
    firstMessage: previewFirstMessage(voices),
    language: "en",
    hostVoiceId: PREVIEW_HOST_VOICE.voiceId,
    voices,
    maxDurationSec,
  };
}

// ── What a finished session asked for ──────────────────────────────────────

/** A tool call as the platform recorded it (name + raw JSON params). */
export interface PreviewToolCall {
  name: string;
  paramsJson: string;
}

export interface VoiceAdjustment {
  label: string;
  speed?: number;
  stability?: number;
  similarityBoost?: number;
  /** George's words, as the agent heard them. */
  note?: string;
}

export interface ProfileChoice {
  label: string;
  /** The name as the agent heard it ("Harbour"). */
  spokenName: string;
  /** The config key it becomes (`harbour`). */
  profileName: string;
  /** Settings at the moment of the save, after earlier adjustments in the same session. */
  voice: PreviewVoiceState;
  /** True when the saved settings include a change he asked for but has not heard yet. */
  includesUnheardChange: boolean;
}

export interface PreviewActions {
  adjustments: VoiceAdjustment[];
  saves: ProfileChoice[];
  /** Tool calls that could not be used, with the reason (unknown label, bad name…). */
  rejected: string[];
}

const AdjustParams = z.object({
  label: z.string().min(1),
  speed: z.number().optional(),
  stability: z.number().optional(),
  similarity: z.number().optional(),
  similarity_boost: z.number().optional(),
  note: z.string().optional(),
});

const SaveParams = z.object({ label: z.string().min(1), name: z.string().min(1) });

/** Config profile keys match ^[a-z0-9][a-z0-9-]*$ (schema.ts). "Harbour Blue" → "harbour-blue". */
export function profileNameFromSpoken(spoken: string): string | null {
  const slug = spoken
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return /^[a-z0-9][a-z0-9-]*$/.test(slug) ? slug.slice(0, 48).replace(/-+$/, "") : null;
}

function parseParams(json: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
}

/**
 * Replays a session's tool calls IN ORDER over the voices it started with.
 * Adjustments are absolute values, so replaying the same session twice is
 * idempotent. Labels are matched case-insensitively but must exist.
 */
export function extractPreviewActions(
  calls: readonly PreviewToolCall[],
  startVoices: readonly PreviewVoiceState[],
): PreviewActions {
  const voices = new Map(startVoices.map((v) => [v.label.toLowerCase(), { ...v }]));
  const touched = new Set<string>();
  const out: PreviewActions = { adjustments: [], saves: [], rejected: [] };
  for (const call of calls) {
    if (call.name !== ADJUST_TOOL && call.name !== SAVE_TOOL) continue;
    const raw = parseParams(call.paramsJson);
    if (call.name === ADJUST_TOOL) {
      const p = AdjustParams.safeParse(raw);
      if (!p.success) {
        out.rejected.push(`${ADJUST_TOOL}: unreadable parameters`);
        continue;
      }
      const v = voices.get(p.data.label.toLowerCase());
      if (!v) {
        out.rejected.push(`${ADJUST_TOOL}: no candidate labelled "${p.data.label}"`);
        continue;
      }
      const adj: VoiceAdjustment = { label: v.label };
      if (p.data.speed !== undefined) adj.speed = clampSpeed(p.data.speed);
      if (p.data.stability !== undefined) adj.stability = clampUnit(p.data.stability);
      const sim = p.data.similarity ?? p.data.similarity_boost;
      if (sim !== undefined) adj.similarityBoost = clampUnit(sim);
      if (p.data.note) adj.note = p.data.note;
      if (adj.speed !== undefined) v.speed = adj.speed;
      if (adj.stability !== undefined) v.stability = adj.stability;
      if (adj.similarityBoost !== undefined) v.similarityBoost = adj.similarityBoost;
      if (
        adj.speed !== undefined ||
        adj.stability !== undefined ||
        adj.similarityBoost !== undefined
      )
        touched.add(v.label);
      out.adjustments.push(adj);
      continue;
    }
    const p = SaveParams.safeParse(raw);
    if (!p.success) {
      out.rejected.push(`${SAVE_TOOL}: unreadable parameters`);
      continue;
    }
    const v = voices.get(p.data.label.toLowerCase());
    if (!v) {
      out.rejected.push(`${SAVE_TOOL}: no candidate labelled "${p.data.label}"`);
      continue;
    }
    const profileName = profileNameFromSpoken(p.data.name);
    if (!profileName) {
      out.rejected.push(`${SAVE_TOOL}: "${p.data.name}" does not make a profile name`);
      continue;
    }
    out.saves.push({
      label: v.label,
      spokenName: p.data.name,
      profileName,
      voice: { ...v },
      includesUnheardChange: touched.has(v.label),
    });
  }
  return out;
}

/** Folds adjustments into a line-up (labels already validated by extractPreviewActions). */
export function applyAdjustments(
  voices: readonly PreviewVoice[],
  adjustments: readonly VoiceAdjustment[],
): PreviewVoice[] {
  const next = voices.map((v) => ({ ...v }));
  for (const a of adjustments) {
    const v = next.find((x) => x.label === a.label);
    if (!v) continue;
    if (a.speed !== undefined) v.speed = a.speed;
    if (a.stability !== undefined) v.stability = a.stability;
    if (a.similarityBoost !== undefined) v.similarityBoost = a.similarityBoost;
  }
  return next;
}
