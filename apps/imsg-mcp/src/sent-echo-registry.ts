/**
 * Suppresses the agent's own just-sent messages from wait_for_reply results.
 *
 * Why this exists: wait_for_reply now returns the user's OWN interjections
 * (isFromMe rows they send from their phone/other devices into a monitored
 * conversation) — but chat.db lags 1–2s behind Messages.app, so the message
 * the agent itself just sent can land in chat.db AFTER send_message captured
 * its `lastMessageId` baseline. Without suppression, that late-landing echo
 * would immediately "answer" the wait.
 *
 * Two cooperating layers (see handleSendMessage / handleWaitForReply):
 *   1. confirm-at-source — after a successful send, the server polls until
 *      its own from-me row appears and pins the echo to that ROWID, so the
 *      baseline already excludes it.
 *   2. this registry — the correctness backstop when chat.db lagged past the
 *      confirm window: wait_for_reply consults it per from-me message.
 */

export interface SentEcho {
  /** Canonical thread identity: threadSlug when known, else chatIdentifier. */
  chatKey: string;
  kind: "text" | "attachment";
  normalizedText: string;
  /** Date.now() at send time. */
  sentAt: number;
  /** Pinned ROWID once the confirm poll (or first consume) matched a row. */
  matchedMessageId?: number;
}

/** Trim, collapse whitespace runs, Unicode NFC — tolerant of Messages.app normalization. */
export function normalizeForEcho(text: string | null): string {
  return (text ?? "").normalize("NFC").trim().replace(/\s+/g, " ");
}

interface RegistryOptions {
  /** How long after sending an echo can still be suppressed. */
  windowMs?: number;
  /** Clock skew tolerance between Date.now() and chat.db message dates. */
  skewMs?: number;
  maxEntries?: number;
}

export class SentEchoRegistry {
  private entries: SentEcho[] = [];
  private readonly windowMs: number;
  private readonly skewMs: number;
  private readonly maxEntries: number;

  constructor(opts: RegistryOptions = {}) {
    this.windowMs = opts.windowMs ?? 120_000;
    this.skewMs = opts.skewMs ?? 15_000;
    this.maxEntries = opts.maxEntries ?? 200;
  }

  register(chatKey: string, text: string, kind: "text" | "attachment" = "text"): SentEcho {
    const echo: SentEcho = {
      chatKey,
      kind,
      normalizedText: kind === "text" ? normalizeForEcho(text) : "",
      sentAt: Date.now(),
    };
    this.entries.push(echo);
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }
    return echo;
  }

  /**
   * Is this from-me message an echo of a registered send? Idempotent: a
   * message whose id equals an entry's pinned matchedMessageId always
   * matches. Otherwise matches on (chatKey, equal normalized text, message
   * date within skew of sentAt, entry still inside the window, entry not
   * pinned to a different id) — and pins the entry on first match so
   * concurrent wait_for_reply calls see consistent suppression. Attachment
   * entries only match rows that actually carry attachments.
   */
  consume(
    chatKey: string,
    msg: { id: number; text: string | null; date: Date; hasAttachments?: boolean },
  ): boolean {
    this.prune();
    // Pinned-id short-circuit (survives later text edits of the message).
    for (const e of this.entries) {
      if (e.chatKey === chatKey && e.matchedMessageId === msg.id) return true;
    }
    const msgText = normalizeForEcho(msg.text);
    for (const e of this.entries) {
      if (e.chatKey !== chatKey || e.matchedMessageId !== undefined) continue;
      if (msg.date.getTime() < e.sentAt - this.skewMs) continue;
      if (e.kind === "attachment") {
        if (!msg.hasAttachments) continue;
      } else if (e.normalizedText !== msgText) {
        continue;
      }
      e.matchedMessageId = msg.id;
      return true;
    }
    return false;
  }

  /** Drop entries older than the suppression window. */
  prune(now: number = Date.now()): void {
    this.entries = this.entries.filter((e) => now - e.sentAt <= this.windowMs);
  }

  /** Visible for tests. */
  size(): number {
    return this.entries.length;
  }
}
