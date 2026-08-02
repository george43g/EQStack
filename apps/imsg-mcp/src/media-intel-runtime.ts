/**
 * Runtime wiring for media interpretation — the single place that constructs a
 * `MediaIntelService` from the resolved on-disk config (chains + providers +
 * credentials + legacy env) with REAL dependencies (network / transcribers /
 * media exec). Every frontend (MCP handlers, CLI, TUI hooks) shares this one
 * service + cache instance via `getInterpretRuntime()`.
 *
 * Frontends stay render-only: they call this module, never `fetch`/`spawn`
 * directly. The pure service (`media-intel.ts`) stays DI-friendly for tests;
 * this module holds the process-wide singleton and the chat.db → AttachmentRef
 * adapters.
 */
import { basename } from "node:path";
import { type ResolvedInterpretConfig, resolveInterpretConfig } from "./app-config.js";
import { type AttachmentRef, MediaIntelService } from "./media-intel.js";
import type { MediaKind } from "./media-intel-cache.js";
import type { Message } from "./types.js";

export interface InterpretRuntime {
  service: MediaIntelService;
  config: ResolvedInterpretConfig;
}

let runtime: InterpretRuntime | null = null;

/** An inert runtime: no config read, no providers, no auto interpretation, and
 *  inlining disabled — so nothing touches the user's real config/credentials,
 *  no transcriber is exec'd, and no network is hit. Used as the Vitest default;
 *  tests that exercise real interpret logic inject via the test hook below. */
function inertRuntime(): InterpretRuntime {
  const chains = { audio: [], image: [], video: [] };
  return {
    service: new MediaIntelService({ auto: "off", chains, providers: [] }),
    config: {
      auto: "off",
      chains,
      providers: [],
      inlineTranscripts: false,
      exportConfirmThreshold: 25,
      nudge: { enabled: false, tier2SyncNow: false, timeoutSeconds: 30 },
      configPath: null,
      warnings: [],
    },
  };
}

/**
 * The process-wide interpret runtime, built lazily from `resolveInterpretConfig()`
 * on first use and memoized. Real deps (the default `MediaIntelService` deps use
 * the global fetch, on-device transcribers, and the macOS media helpers).
 *
 * Under Vitest it defaults to an inert runtime (same mock-by-default posture as
 * `applescript.ts`) so the suite never reads real credentials, spawns a
 * transcriber, or hits the network; inject a real one with
 * `_setInterpretRuntimeForTests` to exercise the interpretation paths.
 */
export function getInterpretRuntime(): InterpretRuntime {
  if (runtime) return runtime;
  if (process.env.VITEST) {
    runtime = inertRuntime();
    return runtime;
  }
  const config = resolveInterpretConfig();
  const service = new MediaIntelService({
    auto: config.auto,
    chains: config.chains,
    providers: config.providers,
  });
  runtime = { service, config };
  return runtime;
}

/** Tests: inject a fake runtime, or pass `null` to force a rebuild next call. */
export function _setInterpretRuntimeForTests(r: InterpretRuntime | null): void {
  runtime = r;
}

/** Expand a leading `~` to $HOME the same way chat.db attachment paths need. */
export function resolveAttachmentPath(filename: string): string {
  return filename.replace(/^~/, process.env.HOME ?? "~");
}

/** Classify an attachment by mime (falling back to extension). Null = not media. */
export function kindFromMime(mime: string | null | undefined, path: string): MediaKind | null {
  const m = (mime ?? "").toLowerCase();
  const p = path.toLowerCase();
  if (m.startsWith("image/") || m.includes("heic") || p.endsWith(".heic")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/") || /\.(caf|amr|m4a|mp3|wav|aac)$/i.test(p)) return "audio";
  return null;
}

/** Stable per-attachment cache key. ROWID is available on every surface. */
export function attKey(rowId: number): string {
  return `att:${rowId}`;
}

interface RowLike {
  rowId?: number | null;
  filename: string;
  mimeType: string | null;
  transferName?: string | null;
}

/**
 * Build an `AttachmentRef` from a chat.db attachment row (message attachment or
 * `getAttachmentByRowId` record). Returns null when the row is not interpretable
 * media (no rowId, or a non-audio/image/video mime).
 */
export function refForAttachment(
  row: RowLike,
  appleTranscript?: string | null,
): AttachmentRef | null {
  if (row.rowId == null) return null;
  const path = resolveAttachmentPath(row.filename);
  const kind = kindFromMime(row.mimeType, path);
  if (!kind) return null;
  return {
    key: attKey(row.rowId),
    path,
    mime: row.mimeType,
    filename: row.transferName || basename(path) || String(row.rowId),
    kind,
    // Apple only transcribes audio; never claim an image has an Apple transcript.
    appleTranscript: kind === "audio" ? (appleTranscript ?? null) : null,
  };
}

/**
 * The single interpretable-media ref for a message (its voice note / image /
 * video), or null. Prefers an attachment; falls back to a synthetic audio ref
 * when the message carries only an Apple transcript (no attachment row). Used by
 * the TUI to trigger/retry interpretation for the focused bubble.
 */
export function primaryMediaRef(msg: Message): AttachmentRef | null {
  for (const att of msg.attachments ?? []) {
    const ref = refForAttachment(att, msg.appleAudioTranscript);
    if (ref) return ref;
  }
  if (msg.appleAudioTranscript) {
    return {
      key: `msg:${msg.id}`,
      path: "",
      mime: null,
      filename: `msg-${msg.id}`,
      kind: "audio",
      appleTranscript: msg.appleAudioTranscript,
    };
  }
  return null;
}

/** Collect refs for every interpretable media attachment across a page of messages. */
export function refsForMessages(messages: Message[]): AttachmentRef[] {
  const refs: AttachmentRef[] = [];
  for (const msg of messages) {
    for (const att of msg.attachments ?? []) {
      const ref = refForAttachment(att, msg.appleAudioTranscript);
      if (ref) refs.push(ref);
    }
  }
  return refs;
}

/**
 * Populate `msg.interpretedMedia` on each message from CACHED or INSTANT (Apple)
 * results only — a pure peek that never runs the chain, never blocks on a paid
 * call, and never writes the cache. No-op when `inlineTranscripts` is disabled.
 * Idempotent: skips messages that already carry an interpretation.
 */
export function applyInlineInterpretations(
  messages: Message[],
  rt: InterpretRuntime = getInterpretRuntime(),
): void {
  if (!rt.config.inlineTranscripts) return;
  for (const msg of messages) {
    if (msg.interpretedMedia) continue;
    // Instant Apple voice-note transcript — no file, no lookup needed.
    if (msg.appleAudioTranscript) {
      msg.interpretedMedia = {
        kind: "audio",
        text: msg.appleAudioTranscript,
        source: "apple",
      };
      continue;
    }
    for (const att of msg.attachments ?? []) {
      const ref = refForAttachment(att, msg.appleAudioTranscript);
      if (!ref) continue;
      const peeked = rt.service.peek(ref);
      if (peeked?.status === "done" && peeked.text) {
        msg.interpretedMedia = {
          kind: ref.kind,
          text: peeked.text,
          source: peeked.source ?? "cached",
        };
        break;
      }
    }
  }
}

/**
 * Populate `msg.interpretedMedia` for an EXPORT page. Unlike the read-surface
 * inline path, this is not gated by `inlineTranscripts` — export embedding is
 * controlled by the export's own `interpret` flag:
 *   - `active: false` → peek only (cached + instant Apple; never a paid call).
 *   - `active: true`  → run the chain (honoring the auto-mode gate + limiter),
 *     caching each result forever.
 * Idempotent; skips messages that already carry an interpretation.
 */
export async function embedInterpretations(
  messages: Message[],
  rt: InterpretRuntime,
  active: boolean,
): Promise<void> {
  for (const msg of messages) {
    if (msg.interpretedMedia) continue;
    // The instant Apple transcript is free and always preferred — embed it
    // regardless of `active` (which only gates NEW, possibly paid, calls).
    if (msg.appleAudioTranscript) {
      msg.interpretedMedia = { kind: "audio", text: msg.appleAudioTranscript, source: "apple" };
      continue;
    }
    for (const att of msg.attachments ?? []) {
      const ref = refForAttachment(att, msg.appleAudioTranscript);
      if (!ref) continue;
      const r = active ? await rt.service.interpret(ref) : rt.service.peek(ref);
      if (r?.status === "done" && r.text) {
        msg.interpretedMedia = { kind: ref.kind, text: r.text, source: r.source ?? "cached" };
        break;
      }
    }
  }
}

/** Map a granular interpret source ("apple"|"local"|"provider:x") to the
 *  back-compat local|cloud enum used by `get_attachment.transcriptSource`. */
export function transcriptSourceEnum(source: string | null): "local" | "cloud" | undefined {
  if (!source) return undefined;
  return source.startsWith("provider:") ? "cloud" : "local";
}
