import { describe, expect, it } from "vitest";
import {
  buildIdentity,
  buildIdentityFromHandle,
  e164OrOriginal,
  normalizeEmail,
} from "../src/identity.js";

describe("normalizeEmail", () => {
  it("trims and lowercases", () => {
    expect(normalizeEmail("  Alice@Example.COM ")).toBe("alice@example.com");
  });
});

describe("e164OrOriginal", () => {
  it("normalizes a formatted US number to E.164", () => {
    expect(e164OrOriginal("+1 (555) 010-0100", "US")).toBe("+15550100100");
  });
  it("falls back to the trimmed original when un-normalizable", () => {
    expect(e164OrOriginal("  not-a-number  ", "US")).toBe("not-a-number");
  });
});

describe("buildIdentity", () => {
  it("E.164-normalizes phones, lowercases emails, and dedupes each", () => {
    const id = buildIdentity(
      "Alice Doe",
      ["+1 (555) 010-0100", "555-010-0100", "5550100100"],
      ["Alice@Example.COM", "alice@example.com"],
      "US",
    );
    expect(id.canonicalName).toBe("Alice Doe");
    // three formats of the same number collapse to one E.164 handle
    expect(id.phones).toEqual(["+15550100100"]);
    expect(id.emails).toEqual(["alice@example.com"]);
  });

  it("builds `handles` as a deduped union — phones first, then emails", () => {
    const id = buildIdentity("Bob", ["5550100100"], ["bob@x.com"], "US");
    expect(id.handles).toEqual(["+15550100100", "bob@x.com"]);
  });

  it("keeps an un-normalizable phone as-is instead of dropping it", () => {
    const id = buildIdentity("Shortcode", ["262966"], [], "US");
    // 6-digit shortcode isn't E.164-able → preserved verbatim, still a handle.
    expect(id.phones).toEqual(["262966"]);
    expect(id.handles).toEqual(["262966"]);
  });
});

describe("buildIdentityFromHandle", () => {
  it("classifies a phone handle and normalizes it", () => {
    const id = buildIdentityFromHandle("+1 (555) 010-0100", null, "US");
    expect(id.phones).toEqual(["+15550100100"]);
    expect(id.emails).toEqual([]);
    expect(id.handles).toEqual(["+15550100100"]);
    // no name given → canonicalName defaults to the raw handle
    expect(id.canonicalName).toBe("+1 (555) 010-0100");
  });

  it("classifies an email handle and lowercases it", () => {
    const id = buildIdentityFromHandle("Bob@Example.com", "Bob", "US");
    expect(id.emails).toEqual(["bob@example.com"]);
    expect(id.phones).toEqual([]);
    expect(id.handles).toEqual(["bob@example.com"]);
    expect(id.canonicalName).toBe("Bob");
  });
});
