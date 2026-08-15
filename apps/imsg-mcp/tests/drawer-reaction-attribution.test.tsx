/**
 * Reaction attribution in the message drawer (swarm finding A2, P2 batch).
 *
 * The drawer printed `r.fromHandle` directly, so "who reacted" rendered as
 * `+61423793080` — the last place in the UI still showing a phone number where
 * a person's name belongs, on a screen the user opens precisely to find out who
 * did something. App now resolves the handles (memoized per message, because
 * name lookup hits the contacts DB) and passes a `reactionNames` map.
 *
 * Verified live against the real DB after the fix: "❤️ Isabella".
 */
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { MessageDrawer } from "../src/tui/components/MessageDrawer.js";
import { makeTheme } from "../src/tui/theme.js";
import { ThemeProvider } from "../src/tui/themes/ThemeContext.js";
import type { Message, Reaction } from "../src/types.js";

const HANDLE = "+15550001111";

function reaction(overrides: Partial<Reaction> = {}): Reaction {
  return {
    type: "love",
    fromHandle: HANDLE,
    isRemoval: false,
    targetMessageGuid: "target-guid",
    targetMessagePart: 0,
    ...overrides,
  };
}

function message(reactions: Reaction[]): Message {
  return {
    id: 1,
    guid: "guid-1",
    text: "the message that got a tapback",
    handle: HANDLE,
    isFromMe: false,
    date: new Date("2026-05-10T12:00:00Z"),
    dateRead: null,
    dateDelivered: null,
    isRead: true,
    isDelivered: true,
    chatId: "iMessage;-;+15550001111",
    service: "iMessage",
    isReaction: false,
    isReply: false,
    isEdited: false,
    isRetracted: false,
    hasAttachments: false,
    reactions,
  } as unknown as Message;
}

function draw(m: Message, reactionNames?: Record<string, string>) {
  return render(
    <ThemeProvider value={makeTheme({ preset: "safe" })}>
      <MessageDrawer message={m} width={60} height={30} reactionNames={reactionNames} />
    </ThemeProvider>,
  );
}

describe("message drawer reaction attribution", () => {
  /**
   * The reaction row only. The drawer legitimately prints the MESSAGE's own
   * sender handle elsewhere, so a whole-frame `not.toContain` would fail on
   * correct output.
   */
  function reactionRow(frame: string): string {
    return (frame.split("\n").find((l) => /❤|👍|😂|‼|\blove\b|\blike\b/.test(l)) ?? "").trim();
  }

  it("shows the contact name when the handle resolves", () => {
    const { lastFrame } = draw(message([reaction()]), { [HANDLE]: "Isabella" });
    const row = reactionRow(lastFrame() ?? "");
    expect(row).toContain("Isabella");
    expect(row).not.toContain(HANDLE);
  });

  it("falls back to the raw handle when the contact is unknown", () => {
    // Better a phone number than a blank — an unknown number is itself
    // information ("someone not in your contacts reacted").
    const { lastFrame } = draw(message([reaction()]), {});
    expect(lastFrame()).toContain(HANDLE);
  });

  it("falls back to the raw handle when no map is passed at all", () => {
    const { lastFrame } = draw(message([reaction()]));
    expect(lastFrame()).toContain(HANDLE);
  });

  it("resolves each reactor independently in a group thread", () => {
    const other = "+15550002222";
    const { lastFrame } = draw(
      message([reaction(), reaction({ fromHandle: other, type: "like" })]),
      { [HANDLE]: "Isabella", [other]: "Naomi" },
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Isabella");
    expect(frame).toContain("Naomi");
  });

  it("resolves one reactor while leaving an unknown one as a handle", () => {
    const stranger = "+15550003333";
    const { lastFrame } = draw(
      message([reaction(), reaction({ fromHandle: stranger, type: "laugh" })]),
      { [HANDLE]: "Isabella" },
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Isabella");
    expect(frame).toContain(stranger);
  });
});
