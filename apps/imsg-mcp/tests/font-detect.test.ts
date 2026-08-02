/**
 * font-detect — Nerd-Font detection used by the TUI startup warning.
 *
 * The real `fc-list` call is hard to mock cleanly (spawnSync), so most of
 * the suite exercises the cached / shape contract using the actual binary
 * if present. The cache-reset helper lets us isolate cases.
 */

import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { _resetDetectNerdFontCache, detectNerdFont } from "../src/font-detect.js";
import { buildPowerlineFontWarning } from "../src/tui/index.js";

describe("detectNerdFont", () => {
  it("returns a stable shape", () => {
    _resetDetectNerdFontCache();
    const result = detectNerdFont();
    expect(["fc-list", "unavailable"]).toContain(result.source);
    if (result.source === "fc-list") {
      expect(typeof result.detected).toBe("boolean");
    } else {
      expect(result.detected).toBeNull();
      expect(typeof result.reason).toBe("string");
    }
  });

  it("caches subsequent calls (same object reference)", () => {
    _resetDetectNerdFontCache();
    const a = detectNerdFont();
    const b = detectNerdFont();
    expect(a).toBe(b);
  });

  it("matches reality on this machine when fc-list is present", () => {
    _resetDetectNerdFontCache();
    const probe = spawnSync("fc-list", ["--version"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    if (probe.error) {
      // No fc-list on this machine — skip the realism check.
      return;
    }
    const truth = spawnSync("fc-list", [":family"], { encoding: "utf8" });
    const realHasNerd = /Nerd/i.test(truth.stdout ?? "");
    const result = detectNerdFont();
    expect(result.source).toBe("fc-list");
    expect(result.detected).toBe(realHasNerd);
  });
});

describe("buildPowerlineFontWarning", () => {
  it("returns null when a Nerd Font is detected", () => {
    expect(buildPowerlineFontWarning({ detected: true, source: "fc-list" })).toBeNull();
  });

  it("emits a strong warning when fc-list confirms no Nerd Font", () => {
    const msg = buildPowerlineFontWarning({ detected: false, source: "fc-list" });
    expect(msg).not.toBeNull();
    expect(msg).toContain("no Nerd Font was detected");
    expect(msg).toContain("--theme=safe");
  });

  it("emits a soft warning when fc-list is unavailable", () => {
    const msg = buildPowerlineFontWarning({
      detected: null,
      source: "unavailable",
      reason: "spawn fc-list ENOENT",
    });
    expect(msg).not.toBeNull();
    expect(msg).toContain("could not auto-detect");
    expect(msg).toContain("--theme=safe");
  });
});
