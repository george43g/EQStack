/**
 * RelaySession — one WebSocket = one live call. Drives the turn loop:
 * finalized user prompt → streamed LLM tokens → Twilio text frames, with
 * immediate LLM abort on barge-in and a safe end on gateway/LLM failure.
 * Timing marks land in the store per turn (end-of-turn, first model token,
 * first token to Twilio, interruption).
 */
import type { WebSocket } from "ws";
import { endFrame, parseRelayMessage, textFrame } from "../adapters/telephony/relay-messages.js";
import type { ChatMessage, Clock, LlmAdapter } from "../domain/ports.js";
import type { CallMode, CallRecord } from "../domain/types.js";
import { CALL_MODE_SPECS } from "../domain/types.js";
import { logger } from "../log.js";
import type { CallService, LiveSession } from "./call-service.js";
import type { Metrics } from "./metrics.js";

export interface SessionDeps {
  llm: LlmAdapter;
  model: string;
  fallbackModel: string | undefined;
  systemPrompt: string;
  clock: Clock;
  metrics: Metrics;
}

export class RelaySession implements LiveSession {
  private history: ChatMessage[] = [];
  private turn = 0;
  private currentAbort: AbortController | null = null;
  private assistantPartial = "";
  private closed = false;
  /** Mutable so a later phase can hand off modes mid-call (Phase K seam). */
  private mode: CallMode;

  private get modeSpec() {
    return CALL_MODE_SPECS[this.mode];
  }

  constructor(
    private ws: WebSocket,
    private call: CallRecord,
    private service: CallService,
    private deps: SessionDeps,
  ) {
    this.mode = service.store.getCallRequest(call.requestId)?.mode ?? "byo-model";
    const objectiveBlock = [
      `Objective of this call: ${call.objective}`,
      ...(this.requestContext()
        ? [`Context from the initiating agent: ${this.requestContext()}`]
        : []),
    ].join("\n");
    this.history.push({ role: "system", content: `${deps.systemPrompt}\n\n${objectiveBlock}` });
    ws.on("message", (data) => {
      this.onMessage(String(data)).catch((err) =>
        logger.error("session message handling failed", {
          callId: call.id,
          error: (err as Error).message,
        }),
      );
    });
    ws.on("close", () => {
      this.closed = true;
      this.currentAbort?.abort();
      this.service.unregisterSession(call.id);
      this.service.emit(call.id, "session.closed", {});
    });
    service.registerSession(call.id, this);
  }

  private requestContext(): string | null {
    const request = this.service.store.getCallRequest(this.call.requestId);
    return request?.context ?? null;
  }

  private async onMessage(raw: string): Promise<void> {
    const parsed = parseRelayMessage(raw);
    if (!parsed.ok) {
      this.service.emit(this.call.id, "session.bad_frame", { error: parsed.error });
      return;
    }
    const msg = parsed.message;
    switch (msg.type) {
      case "setup": {
        if (this.call.providerCallId && msg.callSid !== this.call.providerCallId) {
          this.service.emit(this.call.id, "session.setup_mismatch", { got: msg.callSid });
          this.ws.close(1008, "callSid mismatch");
          return;
        }
        this.service.emit(this.call.id, "session.setup", { sessionId: msg.sessionId });
        return;
      }
      case "prompt": {
        if (!msg.last) return; // act only on finalized utterances
        await this.handleTurn(msg.voicePrompt);
        return;
      }
      case "interrupt": {
        this.handleInterrupt(msg.utteranceUntilInterrupt);
        return;
      }
      case "dtmf": {
        this.service.emit(this.call.id, "session.dtmf", { digit: msg.digit });
        return;
      }
      case "error": {
        this.service.emit(this.call.id, "session.provider_error", { description: msg.description });
        return;
      }
    }
  }

  private async handleTurn(userText: string): Promise<void> {
    // A new finalized prompt while streaming supersedes the current turn.
    this.currentAbort?.abort();
    this.turn += 1;
    const turn = this.turn;
    const endOfTurnMs = this.deps.clock.nowMs();
    this.history.push({ role: "user", content: userText });
    this.service.store.addUtterance({
      callId: this.call.id,
      turn,
      role: "user",
      text: userText,
      tsMs: endOfTurnMs,
      interrupted: false,
    });
    // Direct mode inlines the utterance text so the host can reply without a transcript fetch.
    this.service.emit(this.call.id, "turn.user", {
      turn,
      chars: userText.length,
      ...(this.modeSpec.hostAnswersTurns ? { text: userText } : {}),
    });
    this.service.store.upsertTiming({
      callId: this.call.id,
      turn,
      endOfTurnMs,
      firstModelTokenMs: null,
      firstTokenToTwilioMs: null,
      interruptedAtMs: null,
    });

    // Host-answered modes: the MCP host is the brain — the reply arrives via say_on_call.
    if (!this.modeSpec.gatewayDrivesTurns) return;

    const abort = new AbortController();
    this.currentAbort = abort;
    this.assistantPartial = "";
    let firstToken = true;
    try {
      const stream = this.deps.llm.stream({
        messages: this.history,
        model: this.deps.model,
        fallbackModel: this.deps.fallbackModel,
        signal: abort.signal,
        onFallback: (from, to, reason) =>
          this.service.emit(this.call.id, "llm.fallback", { from, to, reason }),
      });
      for await (const token of stream) {
        if (abort.signal.aborted || this.closed) break;
        if (firstToken) {
          firstToken = false;
          const now = this.deps.clock.nowMs();
          this.deps.metrics
            .histogram("tel_first_model_token_ms", "End of turn → first model token")
            .observe(now - endOfTurnMs);
          this.service.store.upsertTiming({
            callId: this.call.id,
            turn,
            endOfTurnMs: null,
            firstModelTokenMs: now,
            firstTokenToTwilioMs: null,
            interruptedAtMs: null,
          });
        }
        this.assistantPartial += token;
        const isFirstSend = this.assistantPartial.length === token.length;
        this.ws.send(textFrame(token, false));
        if (isFirstSend) {
          const now = this.deps.clock.nowMs();
          this.deps.metrics
            .histogram("tel_first_token_to_twilio_ms", "End of turn → first token sent to Twilio")
            .observe(now - endOfTurnMs);
          this.service.store.upsertTiming({
            callId: this.call.id,
            turn,
            endOfTurnMs: null,
            firstModelTokenMs: null,
            firstTokenToTwilioMs: now,
            interruptedAtMs: null,
          });
        }
      }
      if (!abort.signal.aborted && !this.closed) {
        this.ws.send(textFrame("", true));
        this.finalizeAssistant(turn, false);
      }
    } catch (err) {
      this.service.emit(this.call.id, "llm.error", { turn, error: (err as Error).message });
      this.deps.metrics.counter("tel_llm_errors_total", "LLM turn failures").inc();
      if (!this.closed) {
        // Stop safely: apologize-and-end beats dead air on a live phone line.
        this.ws.send(endFrame({ reason: "llm_error" }));
        await this.service.endCall(this.call.id, "llm_error");
      }
    } finally {
      if (this.currentAbort === abort) this.currentAbort = null;
    }
  }

  private handleInterrupt(utteranceUntilInterrupt: string): void {
    const now = this.deps.clock.nowMs();
    this.currentAbort?.abort();
    this.service.store.upsertTiming({
      callId: this.call.id,
      turn: this.turn,
      endOfTurnMs: null,
      firstModelTokenMs: null,
      firstTokenToTwilioMs: null,
      interruptedAtMs: now,
    });
    this.service.emit(this.call.id, "turn.interrupted", {
      turn: this.turn,
      spokenChars: utteranceUntilInterrupt.length,
    });
    this.deps.metrics.counter("tel_interruptions_total", "Barge-ins").inc();
    // Keep history faithful to what was actually HEARD, not what we generated.
    this.finalizeAssistant(this.turn, true, utteranceUntilInterrupt || this.assistantPartial);
  }

  private finalizeAssistant(turn: number, interrupted: boolean, spokenText?: string): void {
    const text = spokenText ?? this.assistantPartial;
    if (!text) return;
    this.history.push({ role: "assistant", content: text });
    this.service.store.addUtterance({
      callId: this.call.id,
      turn,
      role: "assistant",
      text,
      tsMs: this.deps.clock.nowMs(),
      interrupted,
    });
    this.service.emit(this.call.id, "turn.assistant", { turn, chars: text.length, interrupted });
    this.assistantPartial = "";
  }

  /** Manual disclosure / operator interjection / direct-mode reply — spoken verbatim. */
  async sendText(text: string): Promise<void> {
    this.currentAbort?.abort();
    this.ws.send(textFrame(text, true));
    this.history.push({ role: "assistant", content: text });
    this.service.store.addUtterance({
      callId: this.call.id,
      turn: this.turn,
      role: "assistant",
      text,
      tsMs: this.deps.clock.nowMs(),
      interrupted: false,
    });
    this.service.emit(this.call.id, "turn.assistant", {
      turn: this.turn,
      chars: text.length,
      interrupted: false,
      verbatim: true,
    });
  }

  end(reason: string): void {
    this.currentAbort?.abort();
    if (!this.closed) {
      try {
        this.ws.send(endFrame({ reason }));
        this.ws.close(1000, reason);
      } catch {
        // socket already gone
      }
    }
  }
}
