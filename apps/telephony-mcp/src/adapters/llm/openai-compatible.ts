/**
 * OpenAI-compatible streaming adapter — v1 target is OpenRouter; switching
 * to Ollama is config only (baseUrl http://localhost:11434/v1, local model,
 * apiKeyRef: null).
 *
 * Streaming contract: yield text deltas as they arrive; abort IMMEDIATELY on
 * the caller's signal (barge-in); if the PRIMARY model fails before any
 * token, retry once on the fallback model; failures after tokens have been
 * yielded propagate (the session ends the turn safely).
 */
import type { LlmAdapter, LlmStreamRequest } from "../../domain/ports.js";
import { parseSseData } from "./sse.js";

export class LlmError extends Error {}

export interface OpenAiCompatibleOptions {
  baseUrl: string;
  apiKey: string | null;
  headers: Record<string, string>;
  timeoutMs: number;
  temperature: number;
  maxTokens: number;
  fetchImpl?: typeof fetch;
}

interface StreamChunk {
  choices?: Array<{ delta?: { content?: string | null }; finish_reason?: string | null }>;
  error?: { message?: string };
}

export class OpenAiCompatibleLlm implements LlmAdapter {
  readonly id = "openai-compatible";
  private fetchImpl: typeof fetch;

  constructor(private opts: OpenAiCompatibleOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async *stream(req: LlmStreamRequest): AsyncGenerator<string, void, unknown> {
    const fallback = req.fallbackModel;
    let yieldedAny = false;
    try {
      for await (const token of this.streamModel(req.model, req)) {
        yieldedAny = true;
        yield token;
      }
      return;
    } catch (err) {
      if (req.signal.aborted) return;
      // Fall back only when the primary produced nothing — retrying after
      // spoken tokens would repeat content into the live call.
      if (yieldedAny || !fallback) throw err;
      req.onFallback?.(req.model, fallback, (err as Error).message);
    }
    yield* this.streamModel(fallback, req);
  }

  /** Stream a single model. Throws LlmError before the first token on HTTP/stream failure. */
  private async *streamModel(
    model: string,
    req: LlmStreamRequest,
  ): AsyncGenerator<string, void, unknown> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.opts.headers,
    };
    if (this.opts.apiKey) headers.Authorization = `Bearer ${this.opts.apiKey}`;

    const timeout = AbortSignal.timeout(this.opts.timeoutMs);
    const signal = AbortSignal.any([req.signal, timeout]);

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.opts.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers,
        signal,
        body: JSON.stringify({
          model,
          messages: req.messages,
          stream: true,
          temperature: this.opts.temperature,
          max_tokens: this.opts.maxTokens,
        }),
      });
    } catch (err) {
      if (req.signal.aborted) return;
      throw new LlmError(`LLM request failed (${model}): ${(err as Error).message}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new LlmError(`LLM HTTP ${res.status} (${model}): ${text.slice(0, 300)}`);
    }
    if (!res.body) throw new LlmError(`LLM response had no body (${model})`);

    try {
      for await (const data of parseSseData(res.body as unknown as AsyncIterable<Uint8Array>)) {
        if (req.signal.aborted) return;
        if (data === "[DONE]") return;
        let chunk: StreamChunk;
        try {
          chunk = JSON.parse(data) as StreamChunk;
        } catch {
          continue; // tolerate malformed keep-alive-ish frames
        }
        if (chunk.error?.message)
          throw new LlmError(`LLM mid-stream error: ${chunk.error.message}`);
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      }
    } catch (err) {
      if (req.signal.aborted) return;
      throw err instanceof LlmError
        ? err
        : new LlmError(`LLM stream failed: ${(err as Error).message}`);
    }
  }
}
