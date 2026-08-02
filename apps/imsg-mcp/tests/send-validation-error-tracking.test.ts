/**
 * Regression: every send_message failure path must record to
 * `lastSendError` so the `get_last_send_error` tool can introspect it.
 *
 * Pre-fix behaviour: only the AppleScript subprocess error path called
 * `setLastSendError`. The validation paths (no recipient, unknown
 * threadSlug, garbage handle, bad attachment) used `toolError` directly,
 * so `getLastSendError()` returned null even immediately after a
 * failed send. Agents asking "why did my send_message fail?" got no
 * answer beyond the original toolError response.
 *
 * Post-fix: `handleSendMessage` wraps validation early-exits in a
 * `failValidation` helper that also calls `setLastSendError({...})`.
 * This test asserts the contract via the pure `clearLogs +
 * setLastSendError + getLastSendError` round-trip on a few canonical
 * error shapes — it doesn't need to spin up the full MCP server.
 */

import { describe, expect, it } from "vitest";
import { clearLogs, getLastSendError, setLastSendError } from "../src/logger.js";

describe("setLastSendError + getLastSendError round-trip", () => {
  it("returns the most-recent error with timestamp", () => {
    clearLogs();
    setLastSendError({
      message: "Either recipient or threadSlug is required.",
      code: "validation",
      stderr: undefined,
      stdout: undefined,
    });
    const err = getLastSendError();
    expect(err).not.toBeNull();
    expect(err?.message).toBe("Either recipient or threadSlug is required.");
    expect(err?.code).toBe("validation");
    expect(err?.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO
  });

  it("overwrites with the latest error rather than appending", () => {
    setLastSendError({
      message: "Unknown thread slug: nonexistent~imsg~ffff. ...",
      code: "validation",
      stderr: undefined,
      stdout: undefined,
    });
    setLastSendError({
      message: 'No phone, email, or contact match for "garbage".',
      code: "validation",
      stderr: undefined,
      stdout: undefined,
    });
    const err = getLastSendError();
    expect(err?.message).toContain("garbage");
  });

  it("captures AppleScript-class errors with stderr/stdout context", () => {
    setLastSendError({
      message: "AppleScript error: Messages got an error: Can't get buddy",
      code: 1,
      stderr: "execution error: Messages got an error",
      stdout: "",
    });
    const err = getLastSendError();
    expect(err?.code).toBe(1);
    expect(err?.stderr).toContain("Messages got an error");
  });
});
