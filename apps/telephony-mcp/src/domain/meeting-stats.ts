/**
 * `meetingTurnStats` — the social-skills measure for Steps 9 and 10 of
 * PHASE-GC. PURE: a transcript in, counts out.
 *
 * Each agent turn is split into segments: text inside `<Label>…</Label>` is
 * that persona's, anything untagged is the chair's. A persona segment is
 * UNSOLICITED when, since the last human turn, the human named neither that
 * persona (by label or display name) nor the room ("everyone", "all of you",
 * …), and the chair did not name it earlier in the same stretch of agent
 * speech — rule (1)/(2) of MEETING_HARNESS failing. Rule (3), unique
 * information, cannot be judged from text; an unsolicited count is therefore
 * an upper bound on real violations, which is the safe direction for a gate.
 *
 * Whether EL's stored transcript keeps the voice tags is UNKNOWN (O-47):
 * `tagged: false` on a real transcript means per-persona attribution needs
 * another source, and every segment is then counted as the chair's.
 */

export interface StatsTranscriptItem {
  role: "user" | "agent";
  text: string | null;
}

export interface StatsPersona {
  label: string;
  displayName: string;
}

export interface MeetingSegment {
  /** Index into the transcript. */
  turn: number;
  /** A persona label, or "chair" for untagged speech. */
  speaker: string;
  text: string;
  unsolicited: boolean;
}

export interface MeetingTurnStats {
  /** Agent transcript items that carried text. */
  agentTurns: number;
  /** Whether any known persona tag appeared at all (O-47). */
  tagged: boolean;
  segments: MeetingSegment[];
  perPersona: Record<string, { segments: number; unsolicited: number }>;
  chairSegments: number;
  unsolicited: number;
  /** Agent turns in which more than one persona spoke (only a poll may do this). */
  multiPersonaTurns: number;
}

const ROOM_PATTERNS = [
  /\beveryone\b/i,
  /\beverybody\b/i,
  /\ball of you\b/i,
  /\beach of you\b/i,
  /\byou all\b/i,
  /\bthe room\b/i,
  /\bthe team\b/i,
  /\bpoll\b/i,
];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function names(text: string, p: StatsPersona): boolean {
  return [p.label, p.displayName].some((n) =>
    new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(n)}($|[^\\p{L}\\p{N}])`, "iu").test(text),
  );
}

/** Split one agent turn into ordered (speaker, text) segments. Unknown tags stay as text. */
export function splitSegments(
  text: string,
  labels: readonly string[],
): Array<{ speaker: string; text: string }> {
  const out: Array<{ speaker: string; text: string }> = [];
  if (labels.length === 0) return text.trim() ? [{ speaker: "chair", text: text.trim() }] : [];
  const alt = labels.map(escapeRe).join("|");
  const re = new RegExp(`<(${alt})>([\\s\\S]*?)</\\1>`, "g");
  let at = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const before = text.slice(at, m.index).trim();
    if (before) out.push({ speaker: "chair", text: before });
    const inner = (m[2] ?? "").trim();
    if (inner) out.push({ speaker: m[1] as string, text: inner });
    at = m.index + m[0].length;
  }
  const rest = text.slice(at).trim();
  if (rest) out.push({ speaker: "chair", text: rest });
  return out;
}

export function meetingTurnStats(
  transcript: readonly StatsTranscriptItem[],
  personas: readonly StatsPersona[],
): MeetingTurnStats {
  const labels = personas.map((p) => p.label);
  const byLabel = new Map(personas.map((p) => [p.label, p]));
  const perPersona: MeetingTurnStats["perPersona"] = Object.fromEntries(
    labels.map((l) => [l, { segments: 0, unsolicited: 0 }]),
  );
  const segments: MeetingSegment[] = [];
  let lastHuman = "";
  /** Chair text since the last human turn: an invitation there counts for later agent items too. */
  let chairSinceHuman = "";
  let agentTurns = 0;
  let multiPersonaTurns = 0;
  transcript.forEach((item, turn) => {
    const text = item.text ?? "";
    if (!text.trim()) return;
    if (item.role === "user") {
      lastHuman = text;
      chairSinceHuman = "";
      return;
    }
    agentTurns += 1;
    const speakers = new Set<string>();
    for (const seg of splitSegments(text, labels)) {
      if (seg.speaker === "chair") {
        chairSinceHuman += ` ${seg.text}`;
        segments.push({ turn, speaker: "chair", text: seg.text, unsolicited: false });
        continue;
      }
      speakers.add(seg.speaker);
      const p = byLabel.get(seg.speaker) as StatsPersona;
      const solicited =
        names(lastHuman, p) ||
        ROOM_PATTERNS.some((r) => r.test(lastHuman)) ||
        names(chairSinceHuman, p);
      const stat = perPersona[seg.speaker] as { segments: number; unsolicited: number };
      stat.segments += 1;
      if (!solicited) stat.unsolicited += 1;
      segments.push({ turn, speaker: seg.speaker, text: seg.text, unsolicited: !solicited });
    }
    if (speakers.size > 1) multiPersonaTurns += 1;
  });
  return {
    agentTurns,
    tagged: segments.some((s) => s.speaker !== "chair"),
    segments,
    perPersona,
    chairSegments: segments.filter((s) => s.speaker === "chair").length,
    unsolicited: segments.filter((s) => s.unsolicited).length,
    multiPersonaTurns,
  };
}
