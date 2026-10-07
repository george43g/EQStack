// Every advertised tool schema must be readable by a 2020-12-only MCP client.
// Claude Code 2.1.292 rejects a declared `$schema` other than 2020-12; an
// unlabelled schema is read as 2020-12 (MCP spec default).

import { describe, expect, it } from "vitest";
import { toMcpTools, toolDefinitions } from "./tools.js";

describe("MCP tool schema dialect", () => {
  it("declares no dialect other than 2020-12 on any inputSchema", () => {
    const tools = toMcpTools(toolDefinitions);
    expect(tools.length).toBeGreaterThan(0);
    const offenders = tools
      .filter((t) => {
        const d = (t.inputSchema as { $schema?: string }).$schema;
        return d !== undefined && d !== "https://json-schema.org/draft/2020-12/schema";
      })
      .map((t) => t.name);
    expect(offenders).toEqual([]);
    expect(tools.every((t) => (t.inputSchema as { type?: string }).type === "object")).toBe(true);
  });
});
