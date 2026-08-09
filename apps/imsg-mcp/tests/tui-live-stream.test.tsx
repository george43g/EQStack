/**
 * End-to-end live stream wiring: a ChangeEvent emitted on the injected
 * EventBus must appear in the running TUI without any manual refresh —
 * appended to the active thread, deduped on re-delivery, and bumping the
 * sidebar row of a non-active thread.
 *
 * Uses the fixtures env (.env.test) exactly like tui-memory.test.tsx; the
 * bus is a REAL EventBus that the test emits on directly (the ChangeWatcher
 * fs.watch path is covered by change-watcher.test.ts).
 */

import { render } from "ink-testing-library";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getContactsDbPaths, getImsgDbPath, getSlugsDbPath } from "../src/config.js";
import { EventBus } from "../src/event-bus.js";
import { IMessageDB } from "../src/imessage-db.js";
import { App } from "../src/tui/App.js";
import { clearCache } from "../src/tui/messageCache.js";
import { makeTheme } from "../src/tui/theme.js";
import { ThemeProvider } from "../src/tui/themes/ThemeContext.js";
import type { Conversation, Message } from "../src/types.js";

const MARKER_ACTIVE = "zebra42quokka";

function liveMessage(id: number, chatId: string, text: string): Message {
  return {
    id,
    guid: `live-guid-${id}`,
    text,
    handle: "+15550000131",
    displayName: "Livewire",
    isFromMe: false,
    date: new Date(),
    dateRead: null,
    dateDelivered: null,
    isRead: false,
    isDelivered: true,
    chatId,
    service: "iMessage",
    isReaction: false,
    isReply: false,
    isEdited: false,
    isRetracted: false,
    hasAttachments: false,
  } as Message;
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("TUI live change stream (fixtures env)", () => {
  let db: IMessageDB;
  let conversations: Conversation[];

  beforeAll(async () => {
    db = new IMessageDB(getImsgDbPath(), getContactsDbPaths(), getSlugsDbPath());
    conversations = await db.listConversations(5);
  });

  afterAll(async () => {
    await db.close();
    clearCache();
  });

  it("appends live events to the active thread (deduped) and bumps a sidebar row", async () => {
    const active = conversations[0];
    const other = conversations[1];
    // The membership check compares per-identity slugs — sanity-lock the
    // fixture invariant the wiring relies on.
    expect(db.getSlugForChatIdentifier(active.chatIdentifier)).toBe(active.threadSlug);
    expect(db.getSlugForChatIdentifier(other.chatIdentifier)).toBe(other.threadSlug);

    const bus = new EventBus();
    const { lastFrame, unmount } = render(
      <ThemeProvider value={makeTheme()}>
        <App changeBus={bus} />
      </ThemeProvider>,
    );

    try {
      // Initial load: sidebar shows the first conversation, status is idle.
      await vi.waitFor(
        () => {
          const frame = lastFrame() ?? "";
          expect(frame).toContain(active.displayName ?? active.chatIdentifier);
          expect(frame).not.toContain("Loading");
        },
        { timeout: 10_000 },
      );

      // 1) Live message on the ACTIVE thread appears without a refresh.
      const maxRowid = db.getMaxMessageRowId();
      const msg = liveMessage(maxRowid + 1, active.chatIdentifier, MARKER_ACTIVE);
      bus.emit([{ type: "message.new", message: msg }]);
      await vi.waitFor(
        () => {
          expect(lastFrame() ?? "").toContain(MARKER_ACTIVE);
        },
        { timeout: 5_000 },
      );
      const occurrences = count(lastFrame() ?? "", MARKER_ACTIVE);
      expect(occurrences).toBeGreaterThan(0);

      // 2) The SAME guid delivered again (poll/stream race) appends nothing:
      //    the frame's occurrence count stays exactly where it was.
      bus.emit([{ type: "message.new", message: msg }]);
      await new Promise((r) => setTimeout(r, 250));
      expect(count(lastFrame() ?? "", MARKER_ACTIVE)).toBe(occurrences);

      // 3) A live message for a NON-active known thread bumps that row's
      //    unread count. The tiny test viewport hides individual sidebar
      //    rows, so observe it through the status bar's total-unread sum
      //    (state-level row semantics are covered in tui-live-reducer).
      const unreadBefore = Number(/(\d+) unread/.exec(lastFrame() ?? "")?.[1]);
      expect(Number.isFinite(unreadBefore)).toBe(true);
      bus.emit([
        {
          type: "message.new",
          message: liveMessage(maxRowid + 2, other.chatIdentifier, "sidebar-bump"),
        },
      ]);
      await vi.waitFor(
        () => {
          expect(lastFrame() ?? "").toContain(`${unreadBefore + 1} unread`);
        },
        { timeout: 5_000 },
      );
    } finally {
      unmount();
    }
  }, 30_000);
});
