/**
 * Stage 5 — edit-history parsing from message_summary_info.
 *
 * We unit-test the PURE `parseEditSummary` with plain objects (no bplist
 * serialization needed): the `ec` structure, Cocoa-date normalization,
 * typedstream text decode of each version, and the `rp` retracted-part list.
 * `extractEditHistory(buffer)` is a thin bplist.parseBuffer wrapper over it.
 *
 * The `t` version blobs are SYNTHESIZED typedstream (same builder as the
 * attributed-body tests) — no real message content.
 */
import { describe, expect, it } from "vitest";
import { extractEditHistory, parseEditSummary } from "../src/edit-history.js";

/** Minimal valid typedstream attributedBody carrying `text` (0x94 preamble). */
function buildBlob(text: string): Buffer {
  const utf8 = Buffer.from(text, "utf8");
  const len = utf8.length;
  const lenBytes =
    len < 0x81 ? Buffer.from([len]) : Buffer.from([0x81, len & 0xff, (len >>> 8) & 0xff]);
  const header = Buffer.from([
    0x04, 0x0b, 0x73, 0x74, 0x72, 0x65, 0x61, 0x6d, 0x74, 0x79, 0x70, 0x65, 0x64, 0x81, 0xe8, 0x03,
    0x84, 0x01, 0x40, 0x84, 0x84, 0x84, 0x12,
  ]);
  return Buffer.concat([
    header,
    Buffer.from("NSAttributedString\x00", "ascii"),
    Buffer.from([0x84, 0x84, 0x08]),
    Buffer.from("NSObject\x00", "ascii"),
    Buffer.from([0x85, 0x92, 0x84, 0x84, 0x84, 0x08]),
    Buffer.from("NSString\x01", "ascii"),
    Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b]),
    lenBytes,
    utf8,
    Buffer.from([0x86, 0x84, 0x02, 0x69, 0x49]),
  ]);
}

// Cocoa seconds-since-2001 for 2026-06-01T00:00:00Z.
const COCOA_2026 = Math.floor(Date.UTC(2026, 5, 1) / 1000) - 978_307_200;

describe("parseEditSummary", () => {
  it("reads an edit chain: versions with decoded text + dates", () => {
    const hist = parseEditSummary({
      ec: {
        "0": [
          { t: buildBlob("first draft"), d: COCOA_2026 },
          { t: buildBlob("edited final"), d: COCOA_2026 + 60 },
        ],
      },
    });
    expect(hist).not.toBeNull();
    expect(hist?.parts).toHaveLength(1);
    const versions = hist?.parts[0]?.versions ?? [];
    expect(versions.map((v) => v.text)).toEqual(["first draft", "edited final"]);
    expect(versions[0]?.date?.getUTCFullYear()).toBe(2026);
    expect(versions[1]?.date?.getTime()).toBe((COCOA_2026 + 60 + 978_307_200) * 1000);
  });

  it("sorts multiple parts by index", () => {
    const hist = parseEditSummary({
      ec: {
        "2": [{ t: buildBlob("part two"), d: COCOA_2026 }],
        "0": [{ t: buildBlob("part zero"), d: COCOA_2026 }],
      },
    });
    expect(hist?.parts.map((p) => p.part)).toEqual([0, 2]);
  });

  it("reads retracted parts (rp)", () => {
    const hist = parseEditSummary({ rp: [0, 1] });
    expect(hist?.retractedParts).toEqual([0, 1]);
    expect(hist?.parts).toHaveLength(0);
  });

  it("rejects an implausible date as null but keeps the text", () => {
    const hist = parseEditSummary({
      ec: { "0": [{ t: buildBlob("hi there edit"), d: -5_000_000_000 }] },
    });
    expect(hist?.parts[0]?.versions[0]?.text).toBe("hi there edit");
    expect(hist?.parts[0]?.versions[0]?.date).toBeNull();
  });

  it("returns null when there's no edit or retract data", () => {
    expect(parseEditSummary({ amc: 1, ust: 2 })).toBeNull();
    expect(parseEditSummary(null)).toBeNull();
    expect(parseEditSummary(undefined)).toBeNull();
  });

  it("normalizes nanosecond-scale dates too", () => {
    const nanos = COCOA_2026 * 1e9;
    const hist = parseEditSummary({ ec: { "0": [{ t: buildBlob("x"), d: nanos }] } });
    expect(hist?.parts[0]?.versions[0]?.date?.getUTCFullYear()).toBe(2026);
  });
});

describe("extractEditHistory", () => {
  it("returns null for empty/garbage buffers", () => {
    expect(extractEditHistory(null)).toBeNull();
    expect(extractEditHistory(Buffer.alloc(0))).toBeNull();
    expect(extractEditHistory(Buffer.from("not a plist"))).toBeNull();
  });
});
