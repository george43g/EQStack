import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getLogFilePath, info } from "../src/logger.js";

describe("logger IMSG_DEV gating", () => {
  const originalImsgDev = process.env.IMSG_DEV;

  beforeEach(() => {
    delete process.env.IMSG_DEV;
  });

  afterEach(() => {
    if (originalImsgDev === undefined) delete process.env.IMSG_DEV;
    else process.env.IMSG_DEV = originalImsgDev;
  });

  it("does not write to disk when IMSG_DEV is unset", () => {
    const beforePath = getLogFilePath();
    const beforeSize =
      beforePath && existsSync(beforePath) ? readFileSync(beforePath, "utf-8").length : 0;

    info("gating-test-line-should-not-be-written", { sentinel: "unique-prod-mode-marker" });

    // No new file should be created in prod mode...
    if (beforePath && existsSync(beforePath)) {
      const after = readFileSync(beforePath, "utf-8");
      // ...and the existing file (if any from a prior dev-mode test) must not grow.
      expect(after.length).toBe(beforeSize);
      expect(after).not.toContain("unique-prod-mode-marker");
    }
  });

  it("writes to disk when IMSG_DEV=1", () => {
    process.env.IMSG_DEV = "1";
    info("gating-test-line-should-be-written", { sentinel: "unique-dev-mode-marker" });
    const path = getLogFilePath();
    expect(path).not.toBeNull();
    expect(existsSync(path!)).toBe(true);
    const content = readFileSync(path!, "utf-8");
    expect(content).toContain("unique-dev-mode-marker");
  });
});
