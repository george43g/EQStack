/**
 * CallService — the single writer and policy gate. Every mutation (place,
 * end, disclosure, recording toggle, deletion) flows through here via
 * the localhost admin API; the public listener only feeds it validated
 * Twilio callbacks. Events append to the store AND fan out to live
 * subscribers (SSE / `tel watch`).
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Config } from "../config/schema.js";
import { effectiveCallSettings } from "../config/schema.js";
import {
  buildCallPlan,
  type CallPlan,
  CallRequestError,
  createCallRequest,
  type PlaceCallInput,
} from "../domain/call-requests.js";
import { assertRecordingToggleAllowed } from "../domain/consent.js";
import { deriveIdempotencyKey, loadOrCreateInstallKey } from "../domain/idempotency.js";
import type { Clock, IdProvider, RecordingStore, TelephonyAdapter } from "../domain/ports.js";
import { systemClock } from "../domain/ports.js";
import { resolveRecipient } from "../domain/recipients.js";
import type { CallEvent, CallRecord, CallStatus } from "../domain/types.js";
import { CALL_STATUS_RANK, TERMINAL_STATUSES } from "../domain/types.js";
import { logger } from "../log.js";
import { ensureStateDir } from "../paths.js";
import type { SqliteStore } from "../stores/sqlite-store.js";
import type { Metrics } from "./metrics.js";

export class CallServiceError extends Error {
  constructor(
    message: string,
    readonly httpStatus = 400,
  ) {
    super(message);
  }
}

/** Twilio → internal status mapping (unknown values are rejected upstream). */
const TWILIO_STATUS_MAP: Record<string, CallStatus> = {
  queued: "initiated",
  initiated: "initiated",
  ringing: "ringing",
  "in-progress": "answered",
  answered: "answered",
  completed: "completed",
  busy: "failed",
  failed: "failed",
  "no-answer": "failed",
  canceled: "failed",
};

export interface LiveSession {
  sendText(text: string): Promise<void>;
  end(reason: string): void;
}

export const defaultIds: IdProvider = {
  newId: () => randomUUID(),
  newToken: () => randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""),
};

export class CallService {
  readonly events = new EventEmitter();
  private sessions = new Map<string, LiveSession>();
  private durationTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    readonly cfg: Config,
    readonly store: SqliteStore,
    private telephony: TelephonyAdapter,
    private recordings: RecordingStore,
    private clock: Clock = systemClock,
    private ids: IdProvider = defaultIds,
    private metrics?: Metrics,
  ) {}

  emit(callId: string, type: string, data: Record<string, unknown> = {}): CallEvent {
    const event = this.store.appendEvent(callId, type, data);
    this.events.emit("event", event);
    this.metrics?.counter("tel_events_total", "Events appended").inc();
    return event;
  }

  // -- one-shot flow (Phase C: D-5/D-38/D-55) -------------------------------

  private installKey: Buffer | null = null;

  /**
   * Resolve → plan → (dryRun? return) → idempotency claim BEFORE dial →
   * persist request+call → dial. The resolved full number stays in memory
   * from resolve to telephony.createCall and is never persisted (INV-11).
   */
  async placeCall(
    input: PlaceCallInput & { dryRun?: boolean | undefined; idempotencyKey?: string | undefined },
  ): Promise<
    { dryRun: true; plan: CallPlan } | { dryRun: false; call: CallRecord; deduped: boolean }
  > {
    let plan: CallPlan;
    let number: string;
    try {
      const resolved = resolveRecipient(this.cfg, input.to);
      number = resolved.number;
      plan = buildCallPlan(this.cfg, resolved, input);
    } catch (err) {
      throw new CallServiceError((err as Error).message);
    }
    if (input.dryRun) return { dryRun: true, plan };

    this.installKey ??= loadOrCreateInstallKey(ensureStateDir());
    const idemKey =
      input.idempotencyKey ??
      deriveIdempotencyKey(this.installKey, number, plan.objective, plan.mode, plan.profile);
    const now = this.clock.nowMs();
    const windowMs = this.cfg.limits.callDedupeWindowSeconds * 1000;

    // Idempotency BEFORE concurrency (ordering inherited from the two-stage
    // start(): an identical retry of the live call must return it, not 409).
    const existingId = this.store.lookupCallIdempotency(idemKey, now, windowMs);
    if (existingId) {
      const existing = this.store.getCall(existingId);
      if (existing) return { dryRun: false, call: existing, deduped: true };
    }

    if (this.store.activeCallCount() >= this.cfg.limits.maxConcurrentCalls) {
      throw new CallServiceError(
        `concurrency limit reached (${this.cfg.limits.maxConcurrentCalls} active call max)`,
        409,
      );
    }
    const publicBaseUrl = this.cfg.server.publicBaseUrl;
    if (!publicBaseUrl) throw new CallServiceError("server.publicBaseUrl is not configured", 500);

    const callId = this.ids.newId();
    // Claim BEFORE dialing: losing the race means someone else is ringing them.
    const claim = this.store.claimCallIdempotency(idemKey, callId, now, windowMs);
    if (!claim.claimed) {
      const existing = this.store.getCall(claim.existingCallId);
      if (existing) return { dryRun: false, call: existing, deduped: true };
      // Claim without a call row (crashed between claim and create): reclaim.
      this.store.releaseCallIdempotency(idemKey);
      this.store.claimCallIdempotency(idemKey, callId, now, windowMs);
    }

    const request = createCallRequest(plan, this.store, this.clock, this.ids);
    const call: CallRecord = {
      id: callId,
      providerCallId: null,
      requestId: request.id,
      recipientAlias: plan.recipientAlias,
      numberSuffix: plan.numberSuffix,
      profile: plan.profile,
      objective: plan.objective,
      status: "created",
      recordingEnabled: plan.recordingEnabled,
      recordingPolicy: plan.recordingPolicy,
      maxDurationSec: plan.maxDurationSec,
      createdAtMs: now,
      updatedAtMs: now,
      endedAtMs: null,
      endReason: null,
    };
    this.store.createCall(call);
    this.store.markRequestStarted(request.id, call.id);
    const token = this.ids.newToken();
    this.store.putRelayToken(token, call.id);
    this.emit(call.id, "call.created", {
      recipient: call.recipientAlias,
      suffix: call.numberSuffix,
      profile: call.profile,
      recording: call.recordingEnabled,
    });

    const settings = effectiveCallSettings(this.cfg, plan.profile);
    const base = publicBaseUrl.replace(/\/$/, "");
    try {
      const { providerCallId } = await this.telephony.createCall({
        to: number,
        from: this.cfg.telephony.fromNumber,
        relayWsUrl: `${base.replace(/^https:/, "wss:")}/relay/${token}`,
        statusCallbackUrl: `${base}/twilio/status`,
        recordingStatusCallbackUrl: `${base}/twilio/recording`,
        record: call.recordingEnabled,
        timeLimitSec: call.maxDurationSec,
        voice: settings.voice,
        greeting: settings.profile.greeting,
      });
      this.store.setProviderCallId(call.id, providerCallId);
      this.metrics?.counter("tel_calls_total", "Calls dialed").inc();
      this.armDurationTimer(call.id, call.maxDurationSec);
      return { dryRun: false, call: this.store.getCall(call.id) as CallRecord, deduped: false };
    } catch (err) {
      // Release the claim: a failed dial must not swallow an honest retry.
      this.store.releaseCallIdempotency(idemKey);
      this.store.updateCallStatus(call.id, "failed", {
        endedAtMs: this.clock.nowMs(),
        endReason: `dial failed: ${(err as Error).message}`,
      });
      this.emit(call.id, "call.failed", { reason: "dial_failed" });
      throw new CallServiceError(`dial failed: ${(err as Error).message}`, 502);
    }
  }

  /**
   * Phase E step 4: stamp turn.user delivery to a polling host. COALESCE in
   * upsertTiming ⇒ only the FIRST delivery counts; a re-poll cannot move it.
   * Caveat (O-22): this measures *a* host taking the event, not *the* host —
   * fine single-agent, wrong multi-host; first poller wins for now.
   */
  markDelivered(callId: string, turn: number): void {
    this.store.stampDeliveredIfUnset(callId, turn, this.clock.nowMs());
  }

  /** Belt-and-braces cap alongside Twilio's TimeLimit. */
  private armDurationTimer(callId: string, maxDurationSec: number): void {
    const timer = setTimeout(
      () => {
        this.endCall(callId, "max_duration_reached").catch((err) =>
          logger.error("duration-cap end failed", { callId, error: (err as Error).message }),
        );
      },
      (maxDurationSec + 30) * 1000,
    );
    timer.unref();
    this.durationTimers.set(callId, timer);
  }

  // -- live control ---------------------------------------------------------

  registerSession(callId: string, session: LiveSession): void {
    this.sessions.set(callId, session);
  }

  unregisterSession(callId: string): void {
    this.sessions.delete(callId);
  }

  getSession(callId: string): LiveSession | null {
    return this.sessions.get(callId) ?? null;
  }

  private requireCall(callId: string): CallRecord {
    const call = this.store.getCall(callId);
    if (!call) throw new CallServiceError(`unknown call: ${callId}`, 404);
    return call;
  }

  async endCall(callId: string, reason: string): Promise<void> {
    const call = this.requireCall(callId);
    if (TERMINAL_STATUSES.has(call.status)) return;
    this.sessions.get(callId)?.end(reason);
    if (call.providerCallId) {
      try {
        await this.telephony.endCall(call.providerCallId);
      } catch (err) {
        logger.warn("provider endCall failed (continuing)", {
          callId,
          error: (err as Error).message,
        });
      }
    }
    this.store.updateCallStatus(callId, "completed", {
      endedAtMs: this.clock.nowMs(),
      endReason: reason,
    });
    this.emit(callId, "call.ended", { reason });
    this.clearTimer(callId);
  }

  /**
   * Disclosure is ONLY ever spoken through this explicit path — nothing in
   * the gateway invokes it automatically (tested invariant).
   */
  async playDisclosure(callId: string): Promise<void> {
    this.requireCall(callId);
    const session = this.sessions.get(callId);
    if (!session)
      throw new CallServiceError("call has no live session (not answered yet, or ended)", 409);
    await session.sendText(this.cfg.disclosure.text);
    this.emit(callId, "disclosure.played", { textLength: this.cfg.disclosure.text.length });
  }

  /** Speak host-supplied text verbatim into the live call — direct mode's reply path. */
  async say(callId: string, text: string): Promise<void> {
    this.requireCall(callId);
    if (!text.trim()) throw new CallServiceError("text must be non-empty");
    const session = this.sessions.get(callId);
    if (!session)
      throw new CallServiceError("call has no live session (not answered yet, or ended)", 409);
    await session.sendText(text);
  }

  async setRecording(callId: string, enabled: boolean): Promise<void> {
    const call = this.requireCall(callId);
    try {
      assertRecordingToggleAllowed(call.recordingPolicy, enabled);
    } catch (err) {
      throw new CallServiceError((err as Error).message, 403);
    }
    if (!call.providerCallId) throw new CallServiceError("call not dialed yet", 409);
    const base = (this.cfg.server.publicBaseUrl ?? "").replace(/\/$/, "");
    if (enabled) {
      await this.telephony.startRecording(call.providerCallId, `${base}/twilio/recording`);
    } else {
      await this.telephony.stopRecording(call.providerCallId);
    }
    this.store.setRecordingEnabled(callId, enabled);
    this.emit(callId, enabled ? "recording.started" : "recording.stopped", {});
  }

  // -- provider callbacks (already signature-validated by the listener) -----

  handleStatusCallback(params: Record<string, string>): void {
    const providerCallId = params.CallSid;
    const rawStatus = params.CallStatus ?? "";
    if (!providerCallId) throw new CallServiceError("callback missing CallSid", 400);
    const call = this.store.getCallByProviderId(providerCallId);
    if (!call) throw new CallServiceError("unknown CallSid", 404);
    const mapped = TWILIO_STATUS_MAP[rawStatus];
    if (!mapped) throw new CallServiceError(`unrecognized CallStatus: ${rawStatus}`, 400);

    const key = `status:${rawStatus}:${params.SequenceNumber ?? ""}`;
    if (!this.store.recordProviderEvent(call.id, key)) {
      logger.debug("duplicate status callback dropped", { callId: call.id, key });
      return;
    }
    // Out-of-order guard: never downgrade, and terminal states stay terminal.
    if (TERMINAL_STATUSES.has(call.status)) return;
    if (CALL_STATUS_RANK[mapped] < CALL_STATUS_RANK[call.status]) {
      this.emit(call.id, "callback.out_of_order", { rawStatus, current: call.status });
      return;
    }
    const opts =
      mapped === "completed" || mapped === "failed"
        ? { endedAtMs: this.clock.nowMs(), endReason: rawStatus }
        : {};
    this.store.updateCallStatus(call.id, mapped, opts);
    this.emit(call.id, `call.${mapped}`, { providerStatus: rawStatus });
    if (mapped === "completed" || mapped === "failed") this.clearTimer(call.id);
  }

  async handleRecordingCallback(params: Record<string, string>): Promise<void> {
    const providerCallId = params.CallSid;
    const recordingSid = params.RecordingSid;
    const status = params.RecordingStatus ?? "";
    if (!providerCallId || !recordingSid) {
      throw new CallServiceError("recording callback missing CallSid/RecordingSid", 400);
    }
    const call = this.store.getCallByProviderId(providerCallId);
    if (!call) throw new CallServiceError("unknown CallSid", 404);
    if (status !== "completed") return; // only the reliable terminal event triggers download
    if (!this.store.recordProviderEvent(call.id, `recording:${recordingSid}:${status}`)) return;

    const plain = await this.telephony.fetchRecording(recordingSid);
    const { path, sizeBytes } = await this.recordings.store(recordingSid, plain);
    this.store.upsertRecording({
      providerRecordingId: recordingSid,
      callId: call.id,
      durationSec: params.RecordingDuration ? Number(params.RecordingDuration) : null,
      channels: params.RecordingChannels ? Number(params.RecordingChannels) : 2,
      encryptedPath: path,
      sizeBytes,
      deletedLocal: false,
      deletedProvider: false,
      createdAtMs: this.clock.nowMs(),
    });
    this.emit(call.id, "recording.stored", { recordingSid, sizeBytes });
  }

  // -- recording deletion ---------------------------------------------------

  async deleteRecording(
    providerRecordingId: string,
    scope: "local" | "provider" | "both",
    confirm: boolean,
  ): Promise<{ deletedLocal: boolean; deletedProvider: boolean }> {
    if (!confirm)
      throw new CallServiceError("explicit confirmation required to delete a recording");
    const meta = this.store.getRecording(providerRecordingId);
    if (!meta) throw new CallServiceError(`unknown recording: ${providerRecordingId}`, 404);
    let deletedLocal = false;
    let deletedProvider = false;
    if (scope === "local" || scope === "both") {
      deletedLocal = await this.recordings.deleteLocal(providerRecordingId);
      this.store.markRecordingDeleted(providerRecordingId, "local");
    }
    if (scope === "provider" || scope === "both") {
      await this.telephony.deleteRecording(providerRecordingId);
      this.store.markRecordingDeleted(providerRecordingId, "provider");
      deletedProvider = true;
    }
    this.emit(meta.callId, "recording.deleted", { providerRecordingId, scope });
    return { deletedLocal, deletedProvider };
  }

  private clearTimer(callId: string): void {
    const t = this.durationTimers.get(callId);
    if (t) clearTimeout(t);
    this.durationTimers.delete(callId);
  }

  shutdown(): void {
    for (const t of this.durationTimers.values()) clearTimeout(t);
    this.durationTimers.clear();
    for (const s of this.sessions.values()) s.end("shutdown");
    this.sessions.clear();
  }
}

export { CallRequestError };
