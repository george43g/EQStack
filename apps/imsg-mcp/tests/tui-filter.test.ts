/**
 * Filter predicate + first-match index — used by Sidebar (rendering) and
 * App.tsx (Enter-to-navigate). Locks in the Enter-commits-cursor-to-first-match
 * fix surfaced by live TUI audit.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  filterMatchIndices,
  firstFilterMatchIndex,
  matchesConversationFilter,
} from "../src/tui/filter.js";
import { type AppState, initialState, reducer } from "../src/tui/types.js";
import type { Conversation } from "../src/types.js";

function conv(overrides: Partial<Conversation>): Conversation {
  return {
    chatIdentifier: "+15555550100",
    displayName: null,
    threadSlug: "abc~imsg~1234",
    lastMessageDate: new Date(0),
    lastMessageSnippet: null,
    unreadCount: 0,
    service: "iMessage",
    isGroup: false,
    chatGuid: "guid1",
    ...overrides,
  };
}

describe("matchesConversationFilter", () => {
  it("matches on displayName (case-insensitive)", () => {
    const c = conv({ displayName: "Brian Osborne" });
    expect(matchesConversationFilter(c, "brian")).toBe(true);
    expect(matchesConversationFilter(c, "BRIAN")).toBe(false); // input must already be lowercased
    expect(matchesConversationFilter(c, "osborne")).toBe(true);
    expect(matchesConversationFilter(c, "nope")).toBe(false);
  });

  it("matches on chatIdentifier substring", () => {
    const c = conv({ chatIdentifier: "+61451544440" });
    expect(matchesConversationFilter(c, "44440")).toBe(true);
    expect(matchesConversationFilter(c, "+61")).toBe(true);
  });

  it("matches on threadSlug substring", () => {
    const c = conv({ threadSlug: "weekend-crew~imsg~d4e5" });
    expect(matchesConversationFilter(c, "weekend")).toBe(true);
    expect(matchesConversationFilter(c, "d4e5")).toBe(true);
  });

  it("returns false when displayName is null and other fields don't match", () => {
    const c = conv({ displayName: null, chatIdentifier: "+15555550100", threadSlug: "foo~bar" });
    expect(matchesConversationFilter(c, "missing")).toBe(false);
  });
});

describe("firstFilterMatchIndex", () => {
  const convs = [
    conv({ displayName: "Aisha", threadSlug: "aisha~imsg~7804" }),
    conv({ displayName: "Brian Osborne", threadSlug: "brian-osborne~imsg~9944" }),
    conv({ displayName: "Mal", threadSlug: "mal~imsg~b03b" }),
  ];

  it("returns the first match index in the ORIGINAL array", () => {
    expect(firstFilterMatchIndex(convs, "brian")).toBe(1);
    expect(firstFilterMatchIndex(convs, "mal")).toBe(2);
  });

  it("returns null when no match", () => {
    expect(firstFilterMatchIndex(convs, "xyz")).toBeNull();
  });

  it("returns null for empty/whitespace query (does not over-match)", () => {
    expect(firstFilterMatchIndex(convs, "")).toBeNull();
    expect(firstFilterMatchIndex(convs, "   ")).toBeNull();
  });

  it("is case-insensitive (trims and lowercases query)", () => {
    expect(firstFilterMatchIndex(convs, "  BRIAN  ")).toBe(1);
  });
});

describe("filterMatchIndices", () => {
  const convs = [
    conv({ displayName: "Alice", threadSlug: "alice~imsg~0001" }),
    conv({ displayName: "Bob", threadSlug: "bob~imsg~0002" }),
    conv({ displayName: "Alan", threadSlug: "alan~imsg~0003" }),
    conv({ displayName: "Carol", threadSlug: "carol~imsg~0004" }),
    conv({ displayName: "Alba", threadSlug: "alba~imsg~0005" }),
  ];

  it("returns every index for an empty query (mirrors the unfiltered Sidebar)", () => {
    expect(filterMatchIndices(convs, "")).toEqual([0, 1, 2, 3, 4]);
  });

  it("returns matching indices in original-array order", () => {
    // "al" → Alice(0), Alan(2), Alba(4)
    expect(filterMatchIndices(convs, "al")).toEqual([0, 2, 4]);
  });

  it("returns an empty array when nothing matches", () => {
    expect(filterMatchIndices(convs, "zzz")).toEqual([]);
  });
});

describe("filter-mode cursor navigation (FILTER_MOVE reducer)", () => {
  const convs = [
    conv({ displayName: "Alice", threadSlug: "alice~imsg~0001" }),
    conv({ displayName: "Bob", threadSlug: "bob~imsg~0002" }),
    conv({ displayName: "Alan", threadSlug: "alan~imsg~0003" }),
    conv({ displayName: "Carol", threadSlug: "carol~imsg~0004" }),
    conv({ displayName: "Alba", threadSlug: "alba~imsg~0005" }),
  ];

  function filtering(query: string): AppState {
    let s: AppState = { ...initialState, conversations: convs };
    s = reducer(s, { type: "ENTER_FILTER" });
    return reducer(s, { type: "UPDATE_FILTER", query });
  }

  it("starts the cursor at the first match", () => {
    expect(filtering("al").filterCursor).toBe(0);
  });

  it("moves the cursor down through the matches", () => {
    let s = filtering("al"); // 3 matches
    s = reducer(s, { type: "FILTER_MOVE", delta: 1, visibleCount: 10 });
    expect(s.filterCursor).toBe(1);
    s = reducer(s, { type: "FILTER_MOVE", delta: 1, visibleCount: 10 });
    expect(s.filterCursor).toBe(2);
  });

  it("clamps at the last match (never past matchCount - 1)", () => {
    let s = filtering("al"); // 3 matches → max cursor 2
    for (let k = 0; k < 5; k++) {
      s = reducer(s, { type: "FILTER_MOVE", delta: 1, visibleCount: 10 });
    }
    expect(s.filterCursor).toBe(2);
  });

  it("clamps at the first match (never below 0)", () => {
    let s = filtering("al");
    s = reducer(s, { type: "FILTER_MOVE", delta: -1, visibleCount: 10 });
    expect(s.filterCursor).toBe(0);
  });

  it("is a no-op when nothing matches", () => {
    let s = filtering("zzz"); // 0 matches
    s = reducer(s, { type: "FILTER_MOVE", delta: 1, visibleCount: 10 });
    expect(s.filterCursor).toBe(0);
  });

  it("resets the cursor to the first match when the query changes", () => {
    let s = filtering("al");
    s = reducer(s, { type: "FILTER_MOVE", delta: 2, visibleCount: 10 });
    expect(s.filterCursor).toBe(2);
    s = reducer(s, { type: "UPDATE_FILTER", query: "alb" }); // narrows → reset
    expect(s.filterCursor).toBe(0);
  });
});

describe("App.tsx filter navigation + commit", () => {
  // Regression (found via live TUI audit): filtered results were not traversable
  // — the filter guard consumed every key as query text, so only Esc worked. Now
  // ↑/↓ (and Ctrl-n/Ctrl-p) walk the filterCursor and Enter commits the
  // HIGHLIGHTED match (not just the first) AND loads it. Locked structurally
  // (App.tsx internals aren't rendered; mirrors tui-compose-new-input-guard).
  const SRC = readFileSync(resolve(__dirname, "../src/tui/App.tsx"), "utf8");

  it("Enter commits the highlighted match (filterCursor) and loads it", () => {
    const start = SRC.indexOf("filterMatchIndices(state.conversations, state.filterQuery)");
    expect(start, "filter-commit block not found in App.tsx").toBeGreaterThan(-1);
    const end = SRC.indexOf("EXIT_FILTER", start);
    const block = SRC.slice(start, end);
    expect(block, "must commit the highlighted match").toMatch(/matches\[state\.filterCursor\]/);
    expect(block, "must move the cursor").toMatch(/type:\s*"SELECT"/);
    expect(block, "must load the matched thread's messages").toMatch(/loadMessages\(\s*matchIdx/);
  });

  it("filter mode navigates matches with arrows / Ctrl-n / Ctrl-p (FILTER_MOVE)", () => {
    const guard = SRC.slice(SRC.indexOf('state.mode === "filter"'));
    const block = guard.slice(0, guard.indexOf("return;"));
    expect(block, "down/next must move the filter cursor").toMatch(/downArrow[\s\S]*FILTER_MOVE/);
    expect(block, "up/prev must move the filter cursor").toMatch(/upArrow[\s\S]*FILTER_MOVE/);
  });
});

/**
 * Escape cancels a filter — it must not silently reassign the selection.
 *
 * `UPDATE_FILTER` snaps `selectedIdx` to 0 on every keystroke (the filtered
 * list is re-sliced each time). Plain `EXIT_FILTER` used to leave that behind,
 * so `/` → type → Escape landed the user on conversation #0 with the PREVIOUS
 * thread's messages and count still rendered underneath its name, until a j/k
 * happened to trigger a reload. Escape now restores the pre-filter position;
 * Enter (commit) deliberately does not, because it has already dispatched
 * SELECT for the highlighted match.
 */
describe("filter cancel restores the pre-filter selection", () => {
  const conversations = [
    conv({ displayName: "Aaron", chatIdentifier: "+1000" }),
    conv({ displayName: "Beth", chatIdentifier: "+1001" }),
    conv({ displayName: "Carl", chatIdentifier: "+1002" }),
    conv({ displayName: "Dana", chatIdentifier: "+1003" }),
  ];

  function stateAt(idx: number, scroll = 0): AppState {
    return { ...initialState, conversations, selectedIdx: idx, sidebarScroll: scroll };
  }

  it("Escape puts selectedIdx and scroll back where they were", () => {
    let s = stateAt(3, 2);
    s = reducer(s, { type: "ENTER_FILTER" });
    s = reducer(s, { type: "UPDATE_FILTER", query: "be" });
    expect(s.selectedIdx).toBe(0); // the filtering side effect this test exists for

    s = reducer(s, { type: "EXIT_FILTER", restoreSelection: true });
    expect(s.selectedIdx).toBe(3);
    expect(s.sidebarScroll).toBe(2);
    expect(s.mode).toBe("browse");
    expect(s.filterQuery).toBe("");
    expect(s.filterReturnIdx).toBeNull();
  });

  it("Enter (commit) keeps the committed selection instead of restoring", () => {
    let s = stateAt(3);
    s = reducer(s, { type: "ENTER_FILTER" });
    s = reducer(s, { type: "UPDATE_FILTER", query: "carl" });
    // App dispatches SELECT for the highlighted match before exiting.
    s = reducer(s, { type: "SELECT", index: 2, visibleCount: 10 });
    s = reducer(s, { type: "EXIT_FILTER", restoreSelection: false });
    expect(s.selectedIdx).toBe(2);
    expect(s.filterReturnIdx).toBeNull();
  });

  it("clamps the restored index if the list shrank while filtering", () => {
    let s = stateAt(3);
    s = reducer(s, { type: "ENTER_FILTER" });
    s = reducer(s, { type: "SET_CONVERSATIONS", data: conversations.slice(0, 2) });
    s = reducer(s, { type: "EXIT_FILTER", restoreSelection: true });
    expect(s.selectedIdx).toBe(1);
  });

  it("is a no-op on selection when Escape arrives with nothing remembered", () => {
    const s = reducer(
      { ...stateAt(2), mode: "filter" },
      {
        type: "EXIT_FILTER",
        restoreSelection: true,
      },
    );
    expect(s.selectedIdx).toBe(2);
    expect(s.mode).toBe("browse");
  });
});
