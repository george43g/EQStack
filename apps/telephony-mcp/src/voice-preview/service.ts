/**
 * The voice-preview workflow over a VoicePreviewPort and the config file.
 * Runs in the CALLING process (CLI or MCP host), not in `serve`: it touches
 * neither the call DB (INV-9's reason for routing mutations through the
 * admin API) nor a phone line, so requiring the gateway would add a
 * dependency and buy nothing. See LOCAL_COMMANDS in commands/specs.ts.
 *
 * The loop, as measured (src/domain/voice-preview.ts header):
 *   preview  → create/update the one preview agent, print the talk-to link
 *   (George talks on EL's hosted page; asks for changes; names one)
 *   review   → once EL marks the session `done`, read its tool calls
 *   preview --apply → fold the requested changes into the agent; reconnect
 *   save     → write the named choice into config.json `profiles`
 * `watchStep` is one iteration of doing the last three automatically.
 */
import { readFileSync } from "node:fs";
import { planVoiceProfile, writeVoiceProfile } from "../config/profile-writer.js";
import type { VoicePreviewPort } from "../domain/ports.js";
import {
  applyAdjustments,
  buildPreviewSpec,
  extractPreviewActions,
  MAX_PREVIEW_CANDIDATES,
  PREVIEW_AGENT_NAME,
  PREVIEW_CANDIDATES,
  PREVIEW_HOST_VOICE,
  type PreviewActions,
  type PreviewVoice,
  type PreviewVoiceState,
  profileNameFromSpoken,
  SAVE_TOOL,
  selectCandidates,
  type VoiceAdjustment,
} from "../domain/voice-preview.js";

export class VoicePreviewError extends Error {}

export interface VoicePreviewDeps {
  port: VoicePreviewPort;
  /** config.json to write saved profiles into (never read for anything else). */
  configPath: string;
  nowMs?: () => number;
}

export interface PreviewResult {
  agentId: string;
  agentName: string;
  action: "create" | "update";
  talkUrl: string;
  hostVoice: string;
  voices: Array<
    Pick<
      PreviewVoice,
      | "label"
      | "name"
      | "voiceId"
      | "accent"
      | "gender"
      | "speed"
      | "stability"
      | "similarityBoost"
      | "why"
    >
  >;
  /** Adjustments folded in from a finished session (with `applyFrom`). */
  applied: VoiceAdjustment[];
  appliedFrom: string | null;
}

export interface ReviewResult extends PreviewActions {
  conversationId: string;
  status: string;
  finished: boolean;
}

export interface SavedProfile {
  name: string;
  label: string;
  base: string;
  voice: { voiceId: string; speed: number; stability: number | null; similarity: number | null };
  replaced: boolean;
  includesUnheardChange: boolean;
  backupPath: string | null;
}

export interface SaveResult {
  configPath: string;
  dryRun: boolean;
  saved: SavedProfile[];
  rejected: string[];
  notices: string[];
}

const FINISHED = new Set(["done", "failed"]);

export class VoicePreviewService {
  private now: () => number;

  constructor(private deps: VoicePreviewDeps) {
    this.now = deps.nowMs ?? Date.now;
  }

  private async requireAgent(): Promise<{ agentId: string; voices: PreviewVoiceState[] }> {
    const agent = await this.deps.port.findPreviewAgent(PREVIEW_AGENT_NAME);
    if (!agent) {
      throw new VoicePreviewError(
        `no preview agent yet (${PREVIEW_AGENT_NAME}) — run preview_voices / \`tel voices preview\` first`,
      );
    }
    return agent;
  }

  /** "latest" / undefined → the newest session of the preview agent. */
  private async resolveConversation(agentId: string, ref: string | undefined): Promise<string> {
    if (ref && ref !== "latest") return ref;
    const [newest] = await this.deps.port.listPreviewConversations(agentId, 1);
    if (!newest) throw new VoicePreviewError("the preview agent has no sessions yet");
    return newest.conversationId;
  }

  private async actionsFor(
    conversationId: string,
    startVoices: PreviewVoiceState[],
  ): Promise<ReviewResult> {
    const conv = await this.deps.port.getPreviewConversation(conversationId);
    const finished = conv.status === "done";
    const actions = finished
      ? extractPreviewActions(conv.toolCalls, startVoices)
      : { adjustments: [], saves: [], rejected: [] };
    return { conversationId: conv.conversationId, status: conv.status, finished, ...actions };
  }

  /**
   * Idempotent: creates the agent if missing, else PATCHes it to the line-up.
   * Settings George already tuned survive a re-run unless `reset`.
   */
  async preview(
    opts: { candidates?: number; reset?: boolean; applyFrom?: string } = {},
  ): Promise<PreviewResult> {
    const { port } = this.deps;
    const existing = await port.findPreviewAgent(PREVIEW_AGENT_NAME);
    let voices = selectCandidates(
      opts.candidates ?? MAX_PREVIEW_CANDIDATES,
      existing?.voices ?? [],
      opts.reset ?? false,
    );
    let applied: VoiceAdjustment[] = [];
    let appliedFrom: string | null = null;
    if (opts.applyFrom !== undefined) {
      if (!existing) throw new VoicePreviewError("nothing to apply: no preview agent exists yet");
      appliedFrom = await this.resolveConversation(existing.agentId, opts.applyFrom);
      const review = await this.actionsFor(appliedFrom, existing.voices);
      if (!review.finished) {
        throw new VoicePreviewError(
          `session ${appliedFrom} is ${review.status}; its requests are readable once it is done`,
        );
      }
      applied = review.adjustments.filter((a) => voices.some((v) => v.label === a.label));
      voices = applyAdjustments(voices, applied);
    }
    const spec = buildPreviewSpec(voices);
    let agentId: string;
    let action: "create" | "update";
    if (existing) {
      await port.updatePreviewAgent(existing.agentId, spec);
      agentId = existing.agentId;
      action = "update";
    } else {
      agentId = (await port.createPreviewAgent(spec)).agentId;
      action = "create";
    }
    return {
      agentId,
      agentName: PREVIEW_AGENT_NAME,
      action,
      talkUrl: port.talkUrl(agentId),
      hostVoice: PREVIEW_HOST_VOICE.name,
      voices: voices.map(
        ({ label, name, voiceId, accent, gender, speed, stability, similarityBoost, why }) => ({
          label,
          name,
          voiceId,
          accent,
          gender,
          speed,
          stability,
          similarityBoost,
          why,
        }),
      ),
      applied,
      appliedFrom,
    };
  }

  async review(conversation?: string): Promise<ReviewResult> {
    const agent = await this.requireAgent();
    const id = await this.resolveConversation(agent.agentId, conversation);
    return this.actionsFor(id, agent.voices);
  }

  /**
   * Save from a session's `save_profile` calls, or explicitly (`label` +
   * `name`, current agent settings for that label). dryRun writes nothing.
   */
  async save(opts: {
    conversation?: string;
    label?: string;
    name?: string;
    base?: string;
    overwrite?: boolean;
    dryRun?: boolean;
  }): Promise<SaveResult> {
    const agent = await this.requireAgent();
    const base = opts.base ?? "default";
    const notices: string[] = [];
    let choices: Array<{
      label: string;
      profileName: string;
      voice: PreviewVoiceState;
      includesUnheardChange: boolean;
    }>;
    let rejected: string[] = [];

    if (opts.label !== undefined) {
      if (!opts.name)
        throw new VoicePreviewError("an explicit label needs a name to save it under");
      const voice = agent.voices.find((v) => v.label.toLowerCase() === opts.label?.toLowerCase());
      if (!voice) {
        throw new VoicePreviewError(
          `no candidate labelled "${opts.label}" (have: ${agent.voices.map((v) => v.label).join(", ")})`,
        );
      }
      const profileName = profileNameFromSpoken(opts.name);
      if (!profileName) throw new VoicePreviewError(`"${opts.name}" does not make a profile name`);
      choices = [{ label: voice.label, profileName, voice, includesUnheardChange: false }];
    } else {
      const id = await this.resolveConversation(agent.agentId, opts.conversation);
      const review = await this.actionsFor(id, agent.voices);
      if (!review.finished) {
        throw new VoicePreviewError(
          `session ${id} is ${review.status}; the name George gave is readable once it is done`,
        );
      }
      rejected = review.rejected;
      choices = review.saves.map((s) =>
        opts.name ? { ...s, profileName: profileNameFromSpoken(opts.name) ?? s.profileName } : s,
      );
      if (choices.length === 0) notices.push(`session ${id} named no voice (no ${SAVE_TOOL} call)`);
    }

    // A second save of the same name in one session: the last one wins.
    const byName = new Map(choices.map((c) => [c.profileName, c]));
    const saved: SavedProfile[] = [];
    for (const c of byName.values()) {
      const catalogue = PREVIEW_CANDIDATES.find((p) => p.voiceId === c.voice.voiceId);
      const voice = {
        voiceId: c.voice.voiceId,
        speed: c.voice.speed ?? catalogue?.speed ?? 1,
        stability: c.voice.stability,
        similarity: c.voice.similarityBoost,
      };
      const write = { name: c.profileName, base, voice, overwrite: opts.overwrite ?? false };
      if (opts.dryRun) {
        const plan = planVoiceProfile(readFileSync(this.deps.configPath, "utf8"), write);
        saved.push({
          name: c.profileName,
          label: c.label,
          base,
          voice,
          replaced: plan.replaces,
          includesUnheardChange: c.includesUnheardChange,
          backupPath: null,
        });
        continue;
      }
      const result = writeVoiceProfile(this.deps.configPath, write, this.now());
      saved.push({
        name: c.profileName,
        label: c.label,
        base,
        voice,
        replaced: result.replaces,
        includesUnheardChange: c.includesUnheardChange,
        backupPath: result.backupPath,
      });
      if (c.includesUnheardChange) {
        notices.push(
          `"${c.profileName}" includes a change George asked for in the same session and has not heard yet`,
        );
      }
    }
    if (saved.length > 0 && !opts.dryRun) {
      notices.push(
        "a running `tel serve` read its config at start — restart it (tel daemon restart) before calling with a new profile",
      );
    }
    return {
      configPath: this.deps.configPath,
      dryRun: opts.dryRun ?? false,
      saved,
      rejected,
      notices,
    };
  }

  /**
   * One pass of the watch loop: every session that started at/after
   * `sinceSecs`, finished, and is not in `seen` gets its adjustments applied
   * to the agent and (unless `save` is false) its named choices saved.
   * `seen` is updated in place. Failures on one session never stop the rest.
   */
  async watchStep(state: {
    sinceSecs: number;
    seen: Set<string>;
    save: boolean;
    candidates?: number;
  }): Promise<
    Array<{ conversationId: string; applied?: PreviewResult; saved?: SaveResult; error?: string }>
  > {
    const agent = await this.requireAgent();
    const sessions = await this.deps.port.listPreviewConversations(agent.agentId, 10);
    const ready = sessions
      .filter((s) => s.startedAtSecs >= state.sinceSecs && FINISHED.has(s.status))
      .filter((s) => !state.seen.has(s.conversationId))
      .reverse(); // oldest first, so a later session's settings win
    const out: Array<{
      conversationId: string;
      applied?: PreviewResult;
      saved?: SaveResult;
      error?: string;
    }> = [];
    for (const s of ready) {
      state.seen.add(s.conversationId);
      if (s.status !== "done") {
        out.push({ conversationId: s.conversationId, error: `session ${s.status}` });
        continue;
      }
      const row: (typeof out)[number] = { conversationId: s.conversationId };
      try {
        const applied = await this.preview({
          applyFrom: s.conversationId,
          ...(state.candidates !== undefined ? { candidates: state.candidates } : {}),
        });
        if (applied.applied.length > 0) row.applied = applied;
        if (state.save) {
          const saved = await this.save({ conversation: s.conversationId });
          if (saved.saved.length > 0 || saved.rejected.length > 0) row.saved = saved;
        }
      } catch (err) {
        row.error = (err as Error).message;
      }
      out.push(row);
    }
    return out;
  }
}

/** Exposed for the CLI table. */
export function describeVoices(voices: PreviewResult["voices"]): string[] {
  return voices.map(
    (v, i) =>
      `${String(i + 1).padStart(2)}. ${v.label.padEnd(8)} ${v.accent.padEnd(10)} ${v.gender.padEnd(6)} speed ${v.speed.toFixed(2)}  stability ${v.stability ?? "-"}  — ${v.name}`,
  );
}
