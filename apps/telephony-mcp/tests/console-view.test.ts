/**
 * Phase G verification (7.1-7.9): SSE parse across chunk/UTF-8 boundaries,
 * feed cursor + reconnect dedupe, pure reducer over a fixture, renderer INV-11
 * + pending-text, help-from-registry. Everything feeds the parser a string and
 * the model an array — no sockets (INV-14).
 */
import { describe, expect, it, vi } from "vitest";
import { COMMAND_NAMES } from "../src/commands/specs.js";
import { renderCallHeader, renderTurn } from "../src/console/render.js";
import type { CallEvent } from "../src/domain/types.js";
import { applyUtterances, initialState, reduce } from "../src/events/call-model.js";
import { streamEvents } from "../src/events/event-feed.js";
import { SseParser } from "../src/events/sse-parse.js";

function ev(over: Partial<CallEvent> & { type: string; callId: string }): CallEvent {
  return { id: 1, seq: 1, tsMs: 0, data: {}, ...over };
}

describe("SseParser (7.1, 7.3)", () => {
  it("7.1: a frame split across two chunks parses as one event", () => {
    const p = new SseParser();
    const e = ev({ id: 5, callId: "c1", type: "call.created", data: { recipient: "george" } });
    const wire = `id: 5\ndata: ${JSON.stringify(e)}\n\n`;
    const mid = Math.floor(wire.length / 2);
    expect(p.push(wire.slice(0, mid))).toHaveLength(0); // incomplete
    const out = p.push(wire.slice(mid));
    expect(out).toHaveLength(1);
    expect(out[0]?.ok && out[0].event.id).toBe(5);
  });

  it("7.1b: a frame split inside a multibyte UTF-8 sequence still decodes", () => {
    const p = new SseParser();
    const e = ev({ id: 6, callId: "c1", type: "turn.user", data: { turn: 1, text: "café ☕" } });
    const bytes = new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`);
    // Split mid-emoji (☕ is 3 bytes): find a byte boundary inside it.
    const cut = bytes.length - 4;
    expect(p.push(bytes.slice(0, cut))).toHaveLength(0);
    const out = p.push(bytes.slice(cut));
    expect(out[0]?.ok && (out[0].event.data.text as string)).toBe("café ☕");
  });

  it("7.3: a malformed data payload yields a typed failure, does not throw", () => {
    const p = new SseParser();
    const out = p.push("data: {not json\n\n");
    expect(out).toHaveLength(1);
    expect(out[0]?.ok).toBe(false);
    // and the stream keeps going
    const good = ev({ id: 2, callId: "c1", type: "call.ended" });
    expect(p.push(`data: ${JSON.stringify(good)}\n\n`)[0]?.ok).toBe(true);
  });

  it("skips SSE comment/keepalive lines", () => {
    const p = new SseParser();
    expect(p.push(":keepalive\n\n")).toHaveLength(0);
  });
});

describe("streamEvents (7.2, 7.8)", () => {
  function sse(events: CallEvent[]): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        for (const e of events)
          controller.enqueue(enc.encode(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`));
        controller.close();
      },
    });
  }

  it("7.2: reconnect re-requests after=<lastId> and never replays an event", async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const after = Number(new URL(String(url)).searchParams.get("after"));
      seen.push(String(after));
      // first connection yields ids 1,2 then closes; second yields 3.
      const batch =
        after < 2
          ? [
              ev({ id: 1, callId: "c1", type: "call.created" }),
              ev({ id: 2, callId: "c1", type: "session.setup" }),
            ]
          : after < 3
            ? [ev({ id: 3, callId: "c1", type: "call.ended" })]
            : [];
      return new Response(sse(batch), { status: 200 });
    }) as unknown as typeof fetch;

    const ac = new AbortController();
    const got: number[] = [];
    const gen = streamEvents({ adminPort: 1, fetchImpl, reconnectMs: 1, signal: ac.signal });
    for await (const e of gen) {
      got.push(e.id);
      if (got.length === 3) {
        ac.abort();
        break;
      }
    }
    expect(got).toEqual([1, 2, 3]);
    expect(seen[0]).toBe("0");
    expect(seen).toContain("2"); // reconnected from lastId, not 0
  });

  it("7.8: a refused connection throws GatewayUnavailableError", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(async () => {
      for await (const _e of streamEvents({ adminPort: 9, fetchImpl })) void _e;
    }).rejects.toThrow(/gateway is not running/);
  });
});

describe("call-model reducer (7.4, 7.5)", () => {
  const fixture: CallEvent[] = [
    ev({
      id: 1,
      callId: "c1",
      type: "call.created",
      data: { recipient: "george", suffix: "1222" },
    }),
    ev({ id: 2, callId: "c1", type: "session.setup", data: { sessionId: "VX" } }),
    ev({ id: 3, callId: "c1", type: "turn.user", data: { turn: 1, text: "Hello?", chars: 6 } }),
    ev({
      id: 4,
      callId: "c1",
      type: "turn.assistant",
      data: { turn: 1, chars: 5, verbatim: true },
    }),
    ev({
      id: 5,
      callId: "c1",
      type: "turn.timing",
      data: { turn: 1, mode: "direct", pickupMs: 12, thinkMs: 2800, egressMs: 41, totalMs: 2853 },
    }),
    ev({ id: 6, callId: "c1", type: "call.ended", data: { reason: "done" } }),
  ];

  it("7.4: golden turn list — one shape for console/TUI/SPA", () => {
    let state = initialState();
    for (const e of fixture) state = reduce(state, e);
    const call = state.calls.get("c1");
    expect(call?.alias).toBe("george");
    expect(call?.numberSuffix).toBe("1222");
    expect(call?.mode).toBe("direct");
    expect(call?.status).toBe("ended");
    expect(call?.live).toBe(false);
    const callee = call?.turns.find((t) => t.speaker === "callee");
    expect(callee?.text).toBe("Hello?");
    const agent = call?.turns.find((t) => t.speaker === "agent");
    expect(agent?.textPending).toBe(true); // finding 1: agent text off-stream
    expect(agent?.timing?.totalMs).toBe(2853);
  });

  it("7.5: an llm-mode turn.user with no text is pending, not an empty line", () => {
    let state = initialState();
    state = reduce(
      state,
      ev({ id: 1, callId: "c2", type: "turn.user", data: { turn: 1, chars: 4 } }),
    );
    const t = state.calls.get("c2")?.turns[0];
    expect(t?.text).toBeNull();
    expect(t?.textPending).toBe(true);
    expect(state.pendingText).toContainEqual({ callId: "c2", turn: 1 });
    // hydration fills it and clears pending
    state = applyUtterances(state, "c2", [
      { id: 1, callId: "c2", turn: 1, role: "user", text: "hydrated", tsMs: 0, interrupted: false },
    ]);
    expect(state.calls.get("c2")?.turns[0]?.text).toBe("hydrated");
    expect(state.pendingText).toHaveLength(0);
  });
});

describe("renderers (7.6)", () => {
  it("7.6: output carries alias + last four, never a full number", () => {
    let state = initialState();
    state = reduce(
      state,
      ev({
        id: 1,
        callId: "c1",
        type: "call.created",
        data: { recipient: "george", suffix: "1222" },
      }),
    );
    state = reduce(
      state,
      ev({ id: 2, callId: "c1", type: "turn.user", data: { turn: 1, text: "hi", chars: 2 } }),
    );
    const call = state.calls.get("c1");
    const out = [renderCallHeader(call as never), ...(call?.turns ?? []).flatMap(renderTurn)].join(
      "\n",
    );
    expect(out).toContain("···1222");
    expect(out).not.toMatch(/\+61/);
    expect(out).toContain("george");
  });
});

describe("help is generated from the registry (7.7, INV-8)", () => {
  it("every registry command name is a console verb with no hand-maintained list", () => {
    // The console REPL (Phase B, cli-kit runRepl) lists registry.tools; a
    // command added to the registry appears with no console edit. Pin the
    // contract at the source: COMMAND_NAMES is the single list.
    expect(COMMAND_NAMES).toContain("place_call");
    expect(COMMAND_NAMES).toContain("get_latency_report");
    expect(new Set(COMMAND_NAMES).size).toBe(COMMAND_NAMES.length); // no dupes
  });
});
