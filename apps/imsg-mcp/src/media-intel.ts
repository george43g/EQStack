/**
 * Media interpretation service — the single core entry point that every frontend
 * (MCP / CLI / TUI / future web) calls to turn an attachment into text.
 *
 * Walks a configured, per-media-type CHAIN of links:
 *   - `apple`          → the iOS-synced transcript already on the Message (free, instant)
 *   - `local`          → on-device transcribers (hear/yap/whisper-cli — free)
 *   - `provider:<name>`→ an OpenAI-compatible transcription / vision call (paid, opt-in)
 *
 * Results are cached forever (media-intel-cache) so the same file is never
 * interpreted twice, and in-flight calls for the same key are de-duped. An
 * auto-mode gate (all/free/off) decides whether paid links may run automatically.
 *
 * Core-only: no frontend imports. Network + exec are injectable for tests.
 */
import { readFileSync, statSync } from "node:fs";
import {
  type ImageBlockData,
  imageBlockFromFile,
  transcribeAudio,
  videoPosterFrame,
} from "./media.js";
import {
  fileSignature,
  lookupMediaIntel,
  type MediaIntelRecord,
  type MediaKind,
  storeMediaIntel,
} from "./media-intel-cache.js";
import {
  ProviderClient,
  type ProviderClientOpts,
  type ProviderConfig,
  resolveProvider,
} from "./media-providers.js";

export type AutoMode = "all" | "free" | "off";

export interface InterpretChains {
  audio: string[];
  image: string[];
  video: string[];
}

export interface InterpretConfig {
  auto: AutoMode;
  chains: InterpretChains;
  providers: ProviderConfig[];
}

/** Sensible free-first defaults when nothing is configured yet. */
export const DEFAULT_CHAINS: InterpretChains = {
  audio: ["apple", "local"],
  image: [],
  video: [],
};

export interface AttachmentRef {
  /** Stable cache key — the attachment guid, or `att:<rowId>`. */
  key: string;
  path: string;
  mime: string | null;
  filename: string;
  kind: MediaKind;
  /** Apple's synced voice-note transcript (Stage 1), for the `apple` link. */
  appleTranscript?: string | null;
}

export interface InterpretResult {
  status: "done" | "failed" | "skipped" | "pending";
  text: string | null;
  source: string | null;
  model: string | null;
  extra?: Record<string, unknown> | null;
  cached: boolean;
  error?: string;
}

/** Injectable dependencies (tests stub the exec/network pieces). */
export interface MediaIntelDeps {
  fetchImpl?: typeof globalThis.fetch;
  timeoutMs?: number;
  transcribeLocal?: (path: string) => string | null;
  readImage?: (path: string) => ImageBlockData | null;
  posterFrame?: (path: string) => ImageBlockData | null;
  now?: () => number;
}

const VISION_PROMPT =
  "Describe this image in one concise sentence for a chat transcript. Note any legible text.";
const VIDEO_PROMPT =
  "This is a still frame from a video. In one concise sentence, describe what the video is likely about.";

/** True when a link is free (never leaves the device / costs nothing). */
function isFreeLink(link: string): boolean {
  return link === "apple" || link === "local";
}

/**
 * Whether, under `auto` mode, this link may run automatically. `off` blocks all
 * auto interpretation (explicit `force` bypasses); `free` blocks paid providers;
 * `all` allows everything.
 */
function linkAllowed(link: string, auto: AutoMode, force: boolean): boolean {
  if (force) return true;
  if (auto === "off") return false;
  if (auto === "free") return isFreeLink(link);
  return true;
}

export class MediaIntelService {
  private inflight = new Map<string, Promise<InterpretResult>>();

  constructor(
    private readonly config: InterpretConfig,
    private readonly deps: MediaIntelDeps = {},
  ) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private providerClient(name: string): ProviderClient | null {
    const cfg = this.config.providers.find((p) => p.name === name);
    if (!cfg) return null;
    let resolved: ReturnType<typeof resolveProvider>;
    try {
      resolved = resolveProvider(cfg);
    } catch {
      return null;
    }
    const opts: ProviderClientOpts = {
      fetchImpl: this.deps.fetchImpl,
      timeoutMs: this.deps.timeoutMs,
    };
    return new ProviderClient(resolved, opts);
  }

  private chainFor(kind: MediaKind): string[] {
    if (kind === "audio") return this.config.chains.audio;
    if (kind === "image") return this.config.chains.image;
    return this.config.chains.video;
  }

  /** How many of these refs would need a PAID (provider) call — for the export guard. */
  countUncachedCloud(refs: AttachmentRef[]): number {
    let n = 0;
    for (const ref of refs) {
      const sig = this.sigFor(ref);
      if (sig && lookupMediaIntel(ref.key, sig, { includeFailed: false })) continue;
      const chain = this.chainFor(ref.kind);
      // A paid call is needed only if the chain has no free link that would satisfy it.
      const freeCanHandle =
        ref.kind === "audio" && chain.some((l) => l === "apple" || l === "local");
      const hasProvider = chain.some((l) => l.startsWith("provider:"));
      if (hasProvider && !freeCanHandle) n++;
    }
    return n;
  }

  private sigFor(ref: AttachmentRef): string | null {
    try {
      const st = statSync(ref.path);
      return fileSignature(st.size, st.mtimeMs);
    } catch {
      return null;
    }
  }

  /**
   * Cache-only / instant lookup — NEVER runs the chain (no exec, no network,
   * no cache writes). Returns a `done` result when a successful interpretation
   * is already cached, or when the ref carries an instant Apple transcript;
   * otherwise null. Read surfaces (get_messages, TUI render, export embedding)
   * call this so they can inline a transcript without ever blocking on a paid
   * call — interpretation is *triggered* only by `interpret()`.
   */
  peek(ref: AttachmentRef): InterpretResult | null {
    const sig = this.sigFor(ref);
    if (sig) {
      const cached = lookupMediaIntel(ref.key, sig, { includeFailed: false });
      if (cached && cached.status === "done" && cached.text) {
        return {
          status: "done",
          text: cached.text,
          source: cached.source,
          model: cached.model,
          extra: cached.extra,
          cached: true,
        };
      }
    }
    // No cached row — but the free/instant Apple transcript needs no file and no
    // chain run, so surface it directly (matches what `apple`-first chains cache).
    if (ref.appleTranscript) {
      return {
        status: "done",
        text: ref.appleTranscript,
        source: "apple",
        model: null,
        cached: false,
      };
    }
    return null;
  }

  /**
   * Interpret one attachment, walking its chain. Returns a cached result when
   * available; otherwise runs the chain (respecting the auto-mode gate) and
   * caches the outcome. Concurrent calls for the same key share one run.
   */
  async interpret(ref: AttachmentRef, opts: { force?: boolean } = {}): Promise<InterpretResult> {
    const existing = this.inflight.get(ref.key);
    if (existing) return existing;
    const p = this.run(ref, opts.force ?? false).finally(() => this.inflight.delete(ref.key));
    this.inflight.set(ref.key, p);
    return p;
  }

  private async run(ref: AttachmentRef, force: boolean): Promise<InterpretResult> {
    const sig = this.sigFor(ref);
    if (sig) {
      const cached = lookupMediaIntel(ref.key, sig, { includeFailed: true });
      if (cached && cached.status === "done") {
        return {
          status: "done",
          text: cached.text,
          source: cached.source,
          model: cached.model,
          extra: cached.extra,
          cached: true,
        };
      }
      // A cached failure still short-circuits auto runs (caller can `force`).
      if (cached && cached.status === "failed" && !force) {
        return {
          status: "failed",
          text: null,
          source: cached.source,
          model: cached.model,
          cached: true,
          error: cached.error ?? "previously failed",
        };
      }
    }

    const chain = this.chainFor(ref.kind);
    if (chain.length === 0) {
      return { status: "skipped", text: null, source: null, model: null, cached: false };
    }

    const started = this.now();
    let lastError: string | undefined;
    let anyAllowedRan = false;
    let anyBlocked = false;
    for (const link of chain) {
      if (!linkAllowed(link, this.config.auto, force)) {
        anyBlocked = true;
        continue;
      }
      anyAllowedRan = true;
      try {
        const hit = await this.tryLink(link, ref);
        if (hit?.text) {
          const rec: MediaIntelRecord = {
            key: ref.key,
            kind: ref.kind,
            status: "done",
            text: hit.text,
            extra: hit.extra ?? null,
            source: hit.source,
            model: hit.model ?? null,
            fileSig: sig ?? "nofile",
            durMs: this.now() - started,
            error: null,
            createdAt: this.now(),
          };
          if (sig) storeMediaIntel(rec);
          return {
            status: "done",
            text: hit.text,
            source: hit.source,
            model: hit.model ?? null,
            extra: hit.extra ?? null,
            cached: false,
          };
        }
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }

    // Nothing produced text. Two "no result" outcomes, only one of which is a
    // real failure:
    //   - skipped: nothing ran (auto=off), OR the free links found nothing but a
    //     paid link was gated by auto-mode — a forced/cloud attempt could still
    //     succeed, so DON'T cache a failure.
    //   - failed: every link that COULD run actually ran and produced nothing.
    if (!anyAllowedRan || anyBlocked) {
      return { status: "skipped", text: null, source: null, model: null, cached: false };
    }
    if (sig) {
      storeMediaIntel({
        key: ref.key,
        kind: ref.kind,
        status: "failed",
        text: null,
        extra: null,
        source: chain[chain.length - 1] ?? "unknown",
        model: null,
        fileSig: sig,
        durMs: this.now() - started,
        error: lastError ?? "no link produced text",
        createdAt: this.now(),
      });
    }
    return {
      status: "failed",
      text: null,
      source: null,
      model: null,
      cached: false,
      error: lastError ?? "no link produced text",
    };
  }

  private async tryLink(
    link: string,
    ref: AttachmentRef,
  ): Promise<{
    text: string;
    source: string;
    model?: string;
    extra?: Record<string, unknown>;
  } | null> {
    if (link === "apple") {
      return ref.appleTranscript ? { text: ref.appleTranscript, source: "apple" } : null;
    }
    if (link === "local") {
      if (ref.kind !== "audio") return null;
      const fn = this.deps.transcribeLocal ?? transcribeAudio;
      const text = fn(ref.path);
      return text ? { text, source: "local" } : null;
    }
    if (link.startsWith("provider:")) {
      return this.tryProvider(link.slice("provider:".length), ref);
    }
    return null;
  }

  private async tryProvider(
    name: string,
    ref: AttachmentRef,
  ): Promise<{
    text: string;
    source: string;
    model?: string;
    extra?: Record<string, unknown>;
  } | null> {
    const client = this.providerClient(name);
    if (!client) return null;
    const cfg = this.config.providers.find((p) => p.name === name);
    const resolved = cfg ? resolveProvider(cfg) : null;
    const source = `provider:${name}`;

    if (ref.kind === "audio") {
      if (resolved?.capabilities.transcribe) {
        const buffer = readFileBuffer(ref.path);
        if (!buffer) return null;
        const text = await client.transcriptions({ buffer, filename: ref.filename });
        return text ? { text, source, model: resolved.models.transcribe } : null;
      }
      if (resolved?.capabilities.audioChat) {
        const buffer = readFileBuffer(ref.path);
        if (!buffer) return null;
        const text = await client.chatMultimodal({
          text: "Transcribe this audio message verbatim.",
          audio: { buffer, mime: ref.mime ?? undefined, filename: ref.filename },
        });
        return text ? { text, source, model: resolved.models.vision } : null;
      }
      return null;
    }

    if (ref.kind === "image") {
      const img = (this.deps.readImage ?? imageBlockFromFile)(ref.path);
      if (!img) return null;
      const text = await client.chatMultimodal({
        text: VISION_PROMPT,
        images: [Buffer.from(img.base64, "base64")],
      });
      return text ? { text, source, model: resolved?.models.vision } : null;
    }

    // video: poster-frame vision description (+ audio-track transcript is a future
    // enhancement gated on avconvert; keep the record shape ready via `extra`).
    const poster = (this.deps.posterFrame ?? videoPosterFrame)(ref.path);
    if (!poster) return null;
    const description = await client.chatMultimodal({
      text: VIDEO_PROMPT,
      images: [Buffer.from(poster.base64, "base64")],
    });
    if (!description) return null;
    return {
      text: description,
      source,
      model: resolved?.models.vision,
      extra: { description },
    };
  }
}

function readFileBuffer(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}
