/**
 * Every advertised tool schema must be readable by a 2020-12-only MCP client.
 * Claude Code 2.1.292 rejects a declared `$schema` other than 2020-12
 * ("Tool 'resolve_conversation' has an invalid outputSchema"); an unlabelled
 * schema is read as 2020-12 (MCP spec default).
 */
import { afterEach, describe, expect, it } from "vitest";
import { getActiveTools } from "../src/mcp-tools.js";

const ALLOWED = new Set([undefined, "https://json-schema.org/draft/2020-12/schema"]);

describe("MCP tool schema dialect", () => {
  const prev = process.env.IMSG_DEV;
  afterEach(() => {
    if (prev === undefined) delete process.env.IMSG_DEV;
    else process.env.IMSG_DEV = prev;
  });

  it("declares no dialect other than 2020-12 on any input or output schema", () => {
    process.env.IMSG_DEV = "1"; // include the dev-only tools
    const tools = getActiveTools();
    expect(tools.length).toBeGreaterThan(0);
    const offenders = tools.flatMap((t) =>
      (["inputSchema", "outputSchema"] as const)
        .filter((k) => t[k] && !ALLOWED.has((t[k] as { $schema?: string }).$schema))
        .map((k) => `${t.name}.${k}`),
    );
    expect(offenders).toEqual([]);
  });

  it("still advertises an object outputSchema for resolve_conversation", () => {
    process.env.IMSG_DEV = "1";
    const tool = getActiveTools().find((t) => t.name === "resolve_conversation");
    expect(tool?.outputSchema?.type).toBe("object");
  });
});
