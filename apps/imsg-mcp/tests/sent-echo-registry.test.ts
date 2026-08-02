import { describe, expect, it, vi } from "vitest";
import { normalizeForEcho, SentEchoRegistry } from "../src/sent-echo-registry.js";

const KEY = "test~imsg~beef";

function msg(
  id: number,
  text: string | null,
  opts: { date?: Date; hasAttachments?: boolean } = {},
) {
  return {
    id,
    text,
    date: opts.date ?? new Date(),
    hasAttachments: opts.hasAttachments ?? false,
  };
}

describe("normalizeForEcho", () => {
  it("collapses whitespace, trims, and NFC-normalizes", () => {
    expect(normalizeForEcho("  hello   world \n ")).toBe("hello world");
    // é as e + combining accent normalizes to the precomposed form.
    expect(normalizeForEcho("café")).toBe("café");
    expect(normalizeForEcho(null)).toBe("");
  });
});

describe("SentEchoRegistry", () => {
  it("consumes a matching from-me row exactly once per registered send", () => {
    const reg = new SentEchoRegistry();
    reg.register(KEY, "deploy now? y/n");
    expect(reg.consume(KEY, msg(100, "deploy now?  y/n"))).toBe(true);
    // Second DIFFERENT row with same text is NOT consumed (entry pinned to 100).
    expect(reg.consume(KEY, msg(101, "deploy now? y/n"))).toBe(false);
    // Re-seeing the pinned row stays suppressed (idempotent across polls).
    expect(reg.consume(KEY, msg(100, "deploy now? y/n"))).toBe(true);
  });

  it("pinned id survives the message being edited later", () => {
    const reg = new SentEchoRegistry();
    reg.register(KEY, "original text");
    expect(reg.consume(KEY, msg(50, "original text"))).toBe(true);
    expect(reg.consume(KEY, msg(50, "edited to something else"))).toBe(true);
  });

  it("does not consume messages for other chat keys", () => {
    const reg = new SentEchoRegistry();
    reg.register(KEY, "hi");
    expect(reg.consume("other~imsg~0000", msg(1, "hi"))).toBe(false);
  });

  it("two identical sends need two consumptions", () => {
    const reg = new SentEchoRegistry();
    reg.register(KEY, "ok");
    reg.register(KEY, "ok");
    expect(reg.consume(KEY, msg(1, "ok"))).toBe(true);
    expect(reg.consume(KEY, msg(2, "ok"))).toBe(true);
    expect(reg.consume(KEY, msg(3, "ok"))).toBe(false);
  });

  it("rejects rows dated before the send (minus skew)", () => {
    const reg = new SentEchoRegistry({ skewMs: 1_000 });
    reg.register(KEY, "hello");
    const old = new Date(Date.now() - 60_000);
    expect(reg.consume(KEY, msg(1, "hello", { date: old }))).toBe(false);
  });

  it("attachment echoes only match rows that carry attachments", () => {
    const reg = new SentEchoRegistry();
    reg.register(KEY, "", "attachment");
    expect(reg.consume(KEY, msg(1, null))).toBe(false);
    expect(reg.consume(KEY, msg(2, null, { hasAttachments: true }))).toBe(true);
  });

  it("entries expire after the window", () => {
    vi.useFakeTimers();
    try {
      const reg = new SentEchoRegistry({ windowMs: 1_000 });
      reg.register(KEY, "stale");
      vi.advanceTimersByTime(2_000);
      expect(reg.consume(KEY, msg(1, "stale"))).toBe(false);
      expect(reg.size()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps stored entries (FIFO eviction)", () => {
    const reg = new SentEchoRegistry({ maxEntries: 3 });
    for (let i = 0; i < 10; i++) reg.register(KEY, `m${i}`);
    expect(reg.size()).toBe(3);
    expect(reg.consume(KEY, msg(1, "m9"))).toBe(true);
    expect(reg.consume(KEY, msg(2, "m0"))).toBe(false);
  });
});
