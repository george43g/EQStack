import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { envBool, envNum, envStr } from "./env.js";

const KEY = "MCP_TEST_ENV_VAR";

describe("envNum", () => {
  beforeEach(() => {
    delete process.env[KEY];
  });
  afterEach(() => {
    delete process.env[KEY];
  });

  it("returns fallback when unset", () => {
    expect(envNum(KEY, 42)).toBe(42);
  });

  it("returns fallback when empty string", () => {
    process.env[KEY] = "";
    expect(envNum(KEY, 7)).toBe(7);
  });

  it("parses positive integer", () => {
    process.env[KEY] = "100";
    expect(envNum(KEY, 0)).toBe(100);
  });

  it("accepts zero", () => {
    process.env[KEY] = "0";
    expect(envNum(KEY, 5)).toBe(0);
  });

  it("falls back on non-numeric input", () => {
    process.env[KEY] = "banana";
    expect(envNum(KEY, 9)).toBe(9);
  });

  it("falls back on negative input", () => {
    process.env[KEY] = "-3";
    expect(envNum(KEY, 11)).toBe(11);
  });

  it("parses leading-integer strings via parseInt", () => {
    process.env[KEY] = "50ms";
    expect(envNum(KEY, 0)).toBe(50);
  });
});

describe("envBool", () => {
  beforeEach(() => {
    delete process.env[KEY];
  });
  afterEach(() => {
    delete process.env[KEY];
  });

  it("returns fallback when unset", () => {
    expect(envBool(KEY, true)).toBe(true);
    expect(envBool(KEY, false)).toBe(false);
  });

  it.each(["1", "true", "TRUE", "yes", "on", "  True  "])("parses %p as true", (raw) => {
    process.env[KEY] = raw;
    expect(envBool(KEY, false)).toBe(true);
  });

  it.each(["0", "false", "FALSE", "no", "off"])("parses %p as false", (raw) => {
    process.env[KEY] = raw;
    expect(envBool(KEY, true)).toBe(false);
  });

  it("falls back on unrecognized value", () => {
    process.env[KEY] = "maybe";
    expect(envBool(KEY, true)).toBe(true);
    expect(envBool(KEY, false)).toBe(false);
  });
});

describe("envStr", () => {
  beforeEach(() => {
    delete process.env[KEY];
  });
  afterEach(() => {
    delete process.env[KEY];
  });

  it("returns fallback when unset", () => {
    expect(envStr(KEY, "default")).toBe("default");
  });

  it("returns fallback when empty string", () => {
    process.env[KEY] = "";
    expect(envStr(KEY, "default")).toBe("default");
  });

  it("returns set value", () => {
    process.env[KEY] = "hello";
    expect(envStr(KEY, "default")).toBe("hello");
  });

  it("preserves whitespace", () => {
    process.env[KEY] = "  spaced  ";
    expect(envStr(KEY, "default")).toBe("  spaced  ");
  });
});
