/**
 * Live event feed (Phase G layer 1b) — an async iterator over the gateway's
 * global SSE stream with cursor tracking + reconnect. Injectable fetch (mirrors
 * AdminClient.fetchImpl) so tests need no socket.
 *
 * Two facts about the gateway this is built around (verified, Phase G header):
 *  - `Last-Event-ID` is ignored — reconnect must re-request `?after=<lastId>`.
 *  - `?poll=1` returns a JSON batch for clients that can't hold a stream.
 */
import { GatewayUnavailableError } from "../client/admin-client.js";
import type { CallEvent } from "../domain/types.js";
import { type ParsedFrame, SseParser } from "./sse-parse.js";

export interface EventFeedOptions {
  adminPort: number;
  fetchImpl?: typeof fetch;
  /** Start cursor; the feed advances it as events arrive. */
  after?: number;
  signal?: AbortSignal;
  /** Reconnect backoff bounds. */
  reconnectMs?: number;
  maxReconnectMs?: number;
  /** Surface malformed frames instead of silently dropping them. */
  onMalformed?: (frame: Extract<ParsedFrame, { ok: false }>) => void;
}

/**
 * Yields CallEvents in id order, deduped across reconnects, forever until the
 * signal aborts. Reconnects with backoff on stream end; on connection refusal
 * throws GatewayUnavailableError (a first-class, user-fixable state).
 */
export async function* streamEvents(opts: EventFeedOptions): AsyncGenerator<CallEvent> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = `http://127.0.0.1:${opts.adminPort}`;
  let lastId = opts.after ?? 0;
  let backoff = opts.reconnectMs ?? 500;
  const maxBackoff = opts.maxReconnectMs ?? 10_000;

  while (!opts.signal?.aborted) {
    let res: Response;
    try {
      res = await fetchImpl(`${base}/events?after=${lastId}`, {
        headers: { Accept: "text/event-stream" },
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
    } catch {
      if (opts.signal?.aborted) return;
      throw new GatewayUnavailableError(opts.adminPort);
    }
    if (!res.body) {
      // No stream — fall back to a cursor poll and retry.
      for await (const ev of pollOnce(fetchImpl, base, lastId)) {
        if (ev.id > lastId) lastId = ev.id;
        yield ev;
      }
      await sleep(backoff, opts.signal);
      continue;
    }

    const parser = new SseParser();
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        if (opts.signal?.aborted) return;
        for (const frame of parser.push(chunk)) {
          if (frame.ok) {
            if (frame.event.id <= lastId) continue; // dedupe across reconnect
            lastId = frame.event.id;
            backoff = opts.reconnectMs ?? 500; // healthy stream resets backoff
            yield frame.event;
          } else {
            opts.onMalformed?.(frame);
          }
        }
      }
    } catch {
      if (opts.signal?.aborted) return;
    }
    // Stream ended (server closed or network blip) — reconnect from lastId.
    await sleep(backoff, opts.signal);
    backoff = Math.min(backoff * 2, maxBackoff);
  }
}

async function* pollOnce(
  fetchImpl: typeof fetch,
  base: string,
  after: number,
): AsyncGenerator<CallEvent> {
  const res = await fetchImpl(`${base}/events?poll=1&after=${after}`);
  const body = (await res.json()) as { events?: CallEvent[] };
  for (const ev of body.events ?? []) yield ev;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    t.unref?.();
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });
}
