/**
 * Info drawer "Group changes" section — the one place the TUI shows
 * renames/joins/leaves (item_type != 0 rows are filtered from every
 * message view). See tests/conversation-events.test.ts for the DB side.
 */
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { formatConversationEvent, InfoDrawer } from "../src/tui/components/InfoDrawer.js";
import { makeTheme } from "../src/tui/theme.js";
import { ThemeProvider } from "../src/tui/themes/ThemeContext.js";
import type { ConversationEvent } from "../src/types.js";

function ev(overrides: Partial<ConversationEvent>): ConversationEvent {
  return {
    id: 1,
    date: new Date("2026-05-10T12:00:00Z"),
    kind: "renamed",
    actor: "+15550001111",
    actorName: "Alice Anderson",
    target: null,
    targetName: null,
    newName: null,
    ...overrides,
  };
}

describe("formatConversationEvent", () => {
  it("renders every kind with first names", () => {
    expect(formatConversationEvent(ev({ kind: "renamed", newName: "Weekend Crew" }))).toBe(
      "Alice renamed to “Weekend Crew”",
    );
    expect(formatConversationEvent(ev({ kind: "left" }))).toBe("Alice left");
    expect(
      formatConversationEvent(
        ev({ kind: "member_added", target: "+15550002222", targetName: "Bob Brown" }),
      ),
    ).toBe("Alice added Bob");
    expect(
      formatConversationEvent(
        ev({ kind: "member_removed", target: "+15550002222", targetName: "+15550002222" }),
      ),
    ).toBe("Alice removed +15550002222");
  });

  it("a null actor is the user", () => {
    expect(formatConversationEvent(ev({ actor: null, actorName: null, newName: "Crew" }))).toBe(
      "You renamed to “Crew”",
    );
  });
});

describe("InfoDrawer group changes section", () => {
  const conversation = {
    chatId: "iMessage;+;chat1",
    chatIdentifier: "chat1",
    displayName: "Weekend Crew",
    rawIdentifier: "chat1",
    participants: ["+15550001111", "+15550002222"],
    lastMessageDate: null,
    lastMessageSnippet: null,
    unreadCount: 0,
    threadSlug: "weekend-crew~imsg~abcd",
    isGroupChat: true,
    serviceType: "iMessage" as const,
  };

  function draw(events: ConversationEvent[]) {
    return render(
      <ThemeProvider value={makeTheme({ preset: "safe" })}>
        <InfoDrawer
          conversation={conversation}
          resolvedNames={["Alice Anderson", "Bob Brown"]}
          stats={{ count: 10, first: new Date("2026-01-01"), last: new Date("2026-05-10") }}
          events={events}
          attachments={[]}
          selectedAttachmentIdx={0}
          width={46}
          height={30}
        />
      </ThemeProvider>,
    );
  }

  it("renders the section with formatted rows", () => {
    const { lastFrame, unmount } = draw([
      ev({ id: 1, kind: "renamed", newName: "Weekend Crew" }),
      ev({ id: 2, kind: "member_added", target: "+15550002222", targetName: "Bob Brown" }),
    ]);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Group changes");
    expect(frame).toContain("Alice renamed to");
    expect(frame).toContain("Alice added Bob");
    unmount();
  });

  it("omits the section entirely when there are no events (DMs)", () => {
    const { lastFrame, unmount } = draw([]);
    expect(lastFrame()).not.toContain("Group changes");
    unmount();
  });
});
