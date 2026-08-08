import { describe, expect, it } from "vitest";
import { lastFour, redactString, redactValue } from "./redact.js";

describe("redaction", () => {
  it("reduces phone numbers to a suffix", () => {
    expect(redactString("call +61400111222 now")).toBe("call …1222 now");
    expect(redactString("+1 415-555-2671")).toBe("…2671");
  });

  it("keeps last-four helper consistent with config-side display", () => {
    expect(lastFour("+61400111222")).toBe("1222");
  });

  it("redacts secret-shaped strings", () => {
    expect(redactString("key sk-or-v1-abcdefghijklmnop here")).toContain("[redacted]");
    expect(redactString("github_pat_11ABCDEFGHIJKLMNOP")).toBe("[redacted]");
    expect(redactString("gho_abcdefghijklmnop123")).toBe("[redacted]");
  });

  it("deep-redacts nested structures", () => {
    const out = redactValue({
      note: "ring +61400111222",
      nested: [{ to: "+61400333444" }],
      n: 7,
    }) as { note: string; nested: Array<{ to: string }>; n: number };
    expect(out.note).toBe("ring …1222");
    expect(out.nested[0]?.to).toBe("…3444");
    expect(out.n).toBe(7);
  });

  it("leaves ordinary text alone", () => {
    expect(redactString("turn 3 took 850ms")).toBe("turn 3 took 850ms");
  });
});
