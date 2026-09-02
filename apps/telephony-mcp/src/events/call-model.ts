/**
 * Call-view reducer (Phase G layer 2) — pure (state, CallEvent) => state, no
 * I/O, no terminal deps. The TUI (Phase I) and web SPA (Phase J) run this same
 * reducer over the same events; if either re-implements it, the seam failed.
 *
 * INV-6: events arrive as Record<string, unknown>; every field is read through
 * a Zod parse, never indexed blindly.
 *
 * Text hydration is NOT done here (finding 1: assistant text never rides the
 * stream, and the user side only in direct mode). The reducer records which
 * turns still need text in `pendingText`; the feed layer fetches the transcript
 * and feeds utterances back through `applyUtterances`, keeping this pure.
 */
import { z } from "zod";
import type { CallEvent, CallMode, Utterance } from "../domain/types.js";

export type Speaker = "callee" | "agent";

export interface TurnView {
  turn: number;
  speaker: Speaker;
  text: string | null;
  /** True when text is expected but not yet hydrated (finding 1). */
  textPending: boolean;
  interrupted: boolean;
  interruptedAfterChars: number | null;
  /** Phase E leg breakdown, present once turn.timing arrives. */
  timing: {
    pickupMs?: number;
    thinkMs?: number;
    egressMs?: number;
    totalMs: number;
    stale?: boolean;
  } | null;
  /** Phase F marker slot — rendered once thinking.* events exist. */
  thinking: string | null;
}

export interface CallView {
  callId: string;
  alias: string | null;
  numberSuffix: string | null;
  mode: CallMode | null;
  status: string;
  live: boolean;
  recording: boolean;
  turns: TurnView[];
  /** Terse status annotations (errors, fallbacks, disclosure). */
  notes: string[];
}

export interface ModelState {
  calls: Map<string, CallView>;
  /** Turns awaiting transcript hydration, for the feed layer. */
  pendingText: Array<{ callId: string; turn: number }>;
}

export function initialState(): ModelState {
  return { calls: new Map(), pendingText: [] };
}

const NumField = z.object({ turn: z.number().int() });
const UserData = z.object({ turn: z.number().int(), text: z.string().optional() });
const AsstData = z.object({
  turn: z.number().int(),
  interrupted: z.boolean().optional(),
  verbatim: z.boolean().optional(),
});
const InterruptData = z.object({ turn: z.number().int(), spokenChars: z.number().optional() });
const TimingData = z.object({
  turn: z.number().int(),
  mode: z.string().optional(),
  pickupMs: z.number().optional(),
  thinkMs: z.number().optional(),
  egressMs: z.number().optional(),
  totalMs: z.number(),
  stale: z.boolean().optional(),
});
const CreatedData = z.object({
  recipient: z.string().optional(),
  suffix: z.string().optional(),
});

function ensureCall(state: ModelState, callId: string): CallView {
  let c = state.calls.get(callId);
  if (!c) {
    c = {
      callId,
      alias: null,
      numberSuffix: null,
      mode: null,
      status: "created",
      live: false,
      recording: false,
      turns: [],
      notes: [],
    };
    state.calls.set(callId, c);
  }
  return c;
}

function turnOf(call: CallView, turn: number, speaker: Speaker): TurnView {
  let t = call.turns.find((x) => x.turn === turn && x.speaker === speaker);
  if (!t) {
    t = {
      turn,
      speaker,
      text: null,
      textPending: false,
      interrupted: false,
      interruptedAfterChars: null,
      timing: null,
      thinking: null,
    };
    call.turns.push(t);
    call.turns.sort((a, b) => a.turn - b.turn || (a.speaker === "callee" ? -1 : 1));
  }
  return t;
}

export function reduce(state: ModelState, ev: CallEvent): ModelState {
  const call = ensureCall(state, ev.callId);

  if (ev.type === "call.created") {
    const d = CreatedData.safeParse(ev.data);
    if (d.success) {
      call.alias = d.data.recipient ?? call.alias;
      call.numberSuffix = d.data.suffix ?? call.numberSuffix;
    }
    call.status = "created";
  } else if (ev.type.startsWith("call.")) {
    call.status = ev.type.slice("call.".length);
    if (call.status === "ended" || call.status === "failed") call.live = false;
  } else if (ev.type === "session.setup") {
    call.live = true;
  } else if (ev.type === "session.closed") {
    call.live = false;
  } else if (ev.type === "turn.user") {
    const d = UserData.safeParse(ev.data);
    if (d.success) {
      const t = turnOf(call, d.data.turn, "callee");
      if (d.data.text !== undefined) {
        t.text = d.data.text; // direct mode inlines it
      } else {
        t.textPending = true; // llm mode: fetch from transcript
        state.pendingText.push({ callId: ev.callId, turn: d.data.turn });
      }
      if (call.mode === null && d.data.text !== undefined) call.mode = "direct";
    }
  } else if (ev.type === "turn.assistant") {
    const d = AsstData.safeParse(ev.data);
    if (d.success) {
      const t = turnOf(call, d.data.turn, "agent");
      t.textPending = true; // finding 1: agent text never on the stream
      t.interrupted = d.data.interrupted ?? t.interrupted;
      state.pendingText.push({ callId: ev.callId, turn: d.data.turn });
    }
  } else if (ev.type === "turn.interrupted") {
    const d = InterruptData.safeParse(ev.data);
    if (d.success) {
      const t = turnOf(call, d.data.turn, "agent");
      t.interrupted = true;
      t.interruptedAfterChars = d.data.spokenChars ?? null;
    }
  } else if (ev.type === "turn.timing") {
    const d = TimingData.safeParse(ev.data);
    if (d.success) {
      const t = turnOf(call, d.data.turn, "agent");
      t.timing = {
        ...(d.data.pickupMs !== undefined ? { pickupMs: d.data.pickupMs } : {}),
        ...(d.data.thinkMs !== undefined ? { thinkMs: d.data.thinkMs } : {}),
        ...(d.data.egressMs !== undefined ? { egressMs: d.data.egressMs } : {}),
        totalMs: d.data.totalMs,
        ...(d.data.stale ? { stale: true } : {}),
      };
    }
  } else if (ev.type.startsWith("thinking.")) {
    // Phase F slot — render whatever stage marker it carries.
    const d = NumField.safeParse(ev.data);
    if (d.success) turnOf(call, d.data.turn, "agent").thinking = ev.type.slice("thinking.".length);
  } else if (ev.type === "recording.started") {
    call.recording = true;
    call.notes.push("recording started");
  } else if (ev.type === "recording.stopped") {
    call.recording = false;
    call.notes.push("recording stopped");
  } else if (ev.type === "disclosure.played") {
    call.notes.push("disclosure played");
  } else if (ev.type === "llm.error" || ev.type === "session.provider_error") {
    call.notes.push(ev.type);
  } else if (ev.type === "llm.fallback") {
    call.notes.push("llm fallback");
  }
  return state;
}

/** Hydrate pending turn text from a transcript fetch (feed layer input). */
export function applyUtterances(
  state: ModelState,
  callId: string,
  utterances: Utterance[],
): ModelState {
  const call = state.calls.get(callId);
  if (!call) return state;
  for (const u of utterances) {
    const speaker: Speaker = u.role === "user" ? "callee" : "agent";
    const t = call.turns.find((x) => x.turn === u.turn && x.speaker === speaker);
    if (t && t.text === null) {
      t.text = u.text;
      t.textPending = false;
    }
  }
  state.pendingText = state.pendingText.filter(({ callId: c, turn }) => {
    const cv = state.calls.get(c);
    return cv?.turns.some((x) => x.turn === turn && x.textPending);
  });
  return state;
}
