import { describe, expect, it } from "vitest";
import { ToolTimeoutError, withTimeout } from "./with-timeout.js";

describe("withTimeout", () => {
  it("resolves when the work finishes under the timeout", async () => {
    const result = await withTimeout(
      "fast",
      async () => {
        await new Promise((r) => setTimeout(r, 10));
        return 42;
      },
      500,
    );
    expect(result).toBe(42);
  });

  it("rejects with ToolTimeoutError when the work exceeds the timeout", async () => {
    const promise = withTimeout("slow", () => new Promise((r) => setTimeout(r, 200)), 20);
    await expect(promise).rejects.toBeInstanceOf(ToolTimeoutError);
    await expect(promise).rejects.toMatchObject({
      toolName: "slow",
      timeoutMs: 20,
    });
  });

  it("includes the tool name in the error message", async () => {
    try {
      await withTimeout("search_emails", () => new Promise((r) => setTimeout(r, 200)), 10);
      throw new Error("expected timeout");
    } catch (e) {
      expect((e as Error).message).toContain("search_emails");
      expect((e as Error).message).toContain("10ms");
    }
  });

  it("propagates errors thrown by the wrapped fn", async () => {
    const promise = withTimeout(
      "throwing",
      async () => {
        throw new Error("boom");
      },
      500,
    );
    await expect(promise).rejects.toThrow("boom");
  });

  it("treats timeoutMs <= 0 as 'no timeout'", async () => {
    const result = await withTimeout(
      "unbounded",
      async () => {
        await new Promise((r) => setTimeout(r, 30));
        return "ok";
      },
      0,
    );
    expect(result).toBe("ok");
  });
});
