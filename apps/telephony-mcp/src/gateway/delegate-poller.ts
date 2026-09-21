/**
 * DelegatePoller (Phase Q step 6) — one per live delegate-mode call. Polls the
 * agent platform's conversation, and writes the SAME events and utterances a
 * relay session writes (call.<status>, turn.user, turn.assistant, call.ended)
 * into the existing store, so get_call_events / get_transcript / search_calls
 * and the console work for delegate calls unchanged (PHASE-Q § Scope 3).
 * No public route, no webhook (INV-10): the transcript comes back by polling.
 *
 * Idempotency — a duplicated poll never double-writes. Every write is claimed
 * first through `recordProviderEvent` (the same UNIQUE(call_id, provider_key)
 * table that drops replayed Twilio callbacks) under a key derived from the
 * platform's own data: `el:turn:<transcript index>`, `el:status:<status>`,
 * `el:terminal`. Turn numbers derive from the transcript prefix, not from
 * poller memory, so a restarted `serve` (resumeDelegatePollers) or two
 * overlapping polls land on the same keys. All writes happen synchronously
 * after the one await, so concurrent polls cannot interleave. The claim is
 * taken BEFORE the write: a crash between the two loses that turn rather than
 * duplicating it (at-most-once, by choice).
 *
 * Settling: whether ElevenLabs fills the transcript during a live call is
 * undocumented, and a live transcript's last item may still be growing. So
 * while the conversation is live only items that have a successor are
 * written; at `done`/`failed` everything is. Cost: the observer sees a turn
 * one item late while the call is live; nothing is ever written twice or
 * written truncated.
 */
import { redactValue } from "@george43g/robustness";
import type {
  AgentConversation,
  AgentConversationStatus,
  AgentPlatformPort,
  Clock,
} from "../domain/ports.js";
import type { CallStatus } from "../domain/types.js";
import { CALL_STATUS_RANK, TERMINAL_STATUSES } from "../domain/types.js";
import { logger } from "../log.js";
import type { CallService } from "./call-service.js";

/**
 * Platform status → our call status. `processing` means the phone leg is over
 * but the platform is still finalising — it stays non-terminal here, because
 * the transcript is only trusted complete at `done`.
 */
export const AGENT_STATUS_MAP: Readonly<Record<AgentConversationStatus, CallStatus>> = {
  initiated: "initiated",
  "in-progress": "answered",
  processing: "answered",
  done: "completed",
  failed: "failed",
};

export function isTerminalAgentStatus(s: AgentConversationStatus): boolean {
  return TERMINAL_STATUSES.has(AGENT_STATUS_MAP[s]);
}

export interface TranscriptWrite {
  /** Position in the platform transcript — the idempotency key. */
  index: number;
  /** User items open a turn; agent items belong to the turn they answer (0 = greeting). */
  turn: number;
  role: "user" | "assistant";
  text: string;
  interrupted: boolean;
}

/**
 * PURE. The transcript items that are safe to write now, with deterministic
 * turn numbers. Non-speech items (null/blank text — tool calls) are skipped
 * but still count for position, so indices stay stable.
 */
export function settledTranscriptWrites(conv: AgentConversation): TranscriptWrite[] {
  const settledCount = isTerminalAgentStatus(conv.status)
    ? conv.transcript.length
    : Math.max(0, conv.transcript.length - 1);
  const writes: TranscriptWrite[] = [];
  let turn = 0;
  conv.transcript.forEach((item, index) => {
    if (item.role === "user") turn += 1;
    if (index >= settledCount) return;
    const text = item.text?.trim() ? item.text : null;
    if (text === null) return;
    writes.push({
      index,
      turn,
      role: item.role === "user" ? "user" : "assistant",
      text,
      interrupted: item.interrupted,
    });
  });
  return writes;
}

export interface DelegatePollerOptions {
  callId: string;
  conversationId: string;
  platform: AgentPlatformPort;
  service: Pick<CallService, "store" | "emit">;
  clock: Clock;
  intervalMs: number;
  /** Absolute. Past it the poller stops and closes the call record (platform went quiet). */
  deadlineMs: number;
  onStop?: () => void;
}

export type PollOutcome = "live" | "terminal";

export class DelegatePoller {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private errorStreak = 0;
  private lastStatus: AgentConversationStatus | null = null;

  constructor(private opts: DelegatePollerOptions) {}

  start(): void {
    this.schedule(this.opts.intervalMs);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.opts.onStop?.();
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pollOnce()
        .catch((err) => {
          logger.error("delegate poll crashed", {
            callId: this.opts.callId,
            error: (err as Error).message,
          });
          return "live" as const;
        })
        .then((outcome) => {
          if (outcome === "live") this.schedule(this.opts.intervalMs);
        });
    }, delayMs);
    this.timer.unref();
  }

  /** One poll. Safe to call concurrently or repeatedly — see the file header. */
  async pollOnce(): Promise<PollOutcome> {
    const { callId, service } = this.opts;
    if (this.stopped) return "terminal";
    const call = service.store.getCall(callId);
    if (!call || TERMINAL_STATUSES.has(call.status)) {
      this.stop();
      return "terminal";
    }
    if (this.opts.clock.nowMs() >= this.opts.deadlineMs) {
      this.finishWithoutPlatform("poll_deadline_exceeded");
      return "terminal";
    }

    let conv: AgentConversation;
    try {
      conv = await this.opts.platform.getConversation(this.opts.conversationId);
    } catch (err) {
      this.errorStreak += 1;
      const error = String(redactValue((err as Error).message)).slice(0, 300);
      logger.warn("delegate poll failed", { callId, streak: this.errorStreak, error });
      // One event per streak: visible in the feed without flooding it.
      if (this.errorStreak === 1) service.emit(callId, "delegate.poll_error", { error });
      return "live";
    }
    this.errorStreak = 0;
    return this.apply(conv);
  }

  /** Synchronous from here on: no await, so two polls cannot interleave writes. */
  private apply(conv: AgentConversation): PollOutcome {
    const { callId, service, clock } = this.opts;
    const store = service.store;
    this.lastStatus = conv.status;
    const mapped = AGENT_STATUS_MAP[conv.status];
    const terminal = TERMINAL_STATUSES.has(mapped);

    const current = store.getCall(callId);
    if (!current || TERMINAL_STATUSES.has(current.status)) {
      this.stop();
      return "terminal";
    }
    if (
      !terminal &&
      CALL_STATUS_RANK[mapped] > CALL_STATUS_RANK[current.status] &&
      store.recordProviderEvent(callId, `el:status:${mapped}`)
    ) {
      store.updateCallStatus(callId, mapped);
      service.emit(callId, `call.${mapped}`, { providerStatus: conv.status });
    }

    for (const w of settledTranscriptWrites(conv)) {
      if (!store.recordProviderEvent(callId, `el:turn:${w.index}`)) continue;
      store.addUtterance({
        callId,
        turn: w.turn,
        role: w.role,
        text: w.text,
        tsMs: clock.nowMs(),
        interrupted: w.interrupted,
      });
      // Same shapes as RelaySession: no text on the stream (hostAnswersTurns
      // is false), the feed hydrates it from the transcript.
      if (w.role === "user") {
        service.emit(callId, "turn.user", { turn: w.turn, chars: w.text.length });
      } else {
        service.emit(callId, "turn.assistant", {
          turn: w.turn,
          chars: w.text.length,
          interrupted: w.interrupted,
        });
      }
    }

    if (!terminal) return "live";
    if (store.recordProviderEvent(callId, "el:terminal")) {
      const reason = String(redactValue(conv.terminationReason || conv.status)).slice(0, 300);
      store.updateCallStatus(callId, mapped, { endedAtMs: clock.nowMs(), endReason: reason });
      service.emit(callId, "call.ended", {
        reason,
        providerStatus: conv.status,
        ...(conv.callDurationSecs !== null ? { durationSec: conv.callDurationSecs } : {}),
        // D-76 observability: does the platform hold audio for this call?
        platformHasAudio: conv.hasAudio,
      });
    }
    this.stop();
    return "terminal";
  }

  /** The platform never reported a terminal status in time: close our record honestly. */
  private finishWithoutPlatform(reason: string): void {
    const { callId, service, clock } = this.opts;
    if (service.store.recordProviderEvent(callId, "el:terminal")) {
      service.store.updateCallStatus(callId, "failed", {
        endedAtMs: clock.nowMs(),
        endReason: reason,
      });
      service.emit(callId, "call.ended", {
        reason,
        providerStatus: this.lastStatus ?? "unknown",
      });
    }
    this.stop();
  }
}
