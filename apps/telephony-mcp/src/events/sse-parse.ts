/**
 * Incremental SSE parser (Phase G layer 1) — pure, no I/O, no terminal deps,
 * so the TUI (Phase I) and web SPA (Phase J) parse the same stream.
 *
 * The bug this exists to stop: today's `tel watch` writes bytes straight
 * through (`cli.ts`), so a frame split across a chunk boundary — or inside a
 * UTF-8 sequence — has never been handled. This buffers the tail, splits only
 * on the blank-line terminator, and decodes with a streaming TextDecoder so a
 * multibyte char cut in half survives. A malformed `data:` yields a typed
 * failure rather than throwing or vanishing (same posture as parseRelayMessage).
 */
import { CallEventSchema } from "../commands/contracts.js";
import type { CallEvent } from "../domain/types.js";

export type ParsedFrame =
  | { ok: true; event: CallEvent }
  | { ok: false; raw: string; error: string };

export class SseParser {
  private buffer = "";
  private decoder = new TextDecoder();

  /** Feed a chunk (or a string in tests); yields every complete frame in it. */
  push(chunk: Uint8Array | string): ParsedFrame[] {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    const out: ParsedFrame[] = [];
    let sep = this.findSeparator();
    while (sep !== -1) {
      const frame = this.buffer.slice(0, sep.index);
      this.buffer = this.buffer.slice(sep.index + sep.length);
      const parsed = this.parseFrame(frame);
      if (parsed) out.push(parsed);
      sep = this.findSeparator();
    }
    return out;
  }

  /** Accepts \n\n and \r\n\r\n frame terminators. */
  private findSeparator(): { index: number; length: number } | -1 {
    const lf = this.buffer.indexOf("\n\n");
    const crlf = this.buffer.indexOf("\r\n\r\n");
    if (lf === -1 && crlf === -1) return -1;
    if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 };
    return { index: lf, length: 2 };
  }

  private parseFrame(frame: string): ParsedFrame | null {
    const dataLines: string[] = [];
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith(":")) continue; // SSE comment / keepalive
      if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
      // id:/event:/retry: are consumed by the feed layer, not here.
    }
    if (dataLines.length === 0) return null;
    const raw = dataLines.join("\n");
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      return { ok: false, raw, error: `invalid JSON: ${(err as Error).message}` };
    }
    const result = CallEventSchema.safeParse(json);
    if (!result.success) {
      return { ok: false, raw, error: result.error.issues[0]?.message ?? "schema mismatch" };
    }
    return { ok: true, event: result.data };
  }
}
