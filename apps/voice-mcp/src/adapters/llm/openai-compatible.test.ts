/**
 * Contract tests against captured-shape OpenRouter SSE fixtures: token
 * deltas, comment keep-alive frames, [DONE], interruption aborts, mid-stream
 * errors, and fallback-model behavior.
 */
import { describe, expect, it } from "vitest";
import type { LlmStreamRequest } from "../../domain/ports.js";
import { LlmError, OpenAiCompatibleLlm } from "./openai-compatible.js";
import { parseSseData } from "./sse.js";

function sseBody(frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(f));
      controller.close();
    },
  });
}

function delta(content: string, model = "primary-model"): string {
  return `data: ${JSON.stringify({ id: "gen1", model, choices: [{ delta: { content } }] })}\n\n`;
}

const DONE = "data: [DONE]\n\n";
const COMMENT = ": OPENROUTER PROCESSING\n\n";

function makeLlm(responses: Array<() => Response>): {
  llm: OpenAiCompatibleLlm;
  requests: Array<{ url: string; body: Record<string, unknown> }>;
} {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const queue = [...responses];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(url),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    const next = queue.shift();
    if (!next) throw new Error("no scripted response left");
    return next();
  }) as typeof fetch;
  const llm = new OpenAiCompatibleLlm({
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "sk-or-v1-test",
    headers: {},
    timeoutMs: 5_000,
    temperature: 0.7,
    maxTokens: 256,
    fetchImpl,
  });
  return { llm, requests };
}

function req(overrides: Partial<LlmStreamRequest> = {}): LlmStreamRequest {
  return {
    messages: [{ role: "user", content: "hello" }],
    model: "primary-model",
    fallbackModel: "fallback-model",
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function collect(gen: AsyncGenerator<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const t of gen) out.push(t);
  return out;
}

describe("SSE parser", () => {
  it("skips comment keep-alive frames and handles chunk splits mid-line", async () => {
    const frames = [": OPENROUTER", ' PROCESSING\n\ndata: {"a":', "1}\n\n", "data: [DONE]\n\n"];
    const out: string[] = [];
    const encoder = new TextEncoder();
    async function* chunks() {
      for (const f of frames) yield encoder.encode(f);
    }
    for await (const d of parseSseData(chunks())) out.push(d);
    expect(out).toEqual(['{"a":1}', "[DONE]"]);
  });

  it("handles CRLF line endings", async () => {
    const encoder = new TextEncoder();
    async function* chunks() {
      yield encoder.encode('data: {"x":2}\r\n\r\n');
    }
    const out: string[] = [];
    for await (const d of parseSseData(chunks())) out.push(d);
    expect(out).toEqual(['{"x":2}']);
  });
});

describe("OpenAI-compatible streaming adapter", () => {
  it("streams token deltas and stops at [DONE]", async () => {
    const { llm, requests } = makeLlm([
      () => new Response(sseBody([COMMENT, delta("Hel"), delta("lo"), DONE]), { status: 200 }),
    ]);
    expect(await collect(llm.stream(req()))).toEqual(["Hel", "lo"]);
    expect(requests[0]?.body.stream).toBe(true);
    expect(requests[0]?.body.model).toBe("primary-model");
  });

  it("returns cleanly when aborted mid-stream (barge-in) without throwing", async () => {
    const abort = new AbortController();
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        controller.enqueue(encoder.encode(delta("tok")));
        await new Promise((r) => setTimeout(r, 5));
      },
      cancel() {},
    });
    const { llm } = makeLlm([() => new Response(body, { status: 200 })]);
    const out: string[] = [];
    const gen = llm.stream(req({ signal: abort.signal }));
    for await (const t of gen) {
      out.push(t);
      if (out.length === 3) abort.abort();
    }
    expect(out.length).toBeGreaterThanOrEqual(3);
  });

  it("falls back to the fallback model when the primary fails before any token", async () => {
    const fallbacks: string[] = [];
    const { llm, requests } = makeLlm([
      () => new Response("upstream unavailable", { status: 502 }),
      () => new Response(sseBody([delta("ok", "fallback-model"), DONE]), { status: 200 }),
    ]);
    const out = await collect(
      llm.stream(req({ onFallback: (from, to) => fallbacks.push(`${from}→${to}`) })),
    );
    expect(out).toEqual(["ok"]);
    expect(fallbacks).toEqual(["primary-model→fallback-model"]);
    expect(requests.map((r) => r.body.model)).toEqual(["primary-model", "fallback-model"]);
  });

  it("does NOT fall back after tokens were already spoken — the error propagates", async () => {
    const midStreamError = `data: ${JSON.stringify({ error: { message: "boom" } })}\n\n`;
    const { llm, requests } = makeLlm([
      () => new Response(sseBody([delta("partial"), midStreamError]), { status: 200 }),
      () => new Response(sseBody([delta("should-not-run"), DONE]), { status: 200 }),
    ]);
    const out: string[] = [];
    await expect(async () => {
      for await (const t of llm.stream(req())) out.push(t);
    }).rejects.toThrow(LlmError);
    expect(out).toEqual(["partial"]);
    expect(requests).toHaveLength(1);
  });

  it("propagates the failure when no fallback model is configured", async () => {
    const { llm } = makeLlm([() => new Response("nope", { status: 500 })]);
    await expect(collect(llm.stream(req({ fallbackModel: undefined })))).rejects.toThrow(LlmError);
  });

  it("sends no Authorization header for keyless local endpoints (Ollama)", async () => {
    const seen: Array<Record<string, string>> = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      seen.push({ ...((init?.headers ?? {}) as Record<string, string>) });
      return new Response(sseBody([DONE]), { status: 200 });
    }) as typeof fetch;
    const llm = new OpenAiCompatibleLlm({
      baseUrl: "http://localhost:11434/v1",
      apiKey: null,
      headers: {},
      timeoutMs: 5_000,
      temperature: 0.7,
      maxTokens: 256,
      fetchImpl,
    });
    await collect(llm.stream(req({ fallbackModel: undefined })));
    expect(seen[0]?.Authorization).toBeUndefined();
  });
});
