import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IMessageMCPServer } from "../src/index.js";
import { DEV_TOOL_NAMES, getActiveTools, TOOLS } from "../src/mcp-tools.js";

describe("dev-only tool gating", () => {
  const originalImsgDev = process.env.IMSG_DEV;

  beforeEach(() => {
    delete process.env.IMSG_DEV;
  });

  afterEach(() => {
    if (originalImsgDev === undefined) delete process.env.IMSG_DEV;
    else process.env.IMSG_DEV = originalImsgDev;
  });

  it("hides dev tools from tools/list when IMSG_DEV is unset", () => {
    const active = getActiveTools();
    const activeNames = new Set(active.map((t) => t.name));
    for (const dev of DEV_TOOL_NAMES) {
      expect(activeNames.has(dev)).toBe(false);
    }
    expect(active.length).toBe(TOOLS.length - DEV_TOOL_NAMES.size);
  });

  it("exposes every tool when IMSG_DEV=1", () => {
    process.env.IMSG_DEV = "1";
    const active = getActiveTools();
    const activeNames = new Set(active.map((t) => t.name));
    for (const dev of DEV_TOOL_NAMES) {
      expect(activeNames.has(dev)).toBe(true);
    }
    expect(active.length).toBe(TOOLS.length);
  });

  it("rejects dev tool calls in prod mode at the dispatcher", async () => {
    const server = new IMessageMCPServer() as any;
    try {
      await expect(server.dispatchTool("request_restart", {})).rejects.toThrow(
        /Unknown tool: request_restart/,
      );
    } finally {
      await server.db?.close();
    }
  });
});
