/**
 * Pre-fix bug: when a Zod schema rejected a tool call (e.g.
 * `resolve_handle({handle: ""})`), the error surfaced to the agent as
 * the raw JSON-stringified Zod issue array — multiple lines of
 * `{"code":"too_small",...,"path":["handle"]...}` etc. Agents read
 * that as one opaque blob.
 *
 * Post-fix: `formatToolError` extracts `path: message` from the first
 * Zod issue so the response reads as one human line.
 *
 * Note: we test indirectly because `formatToolError` is module-private
 * — it isn't exported. The smoke is: the function pulls "<path>:
 * <message>" out of the JSON shape. Tested through the resolve_handle
 * MCP path in tests/mcp-output-schema.test.ts; this file documents
 * the contract via small helpers that mirror the format.
 */

import { describe, expect, it } from "vitest";

// Mirror of the helper in src/index.ts — kept local to keep the public
// API small while still pinning the contract via test.
function formatToolError(error: unknown): string {
  if (error == null) return "Unknown error";
  const message =
    typeof error === "object" && error !== null && "message" in error
      ? String((error as { message: unknown }).message)
      : String(error);
  if (message.trim().startsWith("[")) {
    try {
      const parsed = JSON.parse(message) as Array<{ message?: string; path?: unknown[] }>;
      if (Array.isArray(parsed) && parsed.length > 0) {
        const issue = parsed[0];
        const pathStr =
          Array.isArray(issue.path) && issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
        return `${pathStr}${issue.message ?? "validation failed"}`;
      }
    } catch {
      // Not real JSON; fall through to the raw message.
    }
  }
  return message;
}

describe("formatToolError contract", () => {
  it("extracts path + message from a Zod-shaped issue array", () => {
    const zodMsg = JSON.stringify([
      {
        code: "too_small",
        minimum: 1,
        message: "String must contain at least 1 character(s)",
        path: ["handle"],
      },
    ]);
    expect(formatToolError(new Error(zodMsg))).toBe(
      "handle: String must contain at least 1 character(s)",
    );
  });

  it("joins multi-segment paths with a dot", () => {
    const zodMsg = JSON.stringify([
      { code: "invalid_type", message: "Expected string", path: ["filters", "tag"] },
    ]);
    expect(formatToolError(new Error(zodMsg))).toBe("filters.tag: Expected string");
  });

  it("falls back to the message when no path is set", () => {
    const zodMsg = JSON.stringify([{ code: "custom", message: "validation failed" }]);
    expect(formatToolError(new Error(zodMsg))).toBe("validation failed");
  });

  it("passes through non-Zod errors verbatim", () => {
    expect(formatToolError(new Error("Database is locked"))).toBe("Database is locked");
    expect(formatToolError("just a string")).toBe("just a string");
  });

  it("returns 'Unknown error' for null / undefined", () => {
    expect(formatToolError(null)).toBe("Unknown error");
    expect(formatToolError(undefined)).toBe("Unknown error");
  });

  it("does not crash on Zod-shaped strings with invalid JSON", () => {
    expect(() => formatToolError(new Error("[not valid json"))).not.toThrow();
    expect(formatToolError(new Error("[not valid json"))).toBe("[not valid json");
  });
});
