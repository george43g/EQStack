/**
 * PHASE-GC Steps 1, 3, 4 and 8 — offline pins (INV-14):
 *  - every config refusal of Step 1;
 *  - delegate and consult agents do NOT move: brief hashes AND wire bodies,
 *    golden values computed at main 1a6ce80 before this phase touched them;
 *  - the meeting brief and its wire body (supported_voices, ask_agent with
 *    the agent enum, end_call + skip_turn INSIDE `tools`, patient turns,
 *    auth on);
 *  - the harness texts keep every rule.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  consultConfig,
  delegateConfig,
  MEETING_TEST_VOICES,
  meetingConfig,
  testConfig,
} from "../../tests/helpers.js";
import { agentRequestBody, END_CALL_TOOL } from "../adapters/agent-platform/elevenlabs.js";
import { ConfigError, parseConfig } from "../config/schema.js";
import {
  AGENT_BRIEF_VERSION,
  ASK_AGENT_TOOL_DESCRIPTION,
  ASK_AGENT_TOOL_NAME,
  agentKey,
  agentName,
  briefHash,
  buildBrief,
  buildDynamicVariables,
  buildMeetingBrief,
  buildMeetingVariables,
  CHAIR_BLOCK,
  CONSULT_BEARER_VARIABLE,
  CONSULT_HARNESS,
  HARNESS_PREAMBLE,
  JOINER_BRIEFING,
  joinNames,
  MEETING_FIRST_MESSAGE,
  MEETING_HARNESS,
  memberJoinInstructions,
  neutralChairText,
} from "./agent-brief.js";

const sha = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex");

function raw(cfg: ReturnType<typeof meetingConfig>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(cfg)) as Record<string, unknown>;
}

function refusal(mutate: (c: Record<string, any>) => void): string {
  const c = raw(meetingConfig()) as Record<string, any>;
  mutate(c);
  try {
    parseConfig(c);
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return (err as Error).message;
  }
  throw new Error("config was accepted");
}

describe("meeting config (Step 1): refused at load, never at dial time", () => {
  it("the proposed line-up parses, with the documented defaults", () => {
    const cfg = meetingConfig();
    expect(cfg.meeting?.holdSec).toBe(20);
    expect(cfg.meeting?.maxDurationMinutes).toBe(30);
    expect(cfg.meeting?.chair.agent).toBe("secretary");
    expect(cfg.meeting?.chair.personaFile).toBeUndefined();
  });

  it("a voiceProfile that is not a profile", () => {
    expect(refusal((c) => (c.meeting.members.executive.voiceProfile = "nope"))).toMatch(
      /meeting\.members\.executive\.voiceProfile: no such profile "nope"/,
    );
    expect(refusal((c) => (c.meeting.chair.voiceProfile = "ghost"))).toMatch(
      /meeting\.chair\.voiceProfile: no such profile "ghost"/,
    );
  });

  it("a label that fails the regex, or repeats", () => {
    for (const label of ["executive", "EQ Stack", "X", "Exec1", "A".repeat(21)]) {
      expect(refusal((c) => (c.meeting.members.executive.label = label))).toMatch(
        /meeting\.members\.executive\.label/,
      );
    }
    expect(refusal((c) => (c.meeting.members.eqstack.label = "Executive"))).toMatch(
      /label "Executive" is already used by executive/,
    );
  });

  it("more than 9 members", () => {
    expect(
      refusal((c) => {
        for (let i = 0; i < 8; i++) {
          c.profiles[`v${i}`] = { systemPrompt: "x", voice: { voiceId: `voiceExtra${i}` } };
          c.meeting.members[`agent${i}`] = {
            label: `Agent${"abcdefgh"[i]}`,
            displayName: `Agent ${i}`,
            voiceProfile: `v${i}`,
            role: "extra",
          };
        }
      }),
    ).toMatch(/meeting\.members: at most 9 members/);
  });

  it("two voices (members or chair) sharing a voice id", () => {
    expect(refusal((c) => (c.meeting.members.eqstack.voiceProfile = "david"))).toMatch(
      /member "eqstack" would share a voice with member "executive"/,
    );
    expect(refusal((c) => (c.meeting.chair.voiceProfile = "roger"))).toMatch(
      /share a voice with the chair/,
    );
    // Two PROFILES with the same effective voice id are caught too.
    expect(refusal((c) => (c.profiles.roger.voice.voiceId = MEETING_TEST_VOICES.lily))).toMatch(
      /member "eqstack" would share a voice with the chair/,
    );
  });

  it("meeting without agentPlatform.consult: a meeting IS a consult call", () => {
    expect(refusal((c) => delete c.agentPlatform.consult)).toMatch(
      /meeting: meeting needs the "agentPlatform.consult" block/,
    );
  });

  it("holdSec is 5..60 (holdSec + 15 ≤ 300)", () => {
    expect(refusal((c) => (c.meeting.holdSec = 61))).toMatch(/meeting\.holdSec/);
    expect(refusal((c) => (c.meeting.holdSec = 4))).toMatch(/meeting\.holdSec/);
  });

  it("an empty roster, and an ill-formed member key", () => {
    expect(refusal((c) => (c.meeting.members = {}))).toMatch(/at least one member/);
    expect(refusal((c) => (c.meeting.members.Bad = c.meeting.members.executive))).toMatch(
      /meeting\.members\.Bad/,
    );
  });
});

describe("existing agents do not move (Step 8: hashes AND wire bodies, golden at 1a6ce80)", () => {
  const GOLD = {
    consult: {
      false: {
        hash: "7d41091625f85f6ca458c1c984c149bc23d971d025c15724db2687e18900188e",
        body: "07dc06af9571a46c6ce760510a61a3d09ec568018f437ddc90a4d8a8d4e19828",
      },
      true: {
        hash: "532595b4204ffd89fa5058d369e23654988e8e9b587f811b61f3aa1863099973",
        body: "275fbac982f6a8b3ada63f2b4c6b5bb173b1d5534c4993fed1add9e4c48eb1cb",
      },
    },
    delegateBody: {
      false: "46d93a872bf5b6d1cdbe79626e272aa2e8a6cccb5f170d7fc56aab8923a49475",
      true: "f60853c2a9e26d0708d4655cb14b689ffed169d64dee90e99c8604d816fab091",
    },
  } as const;

  it("AGENT_BRIEF_VERSION is not bumped: every new field is absent from existing briefs", () => {
    expect(AGENT_BRIEF_VERSION).toBe(2);
  });

  for (const recordVoice of [false, true] as const) {
    it(`consult (record ${recordVoice}): same hash, same body — with or without a meeting block`, () => {
      for (const cfg of [consultConfig(), meetingConfig()]) {
        const b = buildBrief(cfg, "default", { recordVoice, consult: true });
        expect(briefHash(b)).toBe(GOLD.consult[`${recordVoice}`].hash);
        expect(sha(agentRequestBody(b))).toBe(GOLD.consult[`${recordVoice}`].body);
        expect(b.supportedVoices).toBeUndefined();
        expect(b.consultTool?.addressees).toBeUndefined();
      }
    });

    it(`delegate (record ${recordVoice}): same body`, () => {
      const b = buildBrief(consultConfig(), "default", { recordVoice });
      expect(sha(agentRequestBody(b))).toBe(GOLD.delegateBody[`${recordVoice}`]);
    });
  }

  it("the golden delegate hashes of Phase R still hold with a meeting block configured", () => {
    expect(briefHash(buildBrief(meetingConfig(), "default", { recordVoice: false }))).toBe(
      "7335c514213667f4ed71d7830b0658921735e66bfa2ffc287d7f85ed6eeffee4",
    );
    expect(briefHash(buildBrief(testConfig(), "default", { recordVoice: false }))).toBe(
      "7335c514213667f4ed71d7830b0658921735e66bfa2ffc287d7f85ed6eeffee4",
    );
    expect(briefHash(buildBrief(delegateConfig(), "default", { recordVoice: true }))).toBe(
      "a6dc0834a98f43a77803dd199c5e9a37cf1caa861b0354d9ddf0519107a633b4",
    );
  });
});

describe("the meeting variant (Step 3)", () => {
  it("keys and names: one ensemble per recording state, never per profile", () => {
    expect(agentKey("lily", { recordVoice: false, meeting: true })).toBe("meeting");
    expect(agentKey("anything", { recordVoice: true, meeting: true, consult: true })).toBe(
      "meeting+recorded",
    );
    expect(agentName("lily", { recordVoice: false, meeting: true })).toBe("eqstack-meeting");
    expect(agentName("lily", { recordVoice: true, meeting: true })).toBe(
      "eqstack-meeting-recorded",
    );
  });

  it("the brief: chair voice by default, every configured member as a supported voice", () => {
    const b = buildMeetingBrief(meetingConfig(), { recordVoice: false }, null);
    expect(b.name).toBe("eqstack-meeting");
    expect(b.voice.voiceId).toBe(MEETING_TEST_VOICES.lily);
    expect(b.supportedVoices).toEqual([
      {
        label: "Executive",
        voiceId: MEETING_TEST_VOICES.david,
        speed: 0.95,
        stability: 0.6,
        // The base voice's similarity (0.8) carries over: the effective voice.
        similarityBoost: 0.8,
        description: "George's chief of staff: priorities, commitments, coordination",
      },
      {
        label: "Eqstack",
        voiceId: MEETING_TEST_VOICES.roger,
        speed: 1.05,
        stability: 0.7,
        similarityBoost: 0.75,
        description: "builds the EQ Stack comms apps: imsg, gmail, telephony",
      },
    ]);
    expect(b.extraSystemTools).toEqual(["skip_turn"]);
    expect(b.turnEagerness).toBe("patient");
    expect(b.enableAuth).toBe(true);
    expect(b.firstMessage).toBe(MEETING_FIRST_MESSAGE);
    expect(b.maxDurationSec).toBe(30 * 60);
    expect(b.consultTool).toMatchObject({
      name: ASK_AGENT_TOOL_NAME,
      description: ASK_AGENT_TOOL_DESCRIPTION,
      url: "https://tools.test.invalid/v1/consult",
      responseTimeoutSecs: 35, // holdSec 20 + 15 (D-93's rule)
      addressees: ["executive", "eqstack"],
    });
  });

  it("maxDurationMinutes is clamped by limits.hardMaxDurationMinutes", () => {
    const cfg = meetingConfig(
      { maxDurationMinutes: 90 },
      { limits: { hardMaxDurationMinutes: 20 } },
    );
    expect(buildMeetingBrief(cfg, { recordVoice: false }, null).maxDurationSec).toBe(20 * 60);
  });

  it("prompt order: preamble, MEETING_HARNESS, CHAIR_BLOCK, the chair, the agenda — and no CONSULT_HARNESS", () => {
    const neutral = buildMeetingBrief(meetingConfig(), { recordVoice: false }, null).prompt;
    const parts = [
      HARNESS_PREAMBLE,
      MEETING_HARNESS,
      CHAIR_BLOCK,
      neutralChairText("the chair"),
      "{{call_objective}}",
    ].map((p) => neutral.indexOf(p));
    expect(parts.every((i) => i >= 0)).toBe(true);
    expect([...parts].sort((a, b) => a - b)).toEqual(parts);
    expect(neutral).not.toContain(CONSULT_HARNESS);
    const persona = buildMeetingBrief(
      meetingConfig(),
      { recordVoice: false },
      "  I am the secretary.  ",
    ).prompt;
    expect(persona).toContain("I am the secretary.");
    expect(persona).not.toContain(neutralChairText("the chair"));
    expect(persona.indexOf(CHAIR_BLOCK)).toBeLessThan(persona.indexOf("I am the secretary."));
  });

  it("the hash moves with the roster, the persona and recording — not with anything per call", () => {
    const base = buildMeetingBrief(meetingConfig(), { recordVoice: false }, null);
    const recorded = buildMeetingBrief(meetingConfig(), { recordVoice: true }, null);
    const persona = buildMeetingBrief(meetingConfig(), { recordVoice: false }, "persona");
    const renamed = buildMeetingBrief(
      meetingConfig({
        members: {
          executive: {
            label: "Chief",
            displayName: "Executive",
            voiceProfile: "david",
            role: "x",
          },
        },
      }),
      { recordVoice: false },
      null,
    );
    const hashes = new Set([base, recorded, persona, renamed].map(briefHash));
    expect(hashes.size).toBe(4);
    expect(briefHash(buildMeetingBrief(meetingConfig(), { recordVoice: false }, null))).toBe(
      briefHash(base),
    );
  });

  it("roster variables: present members only, in the convenor's order, with briefs", () => {
    const meeting = meetingConfig().meeting;
    if (!meeting) throw new Error("no meeting");
    const v = buildMeetingVariables(meeting, ["eqstack", "executive"], {
      executive: "Owns the Q4 roadmap.",
    });
    const [first, second] = v.roster.split("\n");
    expect(first).toBe(
      'EQ Stack (ask_agent agent "eqstack") — speak as <Eqstack>…</Eqstack> — builds the EQ Stack comms apps: imsg, gmail, telephony. Brief: (none: use ask_agent)',
    );
    expect(second).toContain("<Executive>…</Executive>");
    expect(second).toContain("Brief: Owns the Q4 roadmap.");
    expect(v.rosterNames).toBe("EQ Stack and Executive");
    expect(buildMeetingVariables(meeting, ["executive"]).rosterNames).toBe("Executive");
    expect(joinNames(["A", "B", "C"])).toBe("A, B and C");
    expect(() => buildMeetingVariables(meeting, ["nobody"])).toThrow(/not a configured/);
  });

  it("dynamic variables: roster only on meeting calls; the bearer stays a secret__ header value", () => {
    const vars = buildDynamicVariables("agenda", null, "tok", {
      roster: "R",
      rosterNames: "N",
    });
    expect(vars).toEqual({
      call_objective: "agenda",
      call_context: "(none provided)",
      meeting_roster: "R",
      meeting_roster_names: "N",
      [CONSULT_BEARER_VARIABLE]: "Bearer tok",
    });
    expect(buildDynamicVariables("o", null, "tok")).not.toHaveProperty("meeting_roster");
  });

  it("join instructions carry the call id, the as-loop and the untrusted-input rule", () => {
    const t = memberJoinInstructions("executive", "call-1");
    expect(t).toContain('get_call_events {callId: "call-1", as: "executive", waitMs: 55000}');
    expect(t).toMatch(/answer_consult/);
    expect(t).toMatch(/untrusted input/);
    expect(t).toMatch(/say so at once/);
  });
});

describe("the meeting agent's wire body (Step 4)", () => {
  const body = agentRequestBody(buildMeetingBrief(meetingConfig(), { recordVoice: false }, null));
  const cc = body.conversation_config as Record<string, any>;
  const tools = cc.agent.prompt.tools as Array<Record<string, any>>;

  it("end_call AND skip_turn ride INSIDE `tools` — a `tools` list makes EL drop built_in_tools (live, 2026-09-23)", () => {
    expect(tools.map((t) => t.name)).toEqual([ASK_AGENT_TOOL_NAME, "end_call", "skip_turn"]);
    expect(tools[1]).toEqual(END_CALL_TOOL);
    // SDK v2.68.0: SystemToolConfigInput + SkipTurnToolConfig (an empty object).
    expect(tools[2]).toEqual({
      type: "system",
      name: "skip_turn",
      params: { system_tool_type: "skip_turn" },
    });
  });

  it("ask_agent: the consult webhook, addressed by a required `agent` enum of member keys", () => {
    const ask = tools[0] as Record<string, any>;
    expect(ask.type).toBe("webhook");
    expect(ask.response_timeout_secs).toBe(35);
    expect(ask.api_schema.url).toBe("https://tools.test.invalid/v1/consult");
    expect(ask.api_schema.request_headers).toEqual({
      Authorization: { variable_name: CONSULT_BEARER_VARIABLE },
    });
    const schema = ask.api_schema.request_body_schema;
    expect(schema.required).toEqual(["agent", "question", "conversation_id"]);
    expect(schema.properties.agent).toMatchObject({
      type: "string",
      enum: ["executive", "eqstack"],
    });
    expect(schema.properties.agent.description).toBeTruthy();
    expect(schema.properties.conversation_id).toEqual({
      type: "string",
      dynamic_variable: "system__conversation_id",
    });
  });

  it("supported_voices, patient turns, auth ON, recording explicit", () => {
    expect(cc.tts.voice_id).toBe(MEETING_TEST_VOICES.lily);
    expect(cc.tts.supported_voices).toEqual([
      {
        label: "Executive",
        voice_id: MEETING_TEST_VOICES.david,
        description: "George's chief of staff: priorities, commitments, coordination",
        speed: 0.95,
        stability: 0.6,
        similarity_boost: 0.8,
      },
      {
        label: "Eqstack",
        voice_id: MEETING_TEST_VOICES.roger,
        description: "builds the EQ Stack comms apps: imsg, gmail, telephony",
        speed: 1.05,
        stability: 0.7,
        similarity_boost: 0.75,
      },
    ]);
    expect(cc.turn).toEqual({ turn_eagerness: "patient" });
    expect(body.platform_settings).toEqual({
      privacy: { record_voice: false },
      auth: { enable_auth: true },
    });
  });

  it("no phone number anywhere in the brief or the body (INV-11)", () => {
    const cfg = meetingConfig();
    const text = JSON.stringify([buildMeetingBrief(cfg, { recordVoice: true }, null), body]);
    for (const r of Object.values(cfg.recipients)) expect(text).not.toContain(r.number.slice(1));
  });
});

describe("the harness texts (Step 8): tighten the wording, never drop a rule", () => {
  it("MEETING_HARNESS keeps every rule of PHASE-GC § 2", () => {
    const rules: RegExp[] = [
      /live group meeting on a phone line/,
      /You chair the meeting in your own voice/,
      /\{\{meeting_roster\}\}/,
      /wrap only its words in its tag, exactly as written/,
      /Anything untagged is you, the chair/,
      /Never speak as a human/,
      /never nest tags/,
      /a human addressed it by name or by role/,
      /you, the chair, invited it/,
      /nobody has said yet/,
      /Silence is normal on this call/,
      /At most ONE agent speaks per turn/,
      /poll: .* one sentence each, then stop and hand back/,
      /Humans come first/,
      /stop at once and let them finish/,
      /call skip_turn and wait/,
      /choose the one agent best placed to answer, or ask the human/,
      /Never talk over anyone/,
      /never answer a question that was put to someone else/,
      /one to three sentences per agent/,
      /No agent repeats, agrees with, or summarises/,
      /Nobody says 'great point'/,
      /hand the floor back to the humans/,
      /Never end by cueing another agent unless you are running a poll/,
      /call ask_agent with that agent's name/,
      /Do not invent what an agent would say/,
      /'Executive is checking that\.'/,
      /adding nothing it does not say/,
      /pending.*collect_question_id.*at the latest before you close/s,
      /not at its desk and offer to pass the question on/,
      /'Was that for Executive or for EQ Stack\?'/,
    ];
    for (const r of rules) expect(MEETING_HARNESS).toMatch(r);
    expect(MEETING_HARNESS).not.toMatch(/secret__/);
  });

  it("CHAIR_BLOCK: open, keep it moving, close cleanly (collect first, end_call in the same turn)", () => {
    expect(CHAIR_BLOCK).toMatch(/You open the meeting: greet briefly, name who is on the line/);
    expect(CHAIR_BLOCK).toMatch(/state the agenda in one sentence/);
    expect(CHAIR_BLOCK).toMatch(/what was decided and who owns it/);
    expect(CHAIR_BLOCK).toMatch(/collect any pending ask_agent answers first/);
    expect(CHAIR_BLOCK).toMatch(/call end_call in the same turn/);
  });

  it("JOINER_BRIEFING (unused until GC-3): disclosure before audio, rules, press 1", () => {
    expect(JOINER_BRIEFING).toMatch(/automated message on behalf of \{\{convenor\}\}/);
    expect(JOINER_BRIEFING).toMatch(/AI agents: \{\{agent_names\}\}.*synthetic voices/);
    expect(JOINER_BRIEFING).toContain("{{recording_notice}}");
    expect(JOINER_BRIEFING).toMatch(/Reason for the call: \{\{reason\}\}/);
    expect(JOINER_BRIEFING).toMatch(/speak when you are addressed.*let others finish/);
    expect(JOINER_BRIEFING).toMatch(/leave at any time by hanging up/);
    expect(JOINER_BRIEFING).toMatch(/Press 1 to join, or hang up now\.$/);
  });

  it("the first message names the roster through its variable", () => {
    expect(MEETING_FIRST_MESSAGE).toBe(
      "Meeting's open. On the line: {{meeting_roster_names}}. What's first?",
    );
  });
});
