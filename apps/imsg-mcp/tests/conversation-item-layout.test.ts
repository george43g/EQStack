import { describe, expect, it } from "vitest";
import { nameBudget } from "../src/tui/components/ConversationItem.js";

/**
 * Pin the name-truncation budget contract.
 * Bug: long names + relative date used to overflow the row, wrapping the
 * date onto the next line and obscuring the snippet below. The fix is a
 * deterministic budget for the truncated name.
 */
describe("ConversationItem name budget", () => {
  it("reserves space for line number, cursor, icons, count, and time", () => {
    // No unread, not group, width 50
    const budget = nameBudget(50, false, 0, false);
    // 50 - 4 (linenum) - 2 (cursor) - 0 (env) - 0 (group) - 0 (count) - 2 (icon) - 9 (time) - 2 (padding) = 31
    expect(budget).toBe(31);
  });

  it("subtracts unread envelope + count badge when hasUnread", () => {
    const noUnread = nameBudget(50, false, 0, false);
    const withUnread = nameBudget(50, true, 5, false);
    // withUnread loses 2 (envelope) + 4 (" (5)") = 6
    expect(noUnread - withUnread).toBe(6);
  });

  it("subtracts group icon when isGroupChat", () => {
    const noGroup = nameBudget(50, false, 0, false);
    const withGroup = nameBudget(50, false, 0, true);
    expect(noGroup - withGroup).toBe(2);
  });

  it("clamps to a minimum of 8 chars even on tiny widths", () => {
    expect(nameBudget(20, true, 99, true)).toBe(8);
    expect(nameBudget(5, true, 99, true)).toBe(8);
  });

  it("scales linearly with width", () => {
    const w50 = nameBudget(50, false, 0, false);
    const w100 = nameBudget(100, false, 0, false);
    expect(w100 - w50).toBe(50);
  });
});
