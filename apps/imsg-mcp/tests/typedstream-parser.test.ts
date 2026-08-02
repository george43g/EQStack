import { describe, expect, it } from "vitest";
import { TypedStreamParser } from "../src/parsers/typedstream-parser.js";

/**
 * Build a synthetic typedstream blob with a chosen preamble byte 2.
 * This targets the regression where Apple uses 0x94 (most common) and 0x95
 * (when message has DataDetector annotations) — and the old parser only
 * matched 0x94, mis-reading the length byte and producing junk output.
 */
function buildBlobWithPreamble(preambleByte2: number, content: string): Buffer {
  const contentBuf = Buffer.from(content, "utf8");
  // Sentinel bytes representing the streamtyped header — content varies across
  // real Apple blobs but the exact bytes don't matter for parser correctness;
  // we only need parseHeader() to exit and findPattern("NSString") to succeed.
  const header = Buffer.from([
    // "streamtyped" magic (must be exact)
    0x04, 0x0b, 0x73, 0x74, 0x72, 0x65, 0x61, 0x6d, 0x74, 0x79, 0x70, 0x65, 0x64,
    // Some padding that doesn't start with an uppercase letter, ensuring
    // parseHeader's skip-ahead loop runs but is bounded.
    0x81, 0xe8, 0x03, 0x84, 0x01, 0x40, 0x84,
  ]);
  const nsStringRef = Buffer.from("NSString", "ascii");
  const preamble = Buffer.from([0x01, preambleByte2, 0x84, 0x01, 0x2b]);
  const lengthByte = Buffer.from([contentBuf.length]);

  return Buffer.concat([header, nsStringRef, preamble, lengthByte, contentBuf]);
}

describe("TypedStreamParser", () => {
  describe("NSString preamble variants", () => {
    it("parses NSString with 0x94 preamble (default variant)", () => {
      const blob = buildBlobWithPreamble(0x94, "Hello world from typedstream");
      const parser = new TypedStreamParser(blob);
      const strings = parser.parseAllNSStrings();
      const found = strings.find((s) => s.content === "Hello world from typedstream");
      expect(found).toBeDefined();
    });

    // Regression for typed-stream parser hang+leak bug fixed in this change.
    it("parses NSString with 0x95 preamble (DataDetector variant)", () => {
      const blob = buildBlobWithPreamble(0x95, "Hello world from typedstream");
      const parser = new TypedStreamParser(blob);
      const strings = parser.parseAllNSStrings();
      const found = strings.find((s) => s.content === "Hello world from typedstream");
      expect(found).toBeDefined();
    });

    it("does not crash with an unknown preamble byte (e.g. 0x96)", () => {
      const blob = buildBlobWithPreamble(0x96, "would-be content");
      const parser = new TypedStreamParser(blob);
      // Should not throw and should not hang.
      const strings = parser.parseAllNSStrings();
      // Result is best-effort — but the call must complete.
      expect(Array.isArray(strings)).toBe(true);
    });
  });

  describe("hang resistance", () => {
    it("parseAllNSStrings completes on an all-zero blob", () => {
      const blob = Buffer.alloc(4096, 0);
      const parser = new TypedStreamParser(blob);
      const start = Date.now();
      parser.parseAllNSStrings();
      expect(Date.now() - start).toBeLessThan(500);
    });

    it("parseAllNSStrings completes on adversarial high-bit input", () => {
      const blob = Buffer.alloc(8192);
      for (let i = 0; i < blob.length; i++) {
        blob[i] = i % 3 === 0 ? 0xff : i % 3 === 1 ? 0xc0 : 0x80;
      }
      const parser = new TypedStreamParser(blob);
      const start = Date.now();
      parser.parseAllNSStrings();
      expect(Date.now() - start).toBeLessThan(500);
    });

    it("extractReadableText completes on all-zero blob", () => {
      const blob = Buffer.alloc(4096, 0);
      const parser = new TypedStreamParser(blob);
      const start = Date.now();
      parser.extractReadableText();
      expect(Date.now() - start).toBeLessThan(500);
    });

    it("extractReadableText completes on adversarial high-bit input", () => {
      // Pattern designed to trigger old isValidUTF8Sequence seek-back bug:
      // 0xC0 indicates "2-byte UTF-8 sequence start" but with insufficient
      // continuation bytes, causing the old code to spin in place.
      const blob = Buffer.alloc(8192);
      for (let i = 0; i < blob.length; i++) {
        blob[i] = i % 2 === 0 ? 0xc0 : 0x00;
      }
      const parser = new TypedStreamParser(blob);
      const start = Date.now();
      parser.extractReadableText();
      expect(Date.now() - start).toBeLessThan(500);
    });

    it("parseAllNSStrings completes on a buffer of repeated 'NSString' patterns", () => {
      // Pathological case: many NSString matches but no valid content after.
      const segment = Buffer.from("NSString\x00\x00\x00\x00\x00\x00\x00\x00", "binary");
      const blob = Buffer.concat(Array(500).fill(segment));
      const parser = new TypedStreamParser(blob);
      const start = Date.now();
      parser.parseAllNSStrings();
      expect(Date.now() - start).toBeLessThan(1000);
    });
  });
});
