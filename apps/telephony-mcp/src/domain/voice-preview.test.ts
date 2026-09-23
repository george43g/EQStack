import { describe, expect, it } from "vitest";
import {
  ADJUST_TOOL,
  applyAdjustments,
  buildPreviewSpec,
  extractPreviewActions,
  MAX_PREVIEW_CANDIDATES,
  PREVIEW_AGENT_NAME,
  PREVIEW_CANDIDATES,
  PREVIEW_HOST_VOICE,
  type PreviewVoiceState,
  profileNameFromSpoken,
  SAVE_TOOL,
  SPEED_RANGE,
  selectCandidates,
} from "./voice-preview.js";

const states = (): PreviewVoiceState[] =>
  PREVIEW_CANDIDATES.map((c) => ({
    label: c.label,
    voiceId: c.voiceId,
    speed: c.speed,
    stability: c.stability,
    similarityBoost: c.similarityBoost,
  }));

const call = (name: string, params: unknown) => ({ name, paramsJson: JSON.stringify(params) });

describe("the candidate line-up", () => {
  it("fits the platform's 10-voice cap with the host voice, and never reuses a label or voice", () => {
    expect(PREVIEW_CANDIDATES.length).toBeLessThanOrEqual(MAX_PREVIEW_CANDIDATES);
    expect(MAX_PREVIEW_CANDIDATES + 1).toBe(10);
    expect(new Set(PREVIEW_CANDIDATES.map((c) => c.label)).size).toBe(PREVIEW_CANDIDATES.length);
    const ids = [PREVIEW_HOST_VOICE.voiceId, ...PREVIEW_CANDIDATES.map((c) => c.voiceId)];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("is varied: Australian and British, both genders, and a spread of speeds inside the platform range", () => {
    const accents = new Set(PREVIEW_CANDIDATES.map((c) => c.accent));
    expect(accents.has("australian") && accents.has("british")).toBe(true);
    expect(new Set(PREVIEW_CANDIDATES.map((c) => c.gender))).toEqual(new Set(["female", "male"]));
    const speeds = PREVIEW_CANDIDATES.map((c) => c.speed);
    for (const s of speeds) {
      expect(s).toBeGreaterThanOrEqual(SPEED_RANGE.min);
      expect(s).toBeLessThanOrEqual(SPEED_RANGE.max);
    }
    expect(Math.max(...speeds) - Math.min(...speeds)).toBeGreaterThanOrEqual(0.1);
  });

  it("uses tags the markup can carry (one capitalised word) and records why each is there", () => {
    for (const c of PREVIEW_CANDIDATES) {
      expect(c.label).toMatch(/^[A-Z][a-z]+$/);
      expect(c.why.length).toBeGreaterThan(20);
    }
  });

  it("a 6-voice prefix still mixes accent and gender", () => {
    const six = selectCandidates(6);
    expect(new Set(six.map((c) => c.accent)).size).toBeGreaterThanOrEqual(2);
    expect(new Set(six.map((c) => c.gender)).size).toBe(2);
  });
});

describe("selectCandidates", () => {
  it("clamps the count to 1..9", () => {
    expect(selectCandidates(0)).toHaveLength(1);
    expect(selectCandidates(99)).toHaveLength(MAX_PREVIEW_CANDIDATES);
  });

  it("keeps settings the live agent already carries for the same label and voice", () => {
    const live = states();
    live[0] = { ...live[0]!, speed: 0.8, stability: 0.3 };
    const [first] = selectCandidates(3, live);
    expect(first).toMatchObject({ speed: 0.8, stability: 0.3 });
  });

  it("ignores a live entry whose voice id changed, and reset goes back to the catalogue", () => {
    const live = states();
    live[0] = { ...live[0]!, voiceId: "someOtherVoice", speed: 0.8 };
    expect(selectCandidates(1, live)[0]?.speed).toBe(PREVIEW_CANDIDATES[0]?.speed);
    const tuned = states();
    tuned[0] = { ...tuned[0]!, speed: 0.8 };
    expect(selectCandidates(1, tuned, true)[0]?.speed).toBe(PREVIEW_CANDIDATES[0]?.speed);
  });
});

describe("buildPreviewSpec", () => {
  it("names the agent, uses the host voice, and teaches the exact tags and both tools", () => {
    const spec = buildPreviewSpec(selectCandidates(3));
    expect(spec.name).toBe(PREVIEW_AGENT_NAME);
    expect(spec.name.startsWith("eqstack-preview")).toBe(true);
    expect(spec.hostVoiceId).toBe(PREVIEW_HOST_VOICE.voiceId);
    expect(spec.prompt).toContain("<Hannah>");
    expect(spec.prompt).toContain(ADJUST_TOOL);
    expect(spec.prompt).toContain(SAVE_TOOL);
    // Honesty about the measured limit: changes are heard after a reconnect.
    expect(spec.prompt).toMatch(/reconnects/);
    expect(spec.firstMessage).toContain("3 voices");
  });
});

describe("profileNameFromSpoken", () => {
  it.each([
    ["Harbour", "harbour"],
    ["Harbour Blue", "harbour-blue"],
    ["  Café Noir! ", "cafe-noir"],
    ["R2-D2", "r2-d2"],
  ])("%s → %s", (spoken, slug) => {
    expect(profileNameFromSpoken(spoken)).toBe(slug);
  });

  it("returns null when nothing usable is left", () => {
    expect(profileNameFromSpoken("!!!")).toBeNull();
    expect(profileNameFromSpoken("")).toBeNull();
  });
});

describe("extractPreviewActions", () => {
  it("replays adjustments in order, clamps them, and folds them into a later save", () => {
    const out = extractPreviewActions(
      [
        call(ADJUST_TOOL, { label: "Roger", speed: 0.5, note: "much slower" }),
        call(ADJUST_TOOL, { label: "roger", stability: 1.4, similarity_boost: 0.6 }),
        call(SAVE_TOOL, { label: "Roger", name: "Harbour" }),
        call(SAVE_TOOL, { label: "Hannah", name: "Sunny Day" }),
      ],
      states(),
    );
    expect(out.adjustments).toEqual([
      { label: "Roger", speed: SPEED_RANGE.min, note: "much slower" },
      { label: "Roger", stability: 1, similarityBoost: 0.6 },
    ]);
    expect(out.saves).toHaveLength(2);
    expect(out.saves[0]).toMatchObject({
      label: "Roger",
      spokenName: "Harbour",
      profileName: "harbour",
      includesUnheardChange: true,
      voice: { speed: SPEED_RANGE.min, stability: 1, similarityBoost: 0.6 },
    });
    expect(out.saves[1]).toMatchObject({ profileName: "sunny-day", includesUnheardChange: false });
    expect(out.rejected).toEqual([]);
  });

  it("a note-only adjustment is recorded but does not mark a save as changed", () => {
    const out = extractPreviewActions(
      [
        call(ADJUST_TOOL, { label: "Ollie", note: "deeper" }),
        call(SAVE_TOOL, { label: "Ollie", name: "Ollie" }),
      ],
      states(),
    );
    expect(out.adjustments).toEqual([{ label: "Ollie", note: "deeper" }]);
    expect(out.saves[0]?.includesUnheardChange).toBe(false);
  });

  it("rejects unknown labels, unreadable params and unusable names; ignores other tools", () => {
    const out = extractPreviewActions(
      [
        call(ADJUST_TOOL, { label: "Nobody", speed: 1 }),
        { name: SAVE_TOOL, paramsJson: "{not json" },
        call(SAVE_TOOL, { label: "Lily", name: "???" }),
        call("end_call", {}),
      ],
      states(),
    );
    expect(out.adjustments).toEqual([]);
    expect(out.saves).toEqual([]);
    expect(out.rejected).toHaveLength(3);
    expect(out.rejected[0]).toContain("Nobody");
  });

  it("applyAdjustments changes only the named voice and leaves the input untouched", () => {
    const voices = selectCandidates(3);
    const next = applyAdjustments(voices, [{ label: "Ollie", speed: 0.8 }]);
    expect(next.find((v) => v.label === "Ollie")?.speed).toBe(0.8);
    expect(voices.find((v) => v.label === "Ollie")?.speed).toBe(0.95);
    expect(next.find((v) => v.label === "Hannah")).toEqual(voices[0]);
  });
});
