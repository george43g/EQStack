/**
 * OpenAI-compatible provider clients for media interpretation.
 *
 * Two invocation shapes, both `POST`ed to a configured base URL:
 *   - `transcriptions(file)` → multipart `/audio/transcriptions` (Whisper-style).
 *   - `chatMultimodal({text, images?, audio?})` → `/chat/completions` with base64
 *     `image_url` / `input_audio` content parts (vision + audio understanding).
 *
 * Generalizes the shipped `transcribeAudioCloud` (src/media.ts) — same injectable
 * `fetchImpl` + timeout pattern, so nothing here touches the network in tests.
 * Core-only: no frontend imports, no config reads (callers pass a resolved
 * provider). A future web server reuses this verbatim.
 */
import { basename } from "node:path";

export type ProviderPreset =
  | "openai"
  | "groq"
  | "openrouter"
  | "cloudflare"
  | "huggingface"
  | "ollama";

export interface ProviderCapabilities {
  /** Supports multipart `/audio/transcriptions`. */
  transcribe: boolean;
  /** Supports `/chat/completions` with image content parts. */
  vision: boolean;
  /** Supports `/chat/completions` with `input_audio` content parts. */
  audioChat: boolean;
}

export interface ProviderPresetInfo {
  /** Static base URL, or a builder when an account id is required (Cloudflare). */
  baseUrl: string | ((accountId: string) => string);
  needsAccountId?: boolean;
  needsApiKey: boolean;
  capabilities: ProviderCapabilities;
  defaultModels: { transcribe?: string; vision?: string };
}

/** Known providers. Verify model ids at configuration time — they drift. */
export const PROVIDER_PRESETS: Record<ProviderPreset, ProviderPresetInfo> = {
  openai: {
    baseUrl: "https://api.openai.com/v1",
    needsApiKey: true,
    capabilities: { transcribe: true, vision: true, audioChat: true },
    defaultModels: { transcribe: "whisper-1", vision: "gpt-4o-mini" },
  },
  groq: {
    baseUrl: "https://api.groq.com/openai/v1",
    needsApiKey: true,
    capabilities: { transcribe: true, vision: true, audioChat: false },
    defaultModels: { transcribe: "whisper-large-v3", vision: "llama-3.2-11b-vision-preview" },
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    needsApiKey: true,
    capabilities: { transcribe: false, vision: true, audioChat: true },
    defaultModels: { vision: "google/gemini-2.0-flash-001" },
  },
  cloudflare: {
    baseUrl: (accountId: string) =>
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`,
    needsAccountId: true,
    needsApiKey: true,
    capabilities: { transcribe: true, vision: true, audioChat: false },
    defaultModels: { transcribe: "@cf/openai/whisper", vision: "@cf/llava-hf/llava-1.5-7b-hf" },
  },
  huggingface: {
    baseUrl: "https://router.huggingface.co/v1",
    needsApiKey: true,
    capabilities: { transcribe: false, vision: true, audioChat: false },
    defaultModels: { vision: "Qwen/Qwen2-VL-7B-Instruct" },
  },
  ollama: {
    baseUrl: "http://localhost:11434/v1",
    needsApiKey: false,
    capabilities: { transcribe: false, vision: true, audioChat: false },
    defaultModels: { vision: "llava" },
  },
};

/** A configured provider profile (from app-config; credentials merged in). */
export interface ProviderConfig {
  /** User-chosen name, referenced by chains as `provider:<name>`. */
  name: string;
  preset?: ProviderPreset;
  /** Custom OpenAI-compatible base URL (when no preset). */
  baseUrl?: string;
  /** Cloudflare account id. */
  accountId?: string;
  /** API key (merged from credentials.json / env — never persisted in config). */
  apiKey?: string;
  /** Per-capability model overrides. */
  models?: { transcribe?: string; vision?: string };
}

export interface ResolvedProvider {
  name: string;
  baseUrl: string;
  apiKey?: string;
  capabilities: ProviderCapabilities;
  models: { transcribe?: string; vision?: string };
}

/** Resolve a ProviderConfig into a concrete base URL + capabilities. Throws on misconfig. */
export function resolveProvider(cfg: ProviderConfig): ResolvedProvider {
  const preset = cfg.preset ? PROVIDER_PRESETS[cfg.preset] : undefined;

  let baseUrl: string;
  if (cfg.baseUrl) {
    baseUrl = cfg.baseUrl;
  } else if (preset) {
    if (typeof preset.baseUrl === "function") {
      if (!cfg.accountId)
        throw new Error(`Provider "${cfg.name}" (${cfg.preset}) needs an accountId`);
      baseUrl = preset.baseUrl(cfg.accountId);
    } else {
      baseUrl = preset.baseUrl;
    }
  } else {
    throw new Error(`Provider "${cfg.name}" has neither a preset nor a baseUrl`);
  }
  baseUrl = baseUrl.replace(/\/+$/, "");

  const capabilities = preset?.capabilities ?? { transcribe: true, vision: true, audioChat: true };
  const models = {
    transcribe: cfg.models?.transcribe ?? preset?.defaultModels.transcribe,
    vision: cfg.models?.vision ?? preset?.defaultModels.vision,
  };
  return { name: cfg.name, baseUrl, apiKey: cfg.apiKey, capabilities, models };
}

export interface ProviderClientOpts {
  fetchImpl?: typeof globalThis.fetch;
  timeoutMs?: number;
}

/** MIME → OpenAI `input_audio` format token. */
function audioFormat(mime: string | undefined, filename: string): string {
  const f = (mime ?? "").toLowerCase();
  if (f.includes("mp3") || f.includes("mpeg")) return "mp3";
  if (f.includes("wav")) return "wav";
  if (filename.toLowerCase().endsWith(".mp3")) return "mp3";
  if (filename.toLowerCase().endsWith(".wav")) return "wav";
  return "m4a";
}

export class ProviderError extends Error {}

/** Client for one resolved provider. All network I/O flows through `fetchImpl`. */
export class ProviderClient {
  constructor(
    private readonly provider: ResolvedProvider,
    private readonly opts: ProviderClientOpts = {},
  ) {}

  private headers(json: boolean): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.provider.apiKey) h.Authorization = `Bearer ${this.provider.apiKey}`;
    if (json) h["Content-Type"] = "application/json";
    return h;
  }

  private async post(path: string, init: RequestInit): Promise<Response> {
    const doFetch = this.opts.fetchImpl ?? globalThis.fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 60_000);
    try {
      return await doFetch(`${this.provider.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Multipart audio transcription. Returns the transcript text. */
  async transcriptions(file: { buffer: Buffer; filename: string }): Promise<string> {
    const model = this.provider.models.transcribe;
    if (!model) throw new ProviderError(`Provider "${this.provider.name}" has no transcribe model`);
    const form = new FormData();
    form.append("file", new Blob([file.buffer]), basename(file.filename));
    form.append("model", model);
    form.append("response_format", "text");
    const res = await this.post("/audio/transcriptions", {
      method: "POST",
      headers: this.headers(false),
      body: form,
    });
    if (!res.ok) throw new ProviderError(`transcriptions ${res.status} from ${this.provider.name}`);
    return (await res.text()).trim();
  }

  /**
   * Multimodal chat completion. Combines an instruction with optional images
   * (base64 `image_url`) and one audio clip (base64 `input_audio`). Returns the
   * assistant text (a caption / description / transcript, per the prompt).
   */
  async chatMultimodal(input: {
    text: string;
    images?: Buffer[];
    audio?: { buffer: Buffer; mime?: string; filename: string };
    model?: string;
  }): Promise<string> {
    const model = input.model ?? this.provider.models.vision;
    if (!model) throw new ProviderError(`Provider "${this.provider.name}" has no vision model`);

    const content: Record<string, unknown>[] = [{ type: "text", text: input.text }];
    for (const img of input.images ?? []) {
      content.push({
        type: "image_url",
        image_url: { url: `data:image/jpeg;base64,${img.toString("base64")}` },
      });
    }
    if (input.audio) {
      content.push({
        type: "input_audio",
        input_audio: {
          data: input.audio.buffer.toString("base64"),
          format: audioFormat(input.audio.mime, input.audio.filename),
        },
      });
    }

    const res = await this.post("/chat/completions", {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({ model, messages: [{ role: "user", content }] }),
    });
    if (!res.ok) throw new ProviderError(`chat ${res.status} from ${this.provider.name}`);
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const out = json.choices?.[0]?.message?.content?.trim();
    if (!out) throw new ProviderError(`empty chat response from ${this.provider.name}`);
    return out;
  }
}
