import { describe, expect, it } from "vitest";
import { extractAudioTranscription } from "../src/attributed-body-text.js";

/**
 * All fixtures are SYNTHESIZED from the public typedstream framing for an
 * `IMAudioTranscription` attribute — NO real transcript is embedded. The framing
 * (marker + 5-byte value framing + length + UTF-8) was verified content-safe
 * against the dev DB; see docs/plans/media-intel/01-apple-native-media-text.md.
 */

const MARKER = Buffer.from("IMAudioTranscription", "ascii");
const FRAMING = Buffer.from([0x86, 0x92, 0x84, 0x96, 0x96]);

/** Build a blob: leading junk + marker + framing + length + transcript. */
function buildBlob(transcript: string, opts: { framing?: Buffer; junk?: Buffer } = {}): Buffer {
  const utf8 = Buffer.from(transcript, "utf8");
  const len = utf8.length;
  let lenBytes: Buffer;
  if (len < 0x81) lenBytes = Buffer.from([len]);
  else if (len <= 0xffff) lenBytes = Buffer.from([0x81, len & 0xff, (len >>> 8) & 0xff]);
  else lenBytes = Buffer.from([0x82, len & 0xff, (len >>> 8) & 0xff, (len >>> 16) & 0xff, 0]);

  const junk = opts.junk ?? Buffer.from([0x04, 0x0b, 0x73, 0x74, 0x99, 0x88, 0xfc]);
  return Buffer.concat([junk, MARKER, opts.framing ?? FRAMING, lenBytes, utf8]);
}

describe("extractAudioTranscription", () => {
  it("returns undefined for null / no-marker blobs", () => {
    expect(extractAudioTranscription(null)).toBeUndefined();
    expect(extractAudioTranscription(Buffer.from("no transcription here"))).toBeUndefined();
  });

  it("extracts a short (single-byte length) transcript", () => {
    const text = "Hey just calling to say the plan works";
    expect(extractAudioTranscription(buildBlob(text))).toBe(text);
  });

  it("extracts a long (0x81 uint16) transcript", () => {
    const text = `So one thing I wanted to mention — ${"lorem ipsum dolor sit amet ".repeat(40)}end.`;
    expect(text.length).toBeGreaterThan(0x81);
    expect(extractAudioTranscription(buildBlob(text))).toBe(text);
  });

  it("extracts a very long (0x82 uint32) transcript", () => {
    const text = `padded ${"the quick brown fox jumped ".repeat(3000)}stop`;
    expect(text.length).toBeGreaterThan(0xffff);
    expect(extractAudioTranscription(buildBlob(text))).toBe(text);
  });

  it("handles unicode transcripts (byte length ≠ char length)", () => {
    const text = "café ☕ résumé — naïve façade";
    expect(extractAudioTranscription(buildBlob(text))).toBe(text);
  });

  it("recovers via the fallback scan when the value framing drifts", () => {
    // Different framing bytes (still all >= 0x84) — fallback should find the length.
    const text = "framing drifted but still recovered";
    const drifted = Buffer.from([0x86, 0x93, 0x84, 0x96]);
    expect(extractAudioTranscription(buildBlob(text, { framing: drifted }))).toBe(text);
  });

  it("rejects a mis-framed read that yields only control bytes", () => {
    // Marker followed immediately by a length pointing at non-text bytes.
    const blob = Buffer.concat([MARKER, Buffer.from([0x04, 0x00, 0x01, 0x02, 0x03, 0x00])]);
    expect(extractAudioTranscription(blob)).toBeUndefined();
  });

  it("does not read past the end of the blob on a truncated length", () => {
    const truncated = Buffer.concat([MARKER, FRAMING, Buffer.from([0x81, 0xff])]); // claims 0xff.. but ends
    expect(extractAudioTranscription(truncated)).toBeUndefined();
  });
});
