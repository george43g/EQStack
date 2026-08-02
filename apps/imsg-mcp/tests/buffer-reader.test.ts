/**
 * BufferReader: cursor-tracking binary reader used by the attributed
 * body / typedstream parsers. Pure module — no fixtures or DB. A
 * regression here breaks message-text extraction from `attributedBody`
 * for everything other than the simplest plain-text rows.
 */

import { describe, expect, it } from "vitest";
import { BufferReader } from "../src/parsers/buffer-reader.js";

describe("BufferReader — construction + getters", () => {
  it("starts at offset 0 by default", () => {
    const r = new BufferReader(Buffer.from([1, 2, 3]));
    expect(r.position).toBe(0);
    expect(r.length).toBe(3);
    expect(r.remaining).toBe(3);
  });

  it("respects initialOffset", () => {
    const r = new BufferReader(Buffer.from([1, 2, 3, 4]), 2);
    expect(r.position).toBe(2);
    expect(r.remaining).toBe(2);
  });
});

describe("BufferReader — seek + skip", () => {
  it("seek moves position", () => {
    const r = new BufferReader(Buffer.from([1, 2, 3, 4]));
    r.seek(3);
    expect(r.position).toBe(3);
    expect(r.remaining).toBe(1);
  });

  it("seek to exactly length is valid (cursor at EOF)", () => {
    const r = new BufferReader(Buffer.from([1, 2]));
    r.seek(2);
    expect(r.position).toBe(2);
    expect(r.remaining).toBe(0);
  });

  it("seek throws on out-of-bounds", () => {
    const r = new BufferReader(Buffer.from([1, 2]));
    expect(() => r.seek(-1)).toThrow(/Invalid seek/);
    expect(() => r.seek(3)).toThrow(/Invalid seek/);
  });

  it("skip advances without bounds check (mirrors upstream behaviour)", () => {
    const r = new BufferReader(Buffer.from([1, 2, 3]));
    r.skip(2);
    expect(r.position).toBe(2);
  });
});

describe("BufferReader — read primitives", () => {
  it("readUInt8 returns the byte and advances by 1", () => {
    const r = new BufferReader(Buffer.from([0x41, 0x42]));
    expect(r.readUInt8()).toBe(0x41);
    expect(r.position).toBe(1);
    expect(r.readUInt8()).toBe(0x42);
    expect(r.position).toBe(2);
  });

  it("readUInt16LE returns little-endian and advances by 2", () => {
    const r = new BufferReader(Buffer.from([0x34, 0x12])); // 0x1234 LE
    expect(r.readUInt16LE()).toBe(0x1234);
    expect(r.position).toBe(2);
  });

  it("readBytes returns a slice and advances", () => {
    const r = new BufferReader(Buffer.from([1, 2, 3, 4, 5]));
    const slice = r.readBytes(3);
    expect(Array.from(slice)).toEqual([1, 2, 3]);
    expect(r.position).toBe(3);
  });

  it("readBytes throws on overrun", () => {
    const r = new BufferReader(Buffer.from([1, 2]));
    expect(() => r.readBytes(5)).toThrow(/beyond buffer/);
  });

  it("readString defaults to utf8", () => {
    const r = new BufferReader(Buffer.from("hello", "utf8"));
    expect(r.readString(5)).toBe("hello");
  });

  it("readString respects alternative encoding", () => {
    // "hi" in latin1 + a high byte that's different from utf8
    const r = new BufferReader(Buffer.from([0xe9])); // é in latin1
    expect(r.readString(1, "latin1")).toBe("é");
  });
});

describe("BufferReader — findPattern", () => {
  it("returns absolute offset when pattern found", () => {
    const r = new BufferReader(Buffer.from("hello world"));
    expect(r.findPattern("world")).toBe(6);
  });

  it("returns -1 when pattern not found", () => {
    const r = new BufferReader(Buffer.from("hello"));
    expect(r.findPattern("xyz")).toBe(-1);
  });

  it("accepts a Buffer pattern", () => {
    const r = new BufferReader(Buffer.from([0x01, 0xff, 0xaa, 0xbb]));
    expect(r.findPattern(Buffer.from([0xaa, 0xbb]))).toBe(2);
  });

  it("searches forward from the current offset, not 0", () => {
    const r = new BufferReader(Buffer.from("ababab"));
    r.seek(2);
    expect(r.findPattern("ab")).toBe(2); // current pos
    r.seek(3);
    expect(r.findPattern("ab")).toBe(4); // next occurrence
  });
});

describe("BufferReader — peek", () => {
  it("peekByte returns the byte without advancing", () => {
    const r = new BufferReader(Buffer.from([0x41]));
    expect(r.peekByte()).toBe(0x41);
    expect(r.position).toBe(0); // unchanged
  });

  it("peekByte returns null at EOF", () => {
    const r = new BufferReader(Buffer.from([0x41]));
    r.seek(1);
    expect(r.peekByte()).toBeNull();
  });

  it("peekBytes returns a slice without advancing", () => {
    const r = new BufferReader(Buffer.from([1, 2, 3]));
    const slice = r.peekBytes(2);
    expect(slice).not.toBeNull();
    expect(Array.from(slice!)).toEqual([1, 2]);
    expect(r.position).toBe(0); // unchanged
  });

  it("peekBytes returns null when beyond length", () => {
    const r = new BufferReader(Buffer.from([1, 2]));
    expect(r.peekBytes(3)).toBeNull();
  });
});
