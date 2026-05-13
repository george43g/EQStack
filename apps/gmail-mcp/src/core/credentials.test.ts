import { describe, expect, it, vi } from "vitest";
import { CredentialLoadError, loadCredentials } from "./credentials.js";

function makeStubs(overrides: Partial<Parameters<typeof loadCredentials>[0]> = {}) {
  return {
    fileExists: vi.fn(() => false),
    readFile: vi.fn(() => ""),
    runOp: vi.fn(async () => ""),
    ...overrides,
  };
}

describe("loadCredentials precedence", () => {
  it("env JSON wins over 1Password and file", async () => {
    const stubs = makeStubs();
    const result = await loadCredentials({
      env: {
        GMAIL_CREDENTIALS_JSON: JSON.stringify({
          tokens: { access_token: "from-env" },
          scopes: ["gmail.readonly"],
        }),
        GMAIL_CREDENTIALS_OP: "op://Personal/foo/bar",
        GMAIL_CREDENTIALS_PATH: "/tmp/should-not-read",
      },
      ...stubs,
    });
    expect(result.source).toBe("env-json");
    expect(result.credentials.tokens.access_token).toBe("from-env");
    expect(result.credentials.scopes).toEqual(["gmail.readonly"]);
    expect(stubs.runOp).not.toHaveBeenCalled();
    expect(stubs.fileExists).not.toHaveBeenCalled();
  });

  it("1Password wins over file when env JSON missing", async () => {
    const runOp = vi.fn(async () =>
      JSON.stringify({ tokens: { access_token: "from-op" }, scopes: ["gmail.modify"] }),
    );
    const stubs = makeStubs({ runOp });
    const result = await loadCredentials({
      env: {
        GMAIL_CREDENTIALS_OP: "op://Personal/gmail-mcp/credentials",
        GMAIL_CREDENTIALS_PATH: "/tmp/should-not-read",
      },
      ...stubs,
    });
    expect(result.source).toBe("1password");
    expect(result.locator).toBe("op://Personal/gmail-mcp/credentials");
    expect(result.credentials.tokens.access_token).toBe("from-op");
    expect(runOp).toHaveBeenCalledOnce();
    expect(runOp).toHaveBeenCalledWith("op://Personal/gmail-mcp/credentials");
    expect(stubs.fileExists).not.toHaveBeenCalled();
  });

  it("falls back to file when env JSON and 1Password unset", async () => {
    const stubs = makeStubs({
      fileExists: vi.fn(() => true),
      readFile: vi.fn(() =>
        JSON.stringify({ tokens: { access_token: "from-file" }, scopes: ["gmail.modify"] }),
      ),
    });
    const result = await loadCredentials({
      env: { GMAIL_CREDENTIALS_PATH: "/tmp/creds.json" },
      ...stubs,
    });
    expect(result.source).toBe("file");
    expect(result.locator).toBe("/tmp/creds.json");
    expect(result.credentials.tokens.access_token).toBe("from-file");
  });

  it("uses fallbackPath when GMAIL_CREDENTIALS_PATH unset", async () => {
    const stubs = makeStubs({
      fileExists: vi.fn(() => true),
      readFile: vi.fn(() => JSON.stringify({ tokens: { access_token: "fallback" } })),
    });
    const result = await loadCredentials({
      env: {},
      fallbackPath: "/home/x/.gmail-mcp/credentials.json",
      ...stubs,
    });
    expect(result.source).toBe("file");
    expect(result.locator).toBe("/home/x/.gmail-mcp/credentials.json");
  });
});

describe("loadCredentials errors", () => {
  it("throws when no source configured", async () => {
    const stubs = makeStubs();
    await expect(loadCredentials({ env: {}, ...stubs })).rejects.toBeInstanceOf(
      CredentialLoadError,
    );
  });

  it("throws when file missing", async () => {
    const stubs = makeStubs({ fileExists: vi.fn(() => false) });
    await expect(
      loadCredentials({ env: { GMAIL_CREDENTIALS_PATH: "/nope" }, ...stubs }),
    ).rejects.toMatchObject({ source: "file" });
  });

  it("rejects non-op:// 1Password reference", async () => {
    const stubs = makeStubs();
    await expect(
      loadCredentials({ env: { GMAIL_CREDENTIALS_OP: "not-an-op-ref" }, ...stubs }),
    ).rejects.toMatchObject({ source: "1password" });
  });

  it("wraps op CLI ENOENT with install hint", async () => {
    const enoent = Object.assign(new Error("spawn op ENOENT"), { code: "ENOENT" });
    const stubs = makeStubs({
      runOp: vi.fn(async () => {
        throw enoent;
      }),
    });
    await expect(
      loadCredentials({
        env: { GMAIL_CREDENTIALS_OP: "op://v/i/f" },
        ...stubs,
      }),
    ).rejects.toMatchObject({
      source: "1password",
      message: expect.stringContaining("`op` CLI not found"),
    });
  });

  it("rejects malformed JSON from any source", async () => {
    const stubs = makeStubs();
    await expect(
      loadCredentials({ env: { GMAIL_CREDENTIALS_JSON: "{{{not json" }, ...stubs }),
    ).rejects.toMatchObject({ source: "env-json" });
  });

  it("ignores empty/whitespace env vars", async () => {
    const stubs = makeStubs({
      fileExists: vi.fn(() => true),
      readFile: vi.fn(() => JSON.stringify({ tokens: { x: 1 } })),
    });
    const result = await loadCredentials({
      env: {
        GMAIL_CREDENTIALS_JSON: "   ",
        GMAIL_CREDENTIALS_OP: "",
        GMAIL_CREDENTIALS_PATH: "/tmp/c.json",
      },
      ...stubs,
    });
    expect(result.source).toBe("file");
  });
});

describe("loadCredentials shape compatibility", () => {
  it("supports the canonical {tokens, scopes} shape", async () => {
    const result = await loadCredentials({
      env: {
        GMAIL_CREDENTIALS_JSON: JSON.stringify({
          tokens: { access_token: "a", refresh_token: "r" },
          scopes: ["gmail.modify"],
        }),
      },
      ...makeStubs(),
    });
    expect(result.credentials.tokens).toEqual({ access_token: "a", refresh_token: "r" });
    expect(result.credentials.scopes).toEqual(["gmail.modify"]);
  });

  it("supports the legacy bare-tokens shape (no `tokens` wrapper)", async () => {
    const result = await loadCredentials({
      env: {
        GMAIL_CREDENTIALS_JSON: JSON.stringify({
          access_token: "a",
          refresh_token: "r",
          expiry_date: 12345,
        }),
      },
      ...makeStubs(),
    });
    expect(result.credentials.tokens).toEqual({
      access_token: "a",
      refresh_token: "r",
      expiry_date: 12345,
    });
    expect(result.credentials.scopes).toBeUndefined();
  });
});
