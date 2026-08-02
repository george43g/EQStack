import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _cacheForTests,
  _resetCacheForTests,
  rememberSearch,
  resolveContactSelector,
} from "../src/contact-resolver.js";

describe("contact-resolver", () => {
  beforeEach(() => _resetCacheForTests());
  afterEach(() => _resetCacheForTests());

  it("returns null for non-selector strings", () => {
    expect(resolveContactSelector("+15555550100")).toBeNull();
    expect(resolveContactSelector("alice@example.com")).toBeNull();
    expect(resolveContactSelector("contact:abc")).toBeNull();
    expect(resolveContactSelector("contact:0")).toBeNull(); // 1-indexed
  });

  it("resolves contact:N against a remembered search", () => {
    rememberSearch("alice", [
      { handle: "+15555550101", displayName: "Alice Work" },
      { handle: "+15555550102", displayName: "Alice Home" },
    ]);
    expect(resolveContactSelector("contact:1")?.displayName).toBe("Alice Work");
    expect(resolveContactSelector("contact:2")?.displayName).toBe("Alice Home");
    expect(resolveContactSelector("contact:3")).toBeNull();
  });

  it("the newest search wins when multiple searches are cached", () => {
    rememberSearch("alice", [
      { handle: "+15555550101", displayName: "Alice Work" },
      { handle: "+15555550102", displayName: "Alice Home" },
    ]);
    rememberSearch("bob", [{ handle: "+15555550200", displayName: "Bob" }]);
    // contact:1 walks newest-first; "bob" entry is searched first
    expect(resolveContactSelector("contact:1")?.displayName).toBe("Bob");
    // contact:2 falls through to the "alice" entry
    expect(resolveContactSelector("contact:2")?.displayName).toBe("Alice Home");
  });

  it("LRU caps at 10 entries", () => {
    for (let i = 0; i < 15; i++) {
      rememberSearch(`q${i}`, [{ handle: `h${i}`, displayName: `N${i}` }]);
    }
    expect(_cacheForTests().length).toBe(10);
  });

  it("re-recording the same query de-dupes (keeps single entry)", () => {
    rememberSearch("alice", [{ handle: "+1", displayName: "A1" }]);
    rememberSearch("alice", [{ handle: "+2", displayName: "A2" }]);
    expect(_cacheForTests().length).toBe(1);
    expect(resolveContactSelector("contact:1")?.displayName).toBe("A2");
  });

  it("empty match list is not recorded", () => {
    rememberSearch("zilch", []);
    expect(_cacheForTests().length).toBe(0);
  });
});
