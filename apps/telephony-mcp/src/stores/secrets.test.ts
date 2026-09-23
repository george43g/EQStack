import { describe, expect, it } from "vitest";
import { EnvKeychainSecretProvider, type ExecFileFn } from "./secrets.js";

const NAME = "TEL_TEST_SECRET_NOT_IN_ENV";

function failing(code: unknown): { exec: ExecFileFn; calls: () => number } {
  let n = 0;
  const exec: ExecFileFn = async () => {
    n += 1;
    throw Object.assign(new Error("security failed"), { code });
  };
  return { exec, calls: () => n };
}

describe.skipIf(process.platform !== "darwin")("EnvKeychainSecretProvider miss caching", () => {
  it("caches a definite not-found (exit 44) so it is not re-queried", async () => {
    const f = failing(44);
    const p = new EnvKeychainSecretProvider(f.exec);
    expect(await p.get(NAME)).toBeNull();
    expect(await p.get(NAME)).toBeNull();
    expect(f.calls()).toBe(1);
  });

  it("does NOT cache a transient failure (timeout/kill), so a later call retries", async () => {
    let n = 0;
    const exec: ExecFileFn = async () => {
      n += 1;
      if (n === 1) throw Object.assign(new Error("timed out"), { code: null, killed: true });
      return { stdout: "value\n" };
    };
    const p = new EnvKeychainSecretProvider(exec);
    expect(await p.get(NAME)).toBeNull();
    expect(await p.get(NAME)).toBe("value");
    expect(n).toBe(2);
  });
});
