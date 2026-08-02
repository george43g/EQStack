import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { APP_VERSION } from "../src/meta.js";

describe("APP_VERSION", () => {
  it("matches package.json (single source of truth, injected by Vite define)", () => {
    // Regression: APP_VERSION was hardcoded "1.0.0" and drifted for three
    // releases — `imsg --version` and the MCP serverInfo both lied.
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(APP_VERSION).toBe(pkg.version);
  });
});
