/**
 * Regression: `checkImessageAvailability` must reject garbage input
 * BEFORE delegating to AppleScript.
 *
 * Pre-fix bug: Messages.app's `buddy "..." of account` lazily resolves
 * any string into a buddy reference — even literal nonsense like
 * "not-a-handle" or "asdf". AppleScript returned "iMessage" and the
 * MCP reported `reachable: true`. Callers using this as a preflight to
 * decide whether to attempt send_message wasted a real send on an
 * unsendable handle.
 *
 * Post-fix: handle format is validated via the exported
 * `validateAvailabilityHandle` helper before the AppleScript probe.
 * Phone-like (E.164 or digits-with-separators) and email-shaped
 * strings pass through; everything else returns `reachable: false`
 * with a hint.
 *
 * Note: we test the pure helper rather than the full async function
 * because `checkImessageAvailability`'s MOCK shortcut is set at module
 * load time (under VITEST) and would otherwise short-circuit before
 * the validator runs.
 */

import { describe, expect, it } from "vitest";
import { validateAvailabilityHandle } from "../src/applescript.js";

describe("validateAvailabilityHandle", () => {
  it("returns null for valid E.164 phones", () => {
    for (const ok of ["+61401990797", "+1 415 555 0123", "+44-7700-900-123"]) {
      expect(validateAvailabilityHandle(ok)).toBeNull();
    }
  });

  it("returns null for valid emails", () => {
    for (const ok of ["alice@icloud.com", "bob+tag@example.co.uk"]) {
      expect(validateAvailabilityHandle(ok)).toBeNull();
    }
  });

  it("flags garbage strings as unreachable with a hint", () => {
    for (const bad of ["not-a-handle", "asdf", "hello world", "12345"]) {
      const r = validateAvailabilityHandle(bad);
      expect(r, `expected ${JSON.stringify(bad)} flagged`).not.toBeNull();
      expect(r?.reachable).toBe(false);
      expect(r?.service).toBe("unknown");
      expect(r?.hint).toMatch(/email|phone/i);
    }
  });

  it("flags empty / whitespace-only handles", () => {
    for (const bad of ["", "   ", "\t\n"]) {
      const r = validateAvailabilityHandle(bad);
      expect(r?.reachable).toBe(false);
    }
  });

  it("flags phone-shaped strings outside 6-15 digits", () => {
    expect(validateAvailabilityHandle("+1234")?.reachable).toBe(false);
    expect(validateAvailabilityHandle("+12345678901234567")?.reachable).toBe(false);
  });

  it("flags emails missing TLD or @", () => {
    expect(validateAvailabilityHandle("alice@example")?.reachable).toBe(false);
    expect(validateAvailabilityHandle("alice.example.com")?.reachable).toBe(false);
  });
});
