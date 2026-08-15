/**
 * Boot-frame honesty (swarm finding A5: "~3s blank boot, no indicator").
 *
 * `better-sqlite3` is synchronous, so the initial `listConversations` (~1.8s on
 * a 5.5k-chat account) blocks the event loop and starves Ink's first flush.
 * Measured with tmux frame capture: the user faced a cleared alt-screen with
 * NOTHING on it from ~1.9s to ~3.9s, first paint at ~4.1s.
 *
 * App now defers the initial load by a macrotask so frame one reaches the
 * terminal first. That exposed a second defect: the boot frame rendered
 * "No conversations" / "No messages" — a confident lie about an account with
 * thousands of both. These tests lock the loading-vs-empty distinction so the
 * blank screen can't come back as a wrong screen.
 *
 * After the fix the same capture reads:
 *   2113ms -> "Loading conversations…"   4281ms -> data
 */
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { Sidebar } from "../src/tui/components/Sidebar.js";
import { StatusBar } from "../src/tui/components/StatusBar.js";
import { ThreadPane } from "../src/tui/components/ThreadPane.js";
import { makeTheme } from "../src/tui/theme.js";
import { ThemeProvider } from "../src/tui/themes/ThemeContext.js";
import { initialState } from "../src/tui/types.js";

const theme = makeTheme({ preset: "safe" });

function withTheme(node: React.ReactElement) {
  return render(<ThemeProvider value={theme}>{node}</ThemeProvider>);
}

function sidebar(props: Record<string, unknown>) {
  return withTheme(
    <Sidebar
      conversations={[]}
      moduleInstances={[]}
      selectedIdx={0}
      selectedModuleIdx={null}
      filterCursor={0}
      scrollOffset={0}
      filterQuery=""
      focused={true}
      width={40}
      height={20}
      {...props}
    />,
  );
}

function threadPane(props: Record<string, unknown>) {
  return withTheme(
    <ThreadPane
      conversation={undefined}
      messages={[]}
      pending={[]}
      resolvedNames={[]}
      scrollOffset={0}
      selectedMsgIdx={-1}
      selectionAnchor={null}
      gapMarkers={[]}
      focused={false}
      width={60}
      height={20}
      mode="browse"
      onChangeCompose={() => {}}
      onSubmitCompose={() => {}}
      {...props}
    />,
  );
}

describe("boot frame tells the truth while loading", () => {
  it("sidebar says loading, not 'No conversations', during the initial load", () => {
    const { lastFrame } = sidebar({ loading: true });
    expect(lastFrame()).toContain("Loading conversations");
    expect(lastFrame()).not.toContain("No conversations");
  });

  it("sidebar reports a genuinely empty account once loading finishes", () => {
    const { lastFrame } = sidebar({ loading: false });
    expect(lastFrame()).toContain("No conversations");
    expect(lastFrame()).not.toContain("Loading conversations");
  });

  it("a loaded sidebar never shows the loading text even if the flag lingers", () => {
    const conv = {
      chatIdentifier: "+15555550002",
      displayName: "Someone",
      threadSlug: "someone~imsg~aaaa",
      lastMessageDate: new Date("2026-05-10T12:00:00Z"),
      unreadCount: 0,
      isGroupChat: false,
    } as never;
    const { lastFrame } = sidebar({ loading: true, conversations: [conv] });
    expect(lastFrame()).not.toContain("Loading conversations");
  });

  it("thread pane says loading, not 'No messages', before a thread is selected", () => {
    const { lastFrame } = threadPane({ loading: true });
    expect(lastFrame()).toContain("Loading");
    expect(lastFrame()).not.toContain("No messages");
  });

  it("thread pane reports an empty selected thread as empty, not loading", () => {
    const conv = {
      chatIdentifier: "+15555550002",
      displayName: "Someone",
      threadSlug: "someone~imsg~aaaa",
      lastMessageDate: new Date("2026-05-10T12:00:00Z"),
      unreadCount: 0,
      isGroupChat: false,
    } as never;
    const { lastFrame } = threadPane({ loading: true, conversation: conv });
    expect(lastFrame()).toContain("No messages");
  });
});

describe("status bar surfaces the specific status", () => {
  it("prefers the caller's status over the generic word while loading", () => {
    const { lastFrame } = withTheme(
      <StatusBar
        totalUnread={0}
        selected={undefined}
        status="Loading conversations…"
        loading={true}
      />,
    );
    expect(lastFrame()).toContain("Loading conversations");
  });

  it("falls back to the generic word when no status was set", () => {
    const { lastFrame } = withTheme(
      <StatusBar totalUnread={0} selected={undefined} status="" loading={true} />,
    );
    expect(lastFrame()).toContain("loading...");
  });
});

describe("initial state", () => {
  it("boots with a loading flag and a status worth reading", () => {
    // Frame one is rendered straight from initialState — if this regresses to
    // an empty status the boot screen goes back to saying nothing.
    expect(initialState.loading).toBe(true);
    expect(initialState.status).toMatch(/loading/i);
    expect(initialState.conversations).toHaveLength(0);
  });
});
