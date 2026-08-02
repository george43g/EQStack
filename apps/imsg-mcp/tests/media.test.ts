/**
 * Zero-dep media helper tests. These run the REAL macOS binaries (sips,
 * mdls) — CI runners are macOS. Graceful-degradation paths (missing files,
 * non-media input) must return null, never throw.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  detectTranscriber,
  IMAGE_BLOCK_MAX_BASE64,
  imageBlockFromFile,
  mediaMetadata,
  resetTranscriberCache,
  TRANSCRIBERS,
  transcribeAudio,
  videoPosterFrame,
} from "../src/media.js";

const work = mkdtempSync(join(tmpdir(), "imsg-media-test-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

/** Minimal 1x1 red PNG. */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

function makePng(name: string, edge = 1): string {
  const p = join(work, name);
  writeFileSync(p, TINY_PNG);
  if (edge > 1) {
    // Upscale with sips so we can exercise the downscale path.
    execFileSync("sips", ["-z", String(edge), String(edge), p], { stdio: "ignore" });
  }
  return p;
}

describe("imageBlockFromFile", () => {
  it("returns a base64 PNG block for a valid image", () => {
    const block = imageBlockFromFile(makePng("small.png"));
    expect(block).not.toBeNull();
    expect(block!.mimeType).toMatch(/^image\/(png|jpeg)$/);
    expect(block!.base64.length).toBeGreaterThan(0);
    expect(block!.base64.length).toBeLessThanOrEqual(IMAGE_BLOCK_MAX_BASE64);
    // Round-trips as an image (PNG magic bytes).
    const bytes = Buffer.from(block!.base64, "base64");
    expect(bytes.subarray(1, 4).toString()).toBe("PNG");
  });

  it("downscales oversized images to the edge budget", () => {
    const block = imageBlockFromFile(makePng("big.png", 2500));
    expect(block).not.toBeNull();
    expect(block!.base64.length).toBeLessThanOrEqual(IMAGE_BLOCK_MAX_BASE64);
  });

  it("returns null for a non-image file", () => {
    const p = join(work, "not-an-image.png");
    writeFileSync(p, "definitely not image bytes");
    expect(imageBlockFromFile(p)).toBeNull();
  });

  it("returns null for a missing file", () => {
    expect(imageBlockFromFile(join(work, "nope.png"))).toBeNull();
  });
});

describe("videoPosterFrame", () => {
  it("returns null for a missing video without throwing", () => {
    // Invalid-content files are covered by the same catch path but hang
    // qlmanage until its timeout — too slow for the suite.
    expect(videoPosterFrame(join(work, "missing.mov"))).toBeNull();
  });
});

describe("mediaMetadata", () => {
  it("never throws; returns string or null", () => {
    const out = mediaMetadata(join(work, "missing.m4a"));
    expect(out === null || typeof out === "string").toBe(true);
  });
});

describe("transcriber detection", () => {
  it("returns a known transcriber or null, and caches the probe", () => {
    resetTranscriberCache();
    const first = detectTranscriber();
    expect(first === null || ["hear", "yap", "whisper-cli"].includes(first.name)).toBe(true);
    expect(detectTranscriber()).toBe(first);
  });

  it("transcribeAudio returns null for missing files", () => {
    expect(transcribeAudio(join(work, "missing.caf"))).toBeNull();
  });

  it("builds correct argv for each transcriber (subcommand / device-only flags)", () => {
    const byName = Object.fromEntries(TRANSCRIBERS.map((t) => [t.name, t.args("/x.caf")]));
    // yap needs its `transcribe` subcommand; bare `yap <file>` is invalid.
    expect(byName.yap).toEqual(["transcribe", "/x.caf"]);
    // hear must pass -d so recognition stays on-device (no upload to Apple).
    expect(byName.hear).toContain("-d");
    expect(byName["whisper-cli"]).toEqual(["-f", "/x.caf", "-np", "-nt"]);
  });
});
