/**
 * Console renderers (Phase G layer 3) — line functions over the pure call
 * model. The TUI (Phase I) reuses the MODEL and swaps this renderer, so keep
 * the rendering vocabulary (speaker labels, barge-in glyph, latency column)
 * here as the one place it is decided.
 *
 * INV-11: every line carries alias + last four; no line ever prints a full
 * number — the model itself never holds one. Colour degrades to plain text
 * when stdout is not a TTY.
 */
import { color, colorEnabled } from "@george43g/cli-kit";
import type { CallView, TurnView } from "../events/call-model.js";

function stamp(d = new Date()): string {
  return d.toTimeString().slice(0, 8);
}

const paint = {
  dim: (s: string) => (colorEnabled() ? color.dim(s) : s),
  callee: (s: string) => (colorEnabled() ? color.cyan(s) : s),
  agent: (s: string) => (colorEnabled() ? color.green(s) : s),
  warn: (s: string) => (colorEnabled() ? color.yellow(s) : s),
  head: (s: string) => (colorEnabled() ? color.bold(s) : s),
};

export function renderCallHeader(call: CallView): string {
  const who = call.alias ?? "unknown";
  const suffix = call.numberSuffix ? `···${call.numberSuffix}` : "";
  const mode = call.mode ?? "?";
  const live = call.live ? "" : paint.dim(" (no session)");
  return `${paint.dim(stamp())}  ${paint.head(`▸ ${call.callId.slice(0, 8)}`)}  ${who} ${suffix}  ${mode}  ${call.status}${live}`;
}

function legs(t: TurnView): string {
  if (!t.timing) return "";
  const parts: string[] = [];
  if (t.timing.pickupMs !== undefined) parts.push(`pickup ${t.timing.pickupMs}ms`);
  if (t.timing.thinkMs !== undefined) parts.push(`think ${fmtMs(t.timing.thinkMs)}`);
  if (t.timing.egressMs !== undefined) parts.push(`egress ${t.timing.egressMs}ms`);
  const total = fmtMs(t.timing.totalMs);
  const stale = t.timing.stale ? paint.warn(" (stale)") : "";
  return paint.dim(`   ${total}  ${parts.join(" · ")}${stale}`);
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

/** One or more lines for a turn (a thinking marker prints on its own line). */
export function renderTurn(t: TurnView): string[] {
  const lines: string[] = [];
  if (t.speaker === "callee") {
    const body = t.text ?? (t.textPending ? paint.dim("…(text pending)") : "");
    lines.push(`${paint.dim(stamp())}  ${paint.callee("‹callee›")}  ${body}`);
  } else {
    if (t.thinking) {
      lines.push(`${paint.dim(stamp())}  ${paint.dim(`… thinking (${t.thinking})`)}`);
    }
    if (t.interrupted) {
      const after =
        t.interruptedAfterChars !== null ? ` after ${t.interruptedAfterChars} chars` : "";
      lines.push(`${paint.dim(stamp())}  ${paint.warn(`⟂ barge-in${after}`)}`);
    } else {
      const body = t.text ?? (t.textPending ? paint.dim("…(text pending)") : "");
      lines.push(`${paint.dim(stamp())}  ${paint.agent("›agent‹")}  ${body}${legs(t)}`);
    }
  }
  return lines;
}

export function renderNote(callId: string, note: string): string {
  return `${paint.dim(stamp())}  ${paint.dim(`· ${callId.slice(0, 8)} ${note}`)}`;
}
