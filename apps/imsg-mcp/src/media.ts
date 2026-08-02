/**
 * Zero-dependency macOS media helpers for multimodal attachment ingestion.
 *
 * Everything here shells out to binaries that ship with macOS (`sips`,
 * `qlmanage`, `mdls`, `afinfo`) so images/videos/audio can be turned into
 * model-ingestible artifacts without adding runtime dependencies:
 *   - images  → downscaled PNG/JPEG suitable for an MCP image content block
 *   - video   → QuickLook poster frame (image block) + Spotlight metadata
 *   - audio   → metadata always; transcript when an OPTIONAL transcriber
 *               (`hear`, `yap`, or `whisper-cli`) is found on PATH
 *
 * Failures degrade gracefully: callers get `null` and fall back to
 * path+metadata-only responses. Mirrors the Rust-native fallback pattern.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { getTranscribeCloudConfig, type TranscribeCloudConfig } from "./config.js";

/**
 * MCP image content blocks should stay well under host tool-result caps
 * (Claude Desktop ~1MB). 1MB of base64 ≈ 750KB of image bytes.
 */
export const IMAGE_BLOCK_MAX_BASE64 = 1_000_000;
/** Longest-edge downscale target — matches Claude vision guidance (≤1568px). */
export const IMAGE_MAX_EDGE = 1536;

export interface ImageBlockData {
  base64: string;
  mimeType: string;
  note?: string;
}

/**
 * Produce a model-ingestible image (≤IMAGE_MAX_EDGE px, ≤IMAGE_BLOCK_MAX_BASE64
 * base64 chars) from any sips-readable image file (HEIC included). Returns
 * null when conversion fails or the result is still too large.
 */
export function imageBlockFromFile(path: string): ImageBlockData | null {
  if (!existsSync(path)) return null;
  const work = mkdtempSync(join(tmpdir(), "imsg-media-"));
  try {
    const out = join(work, "preview.png");
    // -Z resamples so the longest edge is at most IMAGE_MAX_EDGE, never upscales.
    execFileSync(
      "sips",
      ["-Z", String(IMAGE_MAX_EDGE), "-s", "format", "png", path, "--out", out],
      {
        stdio: "ignore",
        timeout: 30_000,
      },
    );
    let base64 = readFileSync(out).toString("base64");
    let mime = "image/png";
    if (base64.length > IMAGE_BLOCK_MAX_BASE64) {
      // PNG can be larger than a photographic JPEG — retry as JPEG before giving up.
      const jpg = join(work, "preview.jpg");
      execFileSync(
        "sips",
        [
          "-Z",
          String(IMAGE_MAX_EDGE),
          "-s",
          "format",
          "jpeg",
          "-s",
          "formatOptions",
          "70",
          path,
          "--out",
          jpg,
        ],
        { stdio: "ignore", timeout: 30_000 },
      );
      base64 = readFileSync(jpg).toString("base64");
      mime = "image/jpeg";
      if (base64.length > IMAGE_BLOCK_MAX_BASE64) return null;
    }
    return { base64, mimeType: mime, note: `downscaled to ≤${IMAGE_MAX_EDGE}px via sips` };
  } catch {
    return null;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * QuickLook poster frame for a video file. qlmanage writes
 * `<basename>.<ext>.png` into the output dir; we downscale-pass the result
 * through imageBlockFromFile for size discipline.
 */
export function videoPosterFrame(path: string): ImageBlockData | null {
  if (!existsSync(path)) return null;
  const work = mkdtempSync(join(tmpdir(), "imsg-poster-"));
  try {
    execFileSync("qlmanage", ["-t", "-s", String(IMAGE_MAX_EDGE), "-o", work, path], {
      stdio: "ignore",
      timeout: 15_000,
    });
    const png = readdirSync(work).find((f) => f.endsWith(".png"));
    if (!png) return null;
    const block = imageBlockFromFile(join(work, png));
    if (block) block.note = "video poster frame via QuickLook";
    return block;
  } catch {
    return null;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Spotlight metadata for audio/video: duration, dimensions, codecs.
 * Returns a compact human-readable summary or null.
 */
export function mediaMetadata(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    const out = execFileSync(
      "mdls",
      [
        "-name",
        "kMDItemDurationSeconds",
        "-name",
        "kMDItemPixelWidth",
        "-name",
        "kMDItemPixelHeight",
        "-name",
        "kMDItemCodecs",
        "-name",
        "kMDItemAudioSampleRate",
        path,
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    const get = (key: string): string | null => {
      const m = out.match(new RegExp(`${key}\\s*=\\s*(.+)`));
      const v = m?.[1]?.trim();
      return v && v !== "(null)" ? v : null;
    };
    const parts: string[] = [];
    const dur = get("kMDItemDurationSeconds");
    if (dur) parts.push(`duration ${Number.parseFloat(dur).toFixed(1)}s`);
    const w = get("kMDItemPixelWidth");
    const h = get("kMDItemPixelHeight");
    if (w && h) parts.push(`${w}x${h}`);
    const codecs = get("kMDItemCodecs");
    if (codecs) parts.push(`codecs ${codecs.replace(/[()\n]/g, "").trim()}`);
    const rate = get("kMDItemAudioSampleRate");
    if (rate) parts.push(`${Number.parseFloat(rate)}Hz`);
    return parts.length > 0 ? parts.join(" · ") : null;
  } catch {
    return null;
  }
}

// ── Optional audio transcription ─────────────────────────────────────────

export interface Transcriber {
  name: "hear" | "yap" | "whisper-cli";
  /** Build argv for transcribing `path`; stdout is the transcript. */
  args: (path: string) => string[];
}

export const TRANSCRIBERS: Transcriber[] = [
  // finnvoor/yap — Apple SpeechAnalyzer (macOS 26+), fully on-device. Needs the
  // `transcribe` subcommand; `yap <file>` alone is not a valid invocation.
  // Preferred first: fastest and highest quality where available.
  { name: "yap", args: (p) => ["transcribe", p] },
  // whisper.cpp CLI — fully offline, no Apple/cloud involvement.
  { name: "whisper-cli", args: (p) => ["-f", p, "-np", "-nt"] },
  // sveinbjornt/hear — macOS Speech framework. `-d` forces DEVICE-ONLY
  // recognition; without it hear may send the audio to Apple's servers, which
  // is wrong for a privacy-focused tool reading the user's private voice notes.
  { name: "hear", args: (p) => ["-d", "-i", p] },
];

let cachedTranscriber: Transcriber | null | undefined;

/** Probe PATH once for a known transcriber. */
export function detectTranscriber(): Transcriber | null {
  if (cachedTranscriber !== undefined) return cachedTranscriber;
  for (const t of TRANSCRIBERS) {
    try {
      execFileSync("which", [t.name], { stdio: "ignore", timeout: 3_000 });
      cachedTranscriber = t;
      return t;
    } catch {
      // not on PATH — try next
    }
  }
  cachedTranscriber = null;
  return null;
}

/** Test hook — reset the PATH probe cache. */
export function resetTranscriberCache(): void {
  cachedTranscriber = undefined;
}

/** Max audio size we'll hand to a transcriber (voice memos are ≤ a few MB). */
export const TRANSCRIBE_MAX_BYTES = 50_000_000;

/**
 * Transcribe an audio file with the detected transcriber. Returns null when
 * none is installed, the file is too big, or transcription fails/times out.
 */
export function transcribeAudio(path: string, timeoutMs = 60_000): string | null {
  const t = detectTranscriber();
  if (!t || !existsSync(path)) return null;
  try {
    const out = execFileSync(t.name, t.args(path), {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    });
    const text = out.trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

/**
 * Transcribe via an opt-in OpenAI-compatible cloud endpoint
 * (`POST {baseUrl}/audio/transcriptions`, multipart). The audio LEAVES the
 * device — only reached when explicitly configured (see getTranscribeCloudConfig)
 * and no local transcriber produced text. `fetchImpl` is injectable for tests.
 * Returns null on any failure (network, non-2xx, timeout, empty).
 */
export async function transcribeAudioCloud(
  path: string,
  config: TranscribeCloudConfig,
  opts: { fetchImpl?: typeof globalThis.fetch; timeoutMs?: number } = {},
): Promise<string | null> {
  if (!existsSync(path)) return null;
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000);
  try {
    const form = new FormData();
    form.append("file", new Blob([readFileSync(path)]), basename(path));
    form.append("model", config.model);
    form.append("response_format", "text");
    const res = await doFetch(`${config.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}` },
      body: form,
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const text = (await res.text()).trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface TranscribeResult {
  transcript: string;
  source: "local" | "cloud";
}

/**
 * Best-available transcription: local on-device first (privacy-preserving
 * default), then the opt-in cloud escape-hatch when configured and local
 * produced nothing. Returns null when neither yields text. `cloudConfig` and
 * `fetchImpl` are injectable for tests; by default the cloud config is read
 * from IMSG_TRANSCRIBE_* env.
 */
export async function transcribeAudioBest(
  path: string,
  opts: {
    timeoutMs?: number;
    cloudConfig?: TranscribeCloudConfig | null;
    fetchImpl?: typeof globalThis.fetch;
  } = {},
): Promise<TranscribeResult | null> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const local = transcribeAudio(path, timeoutMs);
  if (local) return { transcript: local, source: "local" };
  const cloud = opts.cloudConfig !== undefined ? opts.cloudConfig : getTranscribeCloudConfig();
  if (cloud) {
    const t = await transcribeAudioCloud(path, cloud, { timeoutMs, fetchImpl: opts.fetchImpl });
    if (t) return { transcript: t, source: "cloud" };
  }
  return null;
}
