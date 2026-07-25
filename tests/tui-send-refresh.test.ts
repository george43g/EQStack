/**
 * Regression (found via live TUI audit): after composing/sending a message in
 * an open thread, that conversation's sidebar row stayed stale — or, for a
 * brand-new thread, was absent entirely — and could not be selected until a
 * manual `r` refresh. Root cause: sendMessage only dispatched pending/message
 * updates and never touched state.conversations (the array the sidebar cursor
 * indexes over); only the compose-NEW path refreshed the list.
 *
 * App.tsx internals aren't rendered in tests (App calls useImsg() directly), so
 * this is locked structurally — mirrors tui-filter.test.ts's App.tsx guard.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(resolve(__dirname, "../src/tui/App.tsx"), "utf8");

describe("App.tsx refreshes the sidebar after an in-thread send", () => {
  it("defines refreshConversations that reloads the list and re-selects by slug", () => {
    const start = SRC.indexOf("const refreshConversations");
    expect(start, "refreshConversations not found in App.tsx").toBeGreaterThan(-1);
    const block = SRC.slice(start, start + 600);
    expect(block, "must reload the conversation list").toMatch(/imsg\.loadConversations\(\)/);
    expect(block, "must re-select the current thread by slug").toMatch(/threadSlug === slug/);
    expect(block, "must move the cursor onto the found row").toMatch(/type:\s*"SELECT"/);
  });

  it("invokes refreshConversations in the send-success branch (after RESOLVE_PENDING)", () => {
    const resolveIdx = SRC.indexOf('type: "RESOLVE_PENDING"');
    expect(resolveIdx, "RESOLVE_PENDING dispatch not found").toBeGreaterThan(-1);
    // The refresh must fire in the same success branch, right after resolving the
    // optimistic pending bubble — not only on the compose-new path.
    const after = SRC.slice(resolveIdx, resolveIdx + 600);
    expect(after, "send-success branch must refresh the sidebar").toMatch(
      /refreshConversations\(\)/,
    );
  });
});
