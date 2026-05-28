import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetForTests, isAuthError, wrapToolError } from "./auth-errors.js";

describe("isAuthError", () => {
  it.each([
    new Error("invalid_grant"),
    new Error("Error: Invalid Credentials"),
    new Error("invalid grant: token expired"),
    Object.assign(new Error("permission denied"), { code: 403 }),
    Object.assign(new Error("unauthorized"), { status: 401 }),
  ])("classifies %s as auth error", (err) => {
    expect(isAuthError(err)).toBe(true);
  });

  it("returns false for non-auth errors", () => {
    expect(isAuthError(new Error("network unreachable"))).toBe(false);
    expect(isAuthError(new Error("rate limit"))).toBe(false);
    expect(isAuthError(null)).toBe(false);
    expect(isAuthError(undefined)).toBe(false);
    expect(isAuthError("string error")).toBe(false);
  });
});

describe("wrapToolError", () => {
  beforeEach(() => {
    _resetForTests();
  });

  it("includes tool name and message for non-auth errors", async () => {
    const res = await wrapToolError(new Error("kaboom"), "search_emails", null);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("search_emails failed");
    expect(res.content[0].text).toContain("kaboom");
    expect(res.content[0].text).not.toContain("re-authenticate");
  });

  it("includes remediation hint for auth errors", async () => {
    const res = await wrapToolError(
      new Error("Error: Invalid Credentials"),
      "list_email_labels",
      null,
    );
    expect(res.content[0].text).toContain("list_email_labels failed");
    expect(res.content[0].text).toContain("re-authenticate");
    expect(res.content[0].text).toContain("gmail account auth");
  });

  it("attempts refresh on invalid_grant (only once)", async () => {
    const getAccessToken = vi
      .fn()
      .mockResolvedValueOnce({ token: "new-access-token" })
      .mockResolvedValueOnce({ token: "should-not-be-called" });
    const client = { getAccessToken } as unknown as Parameters<typeof wrapToolError>[2];

    const first = await wrapToolError(new Error("invalid_grant"), "tool_a", client);
    expect(first.content[0].text).toContain("auth token was refreshed");
    expect(getAccessToken).toHaveBeenCalledTimes(1);

    // Second invalid_grant within the same process — should NOT call again
    const second = await wrapToolError(new Error("invalid_grant"), "tool_b", client);
    expect(getAccessToken).toHaveBeenCalledTimes(1);
    expect(second.content[0].text).toContain("re-authenticate");
  });

  it("falls back to re-auth hint when refresh fails", async () => {
    const getAccessToken = vi.fn().mockRejectedValue(new Error("invalid_grant"));
    const client = { getAccessToken } as unknown as Parameters<typeof wrapToolError>[2];

    const res = await wrapToolError(new Error("invalid_grant"), "send_email", client);
    expect(res.content[0].text).toContain("re-authenticate");
    expect(res.content[0].text).toContain("gmail account auth");
  });

  it("handles non-Error inputs", async () => {
    const res = await wrapToolError("string error", "unknown_tool", null);
    expect(res.content[0].text).toContain("unknown_tool failed");
    expect(res.content[0].text).toContain("string error");
  });
});

afterEach(() => {
  _resetForTests();
});
