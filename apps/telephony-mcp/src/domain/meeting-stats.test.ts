/**
 * PHASE-GC Step 8: `meetingTurnStats` on golden transcripts, with and without
 * voice tags (O-47: whether EL's stored transcript keeps them is unknown).
 */
import { describe, expect, it } from "vitest";
import { meetingTurnStats, type StatsTranscriptItem, splitSegments } from "./meeting-stats.js";

const PERSONAS = [
  { label: "Executive", displayName: "Executive" },
  { label: "Eqstack", displayName: "EQ Stack" },
];
const LABELS = PERSONAS.map((p) => p.label);

const u = (text: string): StatsTranscriptItem => ({ role: "user", text });
const a = (text: string | null): StatsTranscriptItem => ({ role: "agent", text });

/** A well-behaved meeting: every persona segment was asked for. */
const GOOD: StatsTranscriptItem[] = [
  a("Meeting's open. On the line: Executive and EQ Stack. What's first?"),
  u("Executive, what's on my plate this week?"),
  a("<Executive>Two things: the board pack and the hire.</Executive> Anything else, George?"),
  u("EQ Stack, is the group-call build done?"),
  a("EQ Stack is checking that."),
  a(null), // a tool call: no text
  a("<Eqstack>The first slice is built and in review.</Eqstack> George?"),
  u("Let's poll everyone: ship it this week?"),
  a("<Executive>Yes, if review is clean.</Executive><Eqstack>Yes.</Eqstack> Back to you, George."),
  u("Hang on, Sam..."),
  a("Let me bring in Executive on the hire."),
  a("<Executive>The offer went out Monday.</Executive>"),
];

/** Personas chiming in unasked — what the harness exists to prevent. */
const CHATTY: StatsTranscriptItem[] = [
  u("Executive, what's on my plate?"),
  a(
    "<Executive>The board pack.</Executive><Eqstack>Great point — and the build is nearly done.</Eqstack>",
  ),
  u("Thanks. What time is it?"),
  a("<Eqstack>Half past three.</Eqstack>"),
];

describe("splitSegments", () => {
  it("tagged runs become persona segments; the rest is the chair's; unknown tags stay text", () => {
    expect(splitSegments("Hi. <Executive>Yes.</Executive> And <Other>x</Other>.", LABELS)).toEqual([
      { speaker: "chair", text: "Hi." },
      { speaker: "Executive", text: "Yes." },
      { speaker: "chair", text: "And <Other>x</Other>." },
    ]);
    expect(splitSegments("<Executive></Executive>", LABELS)).toEqual([]);
  });
});

describe("meetingTurnStats", () => {
  it("a well-behaved meeting has zero unsolicited segments (addressed, polled, or invited by the chair)", () => {
    const s = meetingTurnStats(GOOD, PERSONAS);
    expect(s.tagged).toBe(true);
    expect(s.unsolicited).toBe(0);
    expect(s.perPersona).toEqual({
      Executive: { segments: 3, unsolicited: 0 },
      Eqstack: { segments: 2, unsolicited: 0 },
    });
    expect(s.agentTurns).toBe(7);
    expect(s.multiPersonaTurns).toBe(1); // the poll, the one allowed exception
  });

  it("flags personas that speak when nobody named them", () => {
    const s = meetingTurnStats(CHATTY, PERSONAS);
    expect(s.unsolicited).toBe(2);
    expect(s.perPersona.Eqstack).toEqual({ segments: 2, unsolicited: 2 });
    expect(s.perPersona.Executive).toEqual({ segments: 1, unsolicited: 0 });
    expect(s.segments.filter((x) => x.unsolicited).map((x) => x.text)).toEqual([
      "Great point — and the build is nearly done.",
      "Half past three.",
    ]);
    expect(s.multiPersonaTurns).toBe(1);
  });

  it("an untagged transcript attributes everything to the chair and says so (tagged: false)", () => {
    const untagged = GOOD.map((i) => ({
      ...i,
      text: i.text?.replace(/<\/?(Executive|Eqstack)>/g, "") ?? null,
    }));
    const s = meetingTurnStats(untagged, PERSONAS);
    expect(s.tagged).toBe(false);
    expect(s.unsolicited).toBe(0);
    expect(s.chairSegments).toBe(s.segments.length);
    expect(s.perPersona.Executive).toEqual({ segments: 0, unsolicited: 0 });
  });

  it("a persona's display name counts as addressing it, case-insensitively and on word boundaries", () => {
    const s = meetingTurnStats([u("eq stack, status?"), a("<Eqstack>Green.</Eqstack>")], PERSONAS);
    expect(s.unsolicited).toBe(0);
    const t = meetingTurnStats(
      [u("the executives are late"), a("<Executive>Sorry.</Executive>")],
      PERSONAS,
    );
    expect(t.unsolicited).toBe(1);
  });
});
