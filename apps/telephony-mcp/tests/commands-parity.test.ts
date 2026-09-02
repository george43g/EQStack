/**
 * Structural surface parity (INV-8, Phase B verification 2): a command added
 * to the registry with no adapter coverage fails HERE, not in production.
 *
 * The MCP tool list, the console listing, and the CLI all derive from the
 * same registry (buildClientRegistry), so their parity is structural; this
 * test pins the two places parity is NOT automatic: the golden name list and
 * the REST route table.
 */
import { describe, expect, it } from "vitest";
import { buildClientRegistry } from "../src/commands/bind-client.js";
import { ALL_COMMANDS, COMMAND_NAMES } from "../src/commands/specs.js";
import { ROUTED_COMMANDS } from "../src/gateway/admin-server.js";

const registry = buildClientRegistry({
  admin: {} as never,
  openReadStore: () => null,
});

describe("command surface parity", () => {
  it("golden pin: exactly these 12 commands exist (D-5/D-38: one-shot place_call)", () => {
    expect([...COMMAND_NAMES].sort()).toEqual(
      [
        "place_call",
        "end_call",
        "play_disclosure",
        "say_on_call",
        "set_recording",
        "list_calls",
        "get_call",
        "get_call_events",
        "get_transcript",
        "search_calls",
        "get_recording_metadata",
        "delete_recording",
      ].sort(),
    );
  });

  it("registry serves every spec and nothing else", () => {
    expect(registry.tools.map((t) => t.name).sort()).toEqual([...COMMAND_NAMES].sort());
    for (const name of COMMAND_NAMES) expect(registry.get(name)).toBeDefined();
  });

  it("every mutating command has a REST route row", () => {
    const mutating = ALL_COMMANDS.filter((c) => c.annotations.readOnlyHint !== true).map(
      (c) => c.name,
    );
    for (const name of mutating) expect(ROUTED_COMMANDS).toContain(name);
  });

  it("every REST route row maps to a registered command", () => {
    for (const name of ROUTED_COMMANDS) expect(registry.get(name)).toBeDefined();
  });

  it("console/MCP listing derives from the registry (12 tools, schemas attached)", () => {
    const tools = registry.toMcpTools();
    expect(tools).toHaveLength(12);
    for (const t of tools) {
      expect(t.inputSchema).toBeDefined();
      expect(t.description?.length ?? 0).toBeGreaterThan(0);
    }
  });
});
