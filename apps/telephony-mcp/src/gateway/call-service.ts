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
import { AGENT_PLATFORM_HOLDER, effectiveCallSettings } from "../config/schema.js";
import {
  type AgentPreview,
  agentKey,
  briefHash,
  buildBrief,
  buildDynamicVariables,
  planAgentAction,
} from "../domain/agent-brief.js";
import {
  buildCallPlan,
  type CallPlan,
  CallRequestError,
  createCallRequest,
  type PlaceCallInput,
} from "../domain/call-requests.js";
import { assertRecordingToggleAllowed } from "../domain/consent.js";
import { deriveIdempotencyKey, loadOrCreateInstallKey } from "../domain/idempotency.js";
import type {
  AgentBrief,
  AgentPlatformPort,
  Clock,
  IdProvider,
  RecordingStore,
  TelephonyAdapter,
} from "../domain/ports.js";
import { systemClock } from "../domain/ports.js";
import { resolveRecipient } from "../domain/recipients.js";
import type { CallEvent, CallMode, CallRecord, CallStatus } from "../domain/types.js";
import { CALL_MODE_SPECS, CALL_STATUS_RANK, TERMINAL_STATUSES } from "../domain/types.js";
import { logger } from "../log.js";
import { ensureStateDir } from "../paths.js";
import type { SqliteStore } from "../stores/sqlite-store.js";
import { DelegatePoller } from "./delegate-poller.js";
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

/**
 * How long past a delegate call's max duration the poller keeps waiting for
 * the platform to report a terminal status (ringing + post-call processing).
 */
export const DELEGATE_POLL_GRACE_SEC = 600;

export type PlaceCallResult =
  | { dryRun: true; plan: CallPlan; agent?: AgentPreview }
  | {
      dryRun: false;
      call: CallRecord;
      deduped: boolean;
      agent?: AgentPreview;
      notices?: string[];
    };

export const defaultIds: IdProvider = {
  newId: () => randomUUID(),
  newToken: () => randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""),
};

export class CallService {
  readonly events = new EventEmitter();
  private sessions = new Map<string, LiveSession>();
  private durationTimers = new Map<string, NodeJS.Timeout>();
  private pollers = new Map<string, DelegatePoller>();
  /** Single-flight agent provisioning per agent key (serve is the one writer — INV-9). */
  private provisioning = new Map<string, Promise<AgentPreview>>();

  constructor(
    readonly cfg: Config,
    readonly store: SqliteStore,
    private telephony: TelephonyAdapter,
    private recordings: RecordingStore,
    private clock: Clock = systemClock,
    private ids: IdProvider = defaultIds,
    private metrics?: Metrics,
    /** Holds `mediaPathOffDevice` calls (Phase Q); null when agentPlatform is not configured. */
    private agentPlatform: AgentPlatformPort | null = null,
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
  ): Promise<PlaceCallResult> {
    let plan: CallPlan;
    let number: string;
    try {
      const resolved = resolveRecipient(this.cfg, input.to);
      number = resolved.number;
      plan = buildCallPlan(this.cfg, resolved, input);
    } catch (err) {
      throw new CallServiceError((err as Error).message);
    }
    // INV-7: an off-device mode never touches the relay/WS path; the platform
    // holds the call. Branch on the spec predicate, never on the mode string.
    const offDevice = CALL_MODE_SPECS[plan.mode].mediaPathOffDevice;
    let brief: AgentBrief | null = null;
    if (offDevice) {
      if (!this.agentPlatform || !this.cfg.agentPlatform) {
        throw new CallServiceError(
          `call mode '${plan.mode}' needs an agent platform, and this gateway has none (configure the "agentPlatform" block and restart serve)`,
          500,
        );
      }
      brief = buildBrief(this.cfg, plan.profile, plan.recordingEnabled);
    }
    // dryRun creates NOTHING — not here, not on the platform (reads only).
    if (input.dryRun) {
      return { dryRun: true, plan, ...(brief ? { agent: this.previewAgent(plan, brief) } : {}) };
    }
    const notices = plan.notices.length > 0 ? { notices: plan.notices } : {};

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
      if (existing) return { dryRun: false, call: existing, deduped: true, ...notices };
    }

    if (this.store.activeCallCount() >= this.cfg.limits.maxConcurrentCalls) {
      throw new CallServiceError(
        `concurrency limit reached (${this.cfg.limits.maxConcurrentCalls} active call max)`,
        409,
      );
    }
    const publicBaseUrl = this.cfg.server.publicBaseUrl;
    // Only the on-device path needs public reachability (Phase Q needs no tunnel).
    if (!offDevice && !publicBaseUrl) {
      throw new CallServiceError("server.publicBaseUrl is not configured", 500);
    }

    const callId = this.ids.newId();
    // Claim BEFORE dialing: losing the race means someone else is ringing them.
    const claim = this.store.claimCallIdempotency(idemKey, callId, now, windowMs);
    if (!claim.claimed) {
      const existing = this.store.getCall(claim.existingCallId);
      if (existing) return { dryRun: false, call: existing, deduped: true, ...notices };
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
    // No relay token for an off-device call: nothing may ever attach to /relay/.
    const token = offDevice ? null : this.ids.newToken();
    if (token) this.store.putRelayToken(token, call.id);
    this.emit(call.id, "call.created", {
      recipient: call.recipientAlias,
      suffix: call.numberSuffix,
      profile: call.profile,
      recording: call.recordingEnabled,
    });

    try {
      if (brief) {
        const agent = await this.ensureAgent(plan.profile, brief);
        const { conversationId } = await (
          this.agentPlatform as AgentPlatformPort
        ).placeOutboundCall({
          agentId: agent.agentId as string,
          phoneNumberId: this.cfg.agentPlatform?.phoneNumberId as string,
          to: number,
          dynamicVariables: buildDynamicVariables(plan.objective, plan.context),
        });
        this.store.setProviderCallId(call.id, conversationId);
        this.metrics?.counter("tel_calls_total", "Calls dialed").inc();
        // No duration timer: the platform enforces max_duration_seconds itself,
        // and we have no hang-up to arm one with. The poller carries a deadline.
        this.startDelegatePoller(this.store.getCall(call.id) as CallRecord);
        return {
          dryRun: false,
          call: this.store.getCall(call.id) as CallRecord,
          deduped: false,
          agent,
          ...notices,
        };
      }
      const settings = effectiveCallSettings(this.cfg, plan.profile);
      const base = (publicBaseUrl as string).replace(/\/$/, "");
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
      return {
        dryRun: false,
        call: this.store.getCall(call.id) as CallRecord,
        deduped: false,
        ...notices,
      };
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

  // -- delegate calls (Phase Q) ---------------------------------------------

  /** dryRun: what provisioning WOULD do, from a store read. Creates nothing. */
  private previewAgent(plan: CallPlan, brief: AgentBrief): AgentPreview {
    const hash = briefHash(brief);
    const existing = this.store.getAgentProfile(agentKey(plan.profile, brief.recordVoice));
    return {
      platform: (this.agentPlatform as AgentPlatformPort).id,
      name: brief.name,
      agentId: existing?.agentId ?? null,
      action: planAgentAction(existing, hash),
      briefHash: hash,
      brief,
      dynamicVariables: buildDynamicVariables(plan.objective, plan.context),
    };
  }

  /**
   * Idempotent provisioning: create on first use, update only when the brief
   * hash moved, otherwise reuse. Single-flight per agent key, so two calls
   * racing on a new profile create ONE agent.
   */
  private ensureAgent(profile: string, brief: AgentBrief): Promise<AgentPreview> {
    const key = agentKey(profile, brief.recordVoice);
    const inflight = this.provisioning.get(key);
    if (inflight) return inflight;
    const run = this.provisionAgent(key, brief).finally(() => this.provisioning.delete(key));
    this.provisioning.set(key, run);
    return run;
  }

  private async provisionAgent(key: string, brief: AgentBrief): Promise<AgentPreview> {
    const platform = this.agentPlatform as AgentPlatformPort;
    const hash = briefHash(brief);
    const existing = this.store.getAgentProfile(key);
    let action = planAgentAction(existing, hash);
    let agentId = existing?.agentId ?? null;
    if (action === "update" && agentId) {
      try {
        await platform.updateAgent(agentId, brief);
      } catch (err) {
        // Deleted on the platform side (e.g. from its dashboard): recreate.
        if ((err as { status?: unknown }).status !== 404) throw err;
        action = "create";
        agentId = null;
      }
    }
    if (action === "create" || !agentId) {
      action = "create";
      agentId = (await platform.createAgent(brief)).agentId;
    }
    if (action !== "reuse") {
      this.store.upsertAgentProfile({
        agentKey: key,
        agentId,
        briefHash: hash,
        updatedAtMs: this.clock.nowMs(),
      });
    }
    logger.info("delegate agent ready", { agentKey: key, agentId, action });
    return { platform: platform.id, name: brief.name, agentId, action, briefHash: hash };
  }

  private startDelegatePoller(call: CallRecord): void {
    if (!this.agentPlatform || !this.cfg.agentPlatform || !call.providerCallId) return;
    if (this.pollers.has(call.id)) return;
    const poller = new DelegatePoller({
      callId: call.id,
      conversationId: call.providerCallId,
      platform: this.agentPlatform,
      service: this,
      clock: this.clock,
      intervalMs: this.cfg.agentPlatform.pollIntervalMs,
      deadlineMs: call.createdAtMs + (call.maxDurationSec + DELEGATE_POLL_GRACE_SEC) * 1000,
      onStop: () => this.pollers.delete(call.id),
    });
    this.pollers.set(call.id, poller);
    poller.start();
  }

  /**
   * After a `serve` restart, pick live delegate calls back up. Safe because
   * every poller write is keyed on the platform's own data (delegate-poller.ts).
   */
  resumeDelegatePollers(): number {
    let resumed = 0;
    for (const status of ["created", "initiated", "ringing", "answered"] as const) {
      for (const call of this.store.listCalls({ status, limit: 100 })) {
        if (!CALL_MODE_SPECS[this.modeOf(call)].mediaPathOffDevice || !call.providerCallId)
          continue;
        if (this.pollers.has(call.id)) continue;
        this.startDelegatePoller(call);
        resumed += 1;
      }
    }
    if (resumed > 0) logger.info("resumed delegate pollers", { count: resumed });
    return resumed;
  }

  /** Test/ops seam: the live poller for a delegate call, if any. */
  delegatePoller(callId: string): DelegatePoller | null {
    return this.pollers.get(callId) ?? null;
  }

  private modeOf(call: CallRecord): CallMode {
    return this.store.getCallRequest(call.requestId)?.mode ?? "byo-model";
  }

  /**
   * A mode-naming refusal for operations that need OUR media path. Branches
   * on `mediaPathOffDevice` — not `hostAnswersTurns`: byo-model also has
   * hostAnswersTurns false, yet its operator interjection via say_on_call is
   * legitimate because the relay session is ours.
   */
  private refuseIfOffDevice(call: CallRecord, tool: string, why: (holder: string) => string): void {
    const mode = this.modeOf(call);
    if (!CALL_MODE_SPECS[mode].mediaPathOffDevice) return;
    const holder = this.cfg.agentPlatform
      ? AGENT_PLATFORM_HOLDER[this.cfg.agentPlatform.type]
      : "the agent platform";
    throw new CallServiceError(`${tool} is refused on a '${mode}' call: ${why(holder)}`, 409);
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
    this.refuseIfOffDevice(
      call,
      "end_call",
      (holder) =>
        `${holder} holds the phone leg and exposes no API that hangs up a live conversation. The agent ends the call itself (its end_call tool) or at the profile's max duration (${call.maxDurationSec}s); get_call_events will then deliver call.ended.`,
    );
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
    const call = this.requireCall(callId);
    this.refuseIfOffDevice(
      call,
      "play_disclosure",
      (holder) =>
        `the ${holder} agent holds the call and does all the speaking. Put any disclosure wording in the profile's greeting or systemPrompt, which brief the agent.`,
    );
    const session = this.sessions.get(callId);
    if (!session)
      throw new CallServiceError("call has no live session (not answered yet, or ended)", 409);
    await session.sendText(this.cfg.disclosure.text);
    this.emit(callId, "disclosure.played", { textLength: this.cfg.disclosure.text.length });
  }

  /** Speak host-supplied text verbatim into the live call — direct mode's reply path. */
  async say(callId: string, text: string): Promise<void> {
    const call = this.requireCall(callId);
    this.refuseIfOffDevice(
      call,
      "say_on_call",
      (holder) =>
        `the ${holder} agent holds the call end to end and does the talking; the host observes. Follow the conversation with get_call_events (waitMs) until call.ended, and read the words with get_transcript.`,
    );
    if (!text.trim()) throw new CallServiceError("text must be non-empty");
    const session = this.sessions.get(callId);
    if (!session)
      throw new CallServiceError("call has no live session (not answered yet, or ended)", 409);
    await session.sendText(text);
  }

  async setRecording(callId: string, enabled: boolean): Promise<void> {
    const call = this.requireCall(callId);
    // D-76: the platform's recording is an agent setting fixed at call start
    // (platform_settings.privacy.record_voice). No per-conversation override
    // and no mid-call recording endpoint exists, so neither direction works.
    this.refuseIfOffDevice(
      call,
      "set_recording",
      (holder) =>
        `${holder} fixes recording when the call starts (an agent setting with no per-call or mid-call control), so it can be neither started nor stopped now. Choose it up front with place_call's record (plus acknowledgeThirdPartyRecording); a recording in progress stops only when the call ends.`,
    );
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
    for (const p of [...this.pollers.values()]) p.stop();
    this.pollers.clear();
    for (const s of this.sessions.values()) s.end("shutdown");
    this.sessions.clear();
  }
}

export { CallRequestError };
