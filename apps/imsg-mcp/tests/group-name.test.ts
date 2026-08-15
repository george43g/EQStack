/**
 * Synthesized titles for unnamed group chats (swarm finding: sidebar and
 * drawer showed raw `chat926244..` identifiers wherever a group had no
 * display_name). Core-side so the TUI sidebar, thread header, info drawer,
 * and MCP list_conversations all inherit the same title.
 */
import { describe, expect, it } from "vitest";
import { formatGroupName, groupMemberLabel, synthesizeGroupName } from "../src/group-name.js";

describe("groupMemberLabel", () => {
  it("takes the first name of a resolved contact", () => {
    expect(groupMemberLabel("+15550001111", "Isabella Smith")).toBe("Isabella");
  });

  it("keeps an unresolved handle whole — phone numbers must not be split", () => {
    expect(groupMemberLabel("+15550001111", "+15550001111")).toBe("+15550001111");
  });

  it("keeps emails whole when unresolved", () => {
    expect(groupMemberLabel("a@b.com", "a@b.com")).toBe("a@b.com");
  });

  it("survives a whitespace-only resolved name", () => {
    expect(groupMemberLabel("+15550001111", "   ")).toBe("+15550001111");
  });
});

describe("formatGroupName", () => {
  it("joins up to three names", () => {
    expect(formatGroupName(["Alice", "Bob", "Cara"])).toBe("Alice, Bob, Cara");
  });

  it("collapses the tail into +N", () => {
    expect(formatGroupName(["Alice", "Bob", "Cara", "Dan", "Eve"])).toBe("Alice, Bob, Cara +2");
  });

  it("dedupes case-insensitively (one contact, two handles)", () => {
    expect(formatGroupName(["Alice", "alice", "Bob"])).toBe("Alice, Bob");
  });

  it("drops blanks and returns null when nothing is left", () => {
    expect(formatGroupName(["", "  "])).toBeNull();
    expect(formatGroupName([])).toBeNull();
  });

  it("mixes resolved names and raw handles", () => {
    expect(formatGroupName(["Alice", "+15550002222"])).toBe("Alice, +15550002222");
  });
});

describe("synthesizeGroupName", () => {
  const contacts: Record<string, string> = {
    "+15550001111": "Isabella Smith",
    "+15550002222": "Naomi Jones",
  };
  const resolve = (h: string) => contacts[h] ?? h;

  it("resolves, first-names, and formats", () => {
    expect(synthesizeGroupName(["+15550001111", "+15550002222", "+15550003333"], resolve)).toBe(
      "Isabella, Naomi, +15550003333",
    );
  });

  it("returns null for an empty participant list so callers keep their fallback", () => {
    expect(synthesizeGroupName([], resolve)).toBeNull();
  });
});
