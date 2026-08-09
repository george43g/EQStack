/**
 * Regression test: the TUI must NOT enable any-event mouse tracking
 * (?1003h). That mode floods stdin with one event per pixel of mouse
 * motion, which pinned the event loop at ~950ms p99 lag and burned 100%
 * CPU before this was caught. The hook should use ?1000h
 * (button-event-only — clicks + scroll wheel).
 *
 * Since the migration to `@george43g/tui-kit` (whose `useMouse` is the
 * lifted copy of imsg's original hook), this pins the KIT's published
 * source — the tarball ships `src/`, so the pin now guards against
 * upstream regressions of the same incident. If a future kit version
 * reverts to ?1003h, this fails loudly before it reaches a user.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

// The kit's exports map doesn't expose "./package.json", so resolve the main
// entry (<root>/dist/index.js) and walk up to the package root.
const require = createRequire(import.meta.url);
const kitRoot = dirname(dirname(require.resolve("@george43g/tui-kit")));
const SRC = readFileSync(join(kitRoot, "src/hooks/useMouse.ts"), "utf8");

/** Strip block comments + line comments before scanning code for escapes. */
function stripComments(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

describe("useMouse hook (@george43g/tui-kit)", () => {
  const code = stripComments(SRC);

  it("does NOT emit ?1003h (any-event mouse tracking — floods event loop)", () => {
    expect(code).not.toContain("?1003h");
    expect(code).not.toContain("?1003l");
  });

  it("emits ?1000h (button-event tracking — clicks + scroll only)", () => {
    expect(code).toContain("?1000h");
    expect(code).toContain("?1000l");
  });

  it("emits ?1006h (SGR extended coordinates) so x/y aren't capped at 223", () => {
    expect(code).toContain("?1006h");
  });
});
