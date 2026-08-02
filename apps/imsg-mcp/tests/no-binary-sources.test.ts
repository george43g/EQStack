/**
 * Guard: no tracked source file may contain a NUL byte.
 *
 * A single NUL makes git classify a `.ts`/`.tsx` file as *binary* — diffs show
 * "Binary files differ", blame stops working, and code review can't see the
 * change. It slips past biome, tsc, and vitest (all of which happily parse the
 * surrounding text), so nothing else catches it. Regression: a fixture string
 * `Buffer.from("bplist00\0Samc…")` embedded a literal NUL and turned
 * tests/unsent-message-flags.test.ts binary.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOTS = ["src", "tests"];
const EXTS = [".ts", ".tsx"];

function collect(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      collect(p, out);
    } else if (EXTS.some((e) => entry.name.endsWith(e))) {
      out.push(p);
    }
  }
  return out;
}

describe("no NUL bytes in source files", () => {
  it("every src/ and tests/ .ts(x) file is text (no NUL → git keeps it diffable)", () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of collect(root)) {
        if (readFileSync(file).includes(0x00)) offenders.push(file);
      }
    }
    expect(
      offenders,
      `NUL byte found (git will treat these as binary): ${offenders.join(", ")}`,
    ).toEqual([]);
  });
});
