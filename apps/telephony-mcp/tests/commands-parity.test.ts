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
import { ALL_COMMANDS, COMMAND_NAMES, LOCAL_COMMANDS } from "../src/commands/specs.js";
import { ROUTED_COMMANDS } from "../src/gateway/admin-server.js";

const registry = buildClientRegistry({
  admin: {} as never,
  openReadStore: () => null,
});

describe("command surface parity", () => {
  it("golden pin: exactly these 18 commands exist (voice preview added three; consult adds answer_consult — 16 → 17; group calls add start_meeting — 17 → 18, on purpose)", () => {
    expect([...COMMAND_NAMES].sort()).toEqual(
      [
        "place_call",
        "start_meeting",
        "get_latency_report",
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
        "answer_consult",
        "preview_voices",
        "review_voice_preview",
        "save_voice_profile",
      ].sort(),
    );
  });

  it("registry serves every spec and nothing else", () => {
    expect(registry.tools.map((t) => t.name).sort()).toEqual([...COMMAND_NAMES].sort());
    for (const name of COMMAND_NAMES) expect(registry.get(name)).toBeDefined();
  });

  it("every mutating command has a REST route row, or is a pinned local command", () => {
    const mutating = ALL_COMMANDS.filter((c) => c.annotations.readOnlyHint !== true).map(
      (c) => c.name,
    );
    for (const name of mutating) {
      if (LOCAL_COMMANDS.includes(name)) continue;
      expect(ROUTED_COMMANDS).toContain(name);
    }
  });

  it("local commands are pinned: they never touch the call DB, so they skip the admin API", () => {
    expect([...LOCAL_COMMANDS].sort()).toEqual(["preview_voices", "save_voice_profile"]);
    for (const name of LOCAL_COMMANDS) expect(ROUTED_COMMANDS).not.toContain(name);
  });

  it("every REST route row maps to a registered command", () => {
    for (const name of ROUTED_COMMANDS) expect(registry.get(name)).toBeDefined();
  });

  it("console/MCP listing derives from the registry (18 tools, schemas attached)", () => {
    const tools = registry.toMcpTools();
    expect(tools).toHaveLength(18);
    for (const t of tools) {
      expect(t.inputSchema).toBeDefined();
      expect(t.description?.length ?? 0).toBeGreaterThan(0);
    }
  });
});
