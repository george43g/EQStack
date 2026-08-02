import { describe, expect, it } from "vitest";
import type { SetupReport } from "../src/setup.js";
import { buildMcpServerEntry, buildMcpSnippet } from "../src/setup.js";

const cleanReport: SetupReport = {
  imsgDb: { path: "/Users/test/Library/Messages/chat.db", exists: true, readable: true },
  contactsDbs: [
    {
      path: "/Users/test/Library/Application Support/AddressBook/AddressBook-v22.abcddb",
      exists: true,
      readable: true,
    },
  ],
  slugsDb: { path: "/Users/test/.imsg-mcp/slugs.db", exists: true },
  fullDiskAccess: true,
  needsEnvOverrides: false,
};

describe("buildMcpServerEntry", () => {
  const ORIG = { ...process.env };
  const cleanEnv = () => {
    delete process.env.VITE_IMSG_DB_PATH;
    delete process.env.VITE_CONTACTS_DB_PATH;
    delete process.env.VITE_ADDRESS_BOOK_UUID;
    delete process.env.VITE_SLUGS_DB_PATH;
  };
  // Reset env between cases.
  beforeEach(() => {
    cleanEnv();
  });
  afterEach(() => {
    process.env = { ...ORIG };
  });

  it("npx default → no env block when no env overrides are set", () => {
    const entry = buildMcpServerEntry(cleanReport);
    expect(entry).toEqual({ command: "npx", args: ["-y", "imsg-mcp", "mcp"] });
    expect(entry.env).toBeUndefined();
  });

  it("bunx runtime", () => {
    const entry = buildMcpServerEntry(cleanReport, { runtime: "bunx" });
    expect(entry.command).toBe("bunx");
    expect(entry.args).toEqual(["imsg-mcp", "mcp"]);
  });

  it("global runtime — bare command, no args", () => {
    const entry = buildMcpServerEntry(cleanReport, { runtime: "global" });
    expect(entry.command).toBe("imsg");
    expect(entry.args).toEqual(["mcp"]);
  });

  it("forwards explicit env overrides into the env block", () => {
    process.env.VITE_IMSG_DB_PATH = "/custom/chat.db";
    const entry = buildMcpServerEntry(cleanReport);
    expect(entry.env).toEqual({ VITE_IMSG_DB_PATH: "/custom/chat.db" });
  });

  it("forceEnv keys are merged in last", () => {
    const entry = buildMcpServerEntry(cleanReport, {
      forceEnv: { IMSG_TUI_THEME: "powerline" },
    });
    expect(entry.env).toEqual({ IMSG_TUI_THEME: "powerline" });
  });
});

describe("buildMcpSnippet", () => {
  it("emits parseable JSON with mcpServers.imessage", () => {
    const s = buildMcpSnippet(cleanReport);
    const parsed = JSON.parse(s);
    expect(parsed).toHaveProperty("mcpServers.imessage");
    expect(parsed.mcpServers.imessage.command).toBe("npx");
  });

  it("ends with a trailing newline", () => {
    const s = buildMcpSnippet(cleanReport);
    expect(s.endsWith("\n")).toBe(true);
  });
});

// vitest auto-imports beforeEach/afterEach in some setups; reference them
// explicitly so this file is portable.
import { afterEach, beforeEach } from "vitest";
