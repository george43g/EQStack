import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSpec, checkUsageFile } from "./gen-usage.js";

describe("scripts/gen-usage.ts --check", () => {
  let tmpDir: string;
  let usageFile: string;
  let fresh: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gen-usage-test-"));
    usageFile = path.join(tmpDir, "usage.kdl");
    fresh = buildSpec();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("accepts a usage spec that is in sync with the commander tree", () => {
    fs.writeFileSync(usageFile, fresh);
    expect(checkUsageFile(usageFile, fresh)).toEqual({
      ok: true,
      message: expect.stringMatching(/in sync/),
    });
  });

  it("rejects a usage spec that drifts from the commander tree", () => {
    fs.writeFileSync(usageFile, "// intentionally drifted by test\n");
    expect(checkUsageFile(usageFile, fresh)).toEqual({
      ok: false,
      message: expect.stringMatching(/out of date/),
    });
  });

  it("rejects a missing usage spec", () => {
    expect(checkUsageFile(usageFile, fresh)).toEqual({
      ok: false,
      message: expect.stringMatching(/missing/),
    });
  });
});
