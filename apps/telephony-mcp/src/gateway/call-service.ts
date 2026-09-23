/**
 * CallService — the single writer and policy gate. Every mutation (place,
 * end, disclosure, recording toggle, deletion) flows through here via
 * the localhost admin API; the public listener only feeds it validated
 * Twilio callbacks. Events append to the store AND fan out to live
 * subscribers (SSE / `tel watch`).
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { redactValue } from "@george43g/robustness";
import type { Config } from "../config/schema.js";
import {
  AGENT_PLATFORM_HOLDER,
  effectiveCallSettings,
  meetingMaxDurationSec,
} from "../config/schema.js";
import {
  type AgentPreview,
  agentKey,
  agentName,
  briefHash,
  buildBrief,
  buildDynamicVariables,
  buildMeetingBrief,
  buildMeetingVariables,
  MEETING_AGENT_STEM,
  type MeetingVariables,
  memberJoinInstructions,
  planAgentAction,
} from "../domain/agent-brief.js";
import {
  buildCallPlan,
  type CallPlan,
  CallRequestError,
  CONSULT_HOST_NOTICE,
  createCallRequest,
  MEETING_CONVENOR_NOTICE,
  type PlaceCallInput,
} from "../domain/call-requests.js";
import { assertRecordingToggleAllowed } from "../domain/consent.js";
import { deriveIdempotencyKey, loadOrCreateInstallKey } from "../domain/idempotency.js";
import type {
  AgentBrief,
  AgentPlatformPort,
  Clock,
  IdProvider,
  PhoneLegHangupPort,
  RecordingStore,
  TelephonyAdapter,
} from "../domain/ports.js";
import { systemClock } from "../domain/ports.js";
import { resolveRecipient } from "../domain/recipients.js";
import type {
  CallEvent,
  CallMode,
  CallRecord,
  CallStatus,
  ConsultQuestion,
} from "../domain/types.js";
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

// ── Meetings (PHASE-GC, D-104: a consult call with the meeting variant) ────

export interface StartMeetingInput {
  to: string;
  /** Member keys (session names), in poll order. */
  members: string[];
  agenda: string;
  /** Per-member roster brief (≤ 1500 chars each), keyed by member. */
  briefs?: Record<string, string> | undefined;
  context?: string | undefined;
  record?: boolean | undefined;
  acknowledgeThirdPartyRecording?: boolean | undefined;
  dryRun?: boolean | undefined;
  idempotencyKey?: string | undefined;
}

export interface MeetingRosterEntry {
  member: string;
  displayName: string;
  label: string;
  voiceProfile: string;
  /** A get_call_events {as, waitMs} poll from this member is open or recent (D-98, per member). */
  listening: boolean;
}

export interface StartMeetingResult {
  callId?: string;
  dryRun: boolean;
  deduped?: boolean;
  agent: AgentPreview;
  roster: MeetingRosterEntry[];
  /** Deliver each to that member's session, before or right after dialling. */
  joinInstructions: Record<string, string>;
  notices: string[];
}

/** What placeCall needs to dial a meeting instead of an ordinary consult call. */
interface MeetingDial {
  members: string[];
  variables: MeetingVariables;
  personaText: string | null;
}

/** The dryRun join text has no call id yet. */
const CALL_ID_PLACEHOLDER = "<callId: returned when the meeting is dialled>";

// ── Consult (Phase R, D-90..D-94) ──────────────────────────────────────────

/**
 * What `serve` answers EL's consult tool with — always a 200 body we worded
 * (D-93). On a meeting call the result also names the `agent` asked, and a
 * question to anyone not on the roster is `not_on_call` (PHASE-GC § 3).
 */
export type ConsultResult = (
  | { status: "answered"; question_id: string; answer: string }
  | { status: "pending"; question_id: string; guidance: string }
  | { status: "unavailable"; guidance: string }
  | { status: "busy"; guidance: string }
  | { status: "call_ended"; guidance: string }
  | { status: "not_found"; guidance: string }
  | { status: "not_on_call"; guidance: string }
) & { agent?: string };

export type ConsultOutcome = ConsultResult["status"];

export const CONSULT_GUIDANCE = {
  pending:
    "No answer yet. Tell the person you have not heard back, offer to carry on, and before the call ends call consult_originator once more with collect_question_id set to this question_id.",
  unavailable:
    "The originator cannot be reached right now. Do not retry. Tell the person you will pass the question on and someone will follow up.",
  busy: "Too many questions are already waiting. Do not retry. Tell the person you will pass the question on and someone will follow up.",
  call_ended: "This call has ended.",
  not_found: "There is no such question on this call. Do not retry.",
  not_on_call: "There is no such agent on this call. Do not retry.",
} as const;

type Guidance = Record<keyof typeof CONSULT_GUIDANCE, string>;

/** The same outcomes, worded for the chair of a meeting (MEETING_HARNESS names these moves). */
export const MEETING_GUIDANCE: Guidance = {
  pending:
    "No answer yet. Say so in the chair's voice and carry on with the meeting; before you move to the next topic, and at the latest before you close, call ask_agent again with this agent and collect_question_id set to this question_id.",
  unavailable:
    "That agent is not at its desk (its session is not listening). Do not retry. Say so in the chair's voice and offer to pass the question on.",
  busy: "Too many questions are already waiting. Do not retry now. Say you will come back to it.",
  call_ended: "This call has ended.",
  not_found: "There is no such question on this call. Do not retry.",
  not_on_call:
    "That agent is not on this call. Do not retry. Say so in the chair's voice, and offer to pass the question on.",
};

/** Wide buckets for a human-in-the-loop answer (D-27): seconds to minutes. */
export const CONSULT_ANSWER_BUCKETS_MS = [
  1000, 2000, 5000, 10_000, 15_000, 20_000, 30_000, 45_000, 60_000, 120_000, 300_000,
];

/** A repeat of a pending question (EL retry, or the agent re-asking) joins its row. */
export function normalizeQuestion(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** The bearer is only ever stored and compared as this hash (INV-11/INV-12). */
export function hashConsultToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

type ConsultWaiter = (r: { kind: "answered"; answer: string } | { kind: "call_ended" }) => void;

/** `~/x` → `<home>/x`; anything else unchanged. */
function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? `${homedir()}${path.slice(1)}` : path;
}

export const defaultIds: IdProvider = {
  newId: () => randomUUID(),
  newToken: () => randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""),
};

/** Events written right after a call record goes terminal (see `emit`). */
const TERMINAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  "call.ended",
  "call.completed",
  "call.failed",
]);

export class CallService {
  readonly events = new EventEmitter();
  private sessions = new Map<string, LiveSession>();
  private durationTimers = new Map<string, NodeJS.Timeout>();
  private pollers = new Map<string, DelegatePoller>();
  /** Single-flight agent provisioning per agent key (serve is the one writer — INV-9). */
  private provisioning = new Map<string, Promise<AgentPreview>>();
  /** Held consult requests, per question id (in memory — lost on restart, by design). */
  private consultWaiters = new Map<string, Set<ConsultWaiter>>();
  /**
   * Per call, per addressee: when a host last polled get_call_events, and how
   * many long-polls are open. The addressee is "" for an ordinary host; on a
   * meeting it is the member key a poll named with `as` (D-98, per member).
   */
  private hostPolls = new Map<string, Map<string, { lastMs: number; open: number }>>();

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
    /** Hangs up an off-device call's phone leg (O-30); null = end_call refuses on those calls. */
    private phoneLegHangup: PhoneLegHangupPort | null = null,
  ) {}

  emit(callId: string, type: string, data: Record<string, unknown> = {}): CallEvent {
    const event = this.store.appendEvent(callId, type, data);
    this.events.emit("event", event);
    this.metrics?.counter("tel_events_total", "Events appended").inc();
    // The single place a call's terminal transition is observed: every path
    // (relay end, Twilio status callback, the delegate poller's call.ended
    // and poll deadline, a failed dial) writes one of these events right
    // after the record goes terminal. Consult state dies here (PHASE-R § 3).
    if (TERMINAL_EVENT_TYPES.has(type)) this.cancelConsults(callId, "call_ended");
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
    return this.dial(input, null);
  }

  /**
   * The one dial pipeline (INV-5): place_call, and start_meeting with a
   * roster. A meeting changes only what the agent is briefed with, the
   * per-call variables, and the roster rows — never the dial path itself.
   */
  private async dial(
    input: PlaceCallInput & { dryRun?: boolean | undefined; idempotencyKey?: string | undefined },
    meeting: MeetingDial | null,
    patchPlan: (plan: CallPlan) => CallPlan = (plan) => plan,
  ): Promise<PlaceCallResult> {
    let plan: CallPlan;
    let number: string;
    try {
      const resolved = resolveRecipient(this.cfg, input.to);
      number = resolved.number;
      plan = patchPlan(buildCallPlan(this.cfg, resolved, input));
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
      brief = meeting
        ? buildMeetingBrief(this.cfg, { recordVoice: plan.recordingEnabled }, meeting.personaText)
        : buildBrief(this.cfg, plan.profile, {
            recordVoice: plan.recordingEnabled,
            consult: CALL_MODE_SPECS[plan.mode].supportsConsult,
          });
    }
    // dryRun creates NOTHING — not here, not on the platform (reads only).
    if (input.dryRun) {
      return {
        dryRun: true,
        plan,
        ...(brief ? { agent: this.previewAgent(plan, brief, meeting?.variables ?? null) } : {}),
      };
    }
    const notices = plan.notices.length > 0 ? { notices: plan.notices } : {};

    this.installKey ??= loadOrCreateInstallKey(ensureStateDir());
    // D-3b; a meeting's key also covers its roster (members, order, briefs).
    const idemKey =
      input.idempotencyKey ??
      deriveIdempotencyKey(
        this.installKey,
        number,
        plan.objective,
        plan.mode,
        meeting
          ? `${plan.profile}\u0000${MEETING_AGENT_STEM}\u0000${meeting.variables.roster}`
          : plan.profile,
      );
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
    // Consult (D-90/D-91): a per-call bearer, minted before the dial and
    // stored only as its hash. The plaintext lives in this stack frame until
    // it is handed to the platform as a `secret__` dynamic variable — never
    // logged, never returned, never persisted. dryRun returned above: it
    // mints nothing.
    let consultToken: string | null = null;
    if (CALL_MODE_SPECS[plan.mode].supportsConsult) {
      consultToken = randomBytes(32).toString("base64url");
      this.store.putConsultTokenHash(call.id, hashConsultToken(consultToken), now);
    }
    // No relay token for an off-device call: nothing may ever attach to /relay/.
    const token = offDevice ? null : this.ids.newToken();
    if (token) this.store.putRelayToken(token, call.id);
    this.emit(call.id, "call.created", {
      recipient: call.recipientAlias,
      suffix: call.numberSuffix,
      profile: call.profile,
      recording: call.recordingEnabled,
    });
    if (meeting) {
      // The roster is written before the dial, so a question that arrives the
      // moment the call connects already finds its addressee (INV-9: serve writes).
      const configured = this.cfg.meeting?.members ?? {};
      this.store.insertMeetingMembers(
        call.id,
        meeting.members.map((member) => {
          const m = configured[member];
          if (!m) throw new CallServiceError(`not a configured meeting member: ${member}`);
          return {
            member,
            label: m.label,
            displayName: m.displayName,
            voiceProfile: m.voiceProfile,
          };
        }),
      );
      this.emit(call.id, "meeting.started", { members: meeting.members });
    }

    try {
      if (brief) {
        const agent = await this.ensureAgent(plan.profile, brief);
        const { conversationId, phoneLegSid } = await (
          this.agentPlatform as AgentPlatformPort
        ).placeOutboundCall({
          agentId: agent.agentId as string,
          phoneNumberId: this.cfg.agentPlatform?.phoneNumberId as string,
          to: number,
          dynamicVariables: buildDynamicVariables(
            plan.objective,
            plan.context,
            consultToken,
            meeting?.variables ?? null,
          ),
        });
        consultToken = null;
        this.store.setProviderCallId(call.id, conversationId);
        // Kept whether or not a hang-up is configured, so adding one later
        // (O-30) also covers calls already in flight.
        if (phoneLegSid) this.store.setPhoneLegSid(call.id, phoneLegSid);
        this.metrics?.counter("tel_calls_total", "Calls dialed").inc();
        // No duration timer: the platform enforces max_duration_seconds itself.
        // The poller carries a deadline.
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

  // -- meetings (PHASE-GC Step 6) ---------------------------------------------

  /**
   * start_meeting: resolve the roster, brief the ensemble, then run the SAME
   * dial pipeline as place_call with mode `consult` and the meeting variant
   * (D-104, INV-5). Refusals name what is missing, at plan time.
   */
  async startMeeting(input: StartMeetingInput): Promise<StartMeetingResult> {
    const meeting = this.cfg.meeting;
    if (!meeting) {
      throw new CallServiceError(
        'start_meeting needs the "meeting" config block ({ "chair": { "voiceProfile": "…" }, "members": { "<session>": { "label", "displayName", "voiceProfile", "role" } } }) — none is configured',
      );
    }
    const members = input.members;
    if (members.length === 0)
      throw new CallServiceError("members: at least one member is required");
    const seen = new Set<string>();
    for (const m of members) {
      if (!meeting.members[m]) {
        throw new CallServiceError(
          `members: "${m}" is not a configured meeting member (configured: ${Object.keys(meeting.members).join(", ")})`,
        );
      }
      if (seen.has(m)) throw new CallServiceError(`members: "${m}" is listed twice`);
      seen.add(m);
    }
    const briefs = input.briefs ?? {};
    for (const key of Object.keys(briefs)) {
      if (!seen.has(key)) {
        throw new CallServiceError(`briefs: "${key}" is not one of this meeting's members`);
      }
    }
    // D-107: the persona lives in her home, referenced by machine-local config.
    // Read at brief time; a missing file refuses at plan time, naming the path.
    let personaText: string | null = null;
    if (meeting.chair.personaFile) {
      const path = expandHome(meeting.chair.personaFile);
      try {
        personaText = readFileSync(path, "utf8");
      } catch (err) {
        throw new CallServiceError(
          `meeting.chair.personaFile cannot be read (${meeting.chair.personaFile}): ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`,
        );
      }
    }
    const variables = buildMeetingVariables(meeting, members, briefs);
    const maxDurationSec = meetingMaxDurationSec(this.cfg, meeting);
    const result = await this.dial(
      {
        to: input.to,
        objective: input.agenda,
        context: input.context,
        // The chair's profile: its voice leads, its language is the agent's.
        profile: meeting.chair.voiceProfile,
        // A meeting is unrecorded unless asked for (INV-3); a profile's
        // record default does not apply to a room of agents.
        record: input.record ?? false,
        mode: "consult",
        acknowledgeThirdPartyRecording: input.acknowledgeThirdPartyRecording,
        dryRun: input.dryRun,
        idempotencyKey: input.idempotencyKey,
      },
      { members, variables, personaText },
      (plan) => ({
        ...plan,
        maxDurationSec,
        // The convenor is not the answerer: the members are (PHASE-GC § 2).
        notices: [
          ...plan.notices.filter((n) => n !== CONSULT_HOST_NOTICE),
          MEETING_CONVENOR_NOTICE,
        ],
      }),
    );
    const callId = result.dryRun ? null : result.call.id;
    const roster: MeetingRosterEntry[] = members.map((member) => {
      const m = meeting.members[member] as NonNullable<(typeof meeting.members)[string]>;
      return {
        member,
        displayName: m.displayName,
        label: m.label,
        voiceProfile: m.voiceProfile,
        listening: callId ? this.isHostListening(callId, member) : false,
      };
    });
    const joinInstructions = Object.fromEntries(
      members.map((m) => [m, memberJoinInstructions(m, callId ?? CALL_ID_PLACEHOLDER)]),
    );
    if (result.dryRun) {
      return {
        dryRun: true,
        agent: result.agent as AgentPreview,
        roster,
        joinInstructions,
        notices: result.plan.notices,
      };
    }
    return {
      callId: result.call.id,
      dryRun: false,
      deduped: result.deduped,
      agent: result.agent ?? this.meetingAgentPreview(result.call),
      roster,
      joinInstructions,
      notices: result.notices ?? [],
    };
  }

  /** A deduped retry has no fresh provisioning result: describe the stored agent instead. */
  private meetingAgentPreview(call: CallRecord): AgentPreview {
    const key = agentKey(MEETING_AGENT_STEM, {
      recordVoice: call.recordingEnabled,
      meeting: true,
    });
    const row = this.store.getAgentProfile(key);
    return {
      platform: this.agentPlatform?.id ?? "none",
      name: agentName(MEETING_AGENT_STEM, { recordVoice: call.recordingEnabled, meeting: true }),
      agentId: row?.agentId ?? null,
      action: "reuse",
      briefHash: row?.briefHash ?? "",
    };
  }

  /** A meeting call is one with a roster (written at dial time, before the call connects). */
  meetingMembersOf(callId: string): string[] | null {
    const rows = this.store.listMeetingMembers(callId);
    return rows.length > 0 ? rows.map((r) => r.member) : null;
  }

  // -- delegate calls (Phase Q) ---------------------------------------------

  /** dryRun: what provisioning WOULD do, from a store read. Creates nothing. */
  private previewAgent(
    plan: CallPlan,
    brief: AgentBrief,
    meeting: MeetingVariables | null = null,
  ): AgentPreview {
    const hash = briefHash(brief);
    const existing = this.store.getAgentProfile(agentKey(plan.profile, briefVariant(brief)));
    return {
      platform: (this.agentPlatform as AgentPlatformPort).id,
      name: brief.name,
      agentId: existing?.agentId ?? null,
      action: planAgentAction(existing, hash),
      briefHash: hash,
      brief,
      dynamicVariables: buildDynamicVariables(plan.objective, plan.context, null, meeting),
    };
  }

  /**
   * Idempotent provisioning: create on first use, update only when the brief
   * hash moved, otherwise reuse. Single-flight per agent key, so two calls
   * racing on a new profile create ONE agent.
   */
  private ensureAgent(profile: string, brief: AgentBrief): Promise<AgentPreview> {
    const key = agentKey(profile, briefVariant(brief));
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

  // -- consult (Phase R) ----------------------------------------------------

  /**
   * The tool listener's bearer check: hash, then look the hash up. Resolves
   * only while the call is live — the row is deleted when it ends.
   */
  resolveConsultBearer(token: string): CallRecord | null {
    const callId = this.store.getCallIdForConsultTokenHash(hashConsultToken(token));
    if (!callId) return null;
    const call = this.store.getCall(callId);
    if (!call || TERMINAL_STATUSES.has(call.status)) return null;
    if (!CALL_MODE_SPECS[this.modeOf(call)].supportsConsult) return null;
    return call;
  }

  /**
   * A host began (or finished) a get_call_events poll for this call. Feeds
   * `unavailable`: a question is only held while someone is listening (O-38).
   * Returns the matching `end` for a long-poll.
   */
  noteHostPoll(callId: string, as?: string): () => void {
    const perCall =
      this.hostPolls.get(callId) ?? new Map<string, { lastMs: number; open: number }>();
    this.hostPolls.set(callId, perCall);
    const key = as ?? "";
    const entry = perCall.get(key) ?? { lastMs: 0, open: 0 };
    entry.lastMs = this.clock.nowMs();
    entry.open += 1;
    perCall.set(key, entry);
    // "Making sure everyone picks up" (PHASE-GC § 3): the first poll per member, stamped once.
    if (as) this.store.stampMemberPolledIfUnset(callId, as, entry.lastMs);
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      entry.open = Math.max(0, entry.open - 1);
      entry.lastMs = this.clock.nowMs();
    };
  }

  /**
   * A long-poll in progress counts as listening; otherwise the last poll must
   * be recent. With an addressee (a meeting member), only THAT member's polls
   * count — D-98 applied per member.
   */
  isHostListening(callId: string, addressee?: string | null): boolean {
    const consult = this.cfg.agentPlatform?.consult;
    const entry = this.hostPolls.get(callId)?.get(addressee ?? "");
    if (!consult || !entry) return false;
    if (entry.open > 0) return true;
    return this.clock.nowMs() - entry.lastMs <= consult.hostIdleSec * 1000;
  }

  /** consult.pickup: the first time a polling host is handed this question. */
  markConsultPickedUp(callId: string, questionId: string): void {
    this.store.stampConsultPickupIfUnset(callId, questionId, this.clock.nowMs());
  }

  private consultOutcome(status: ConsultOutcome): void {
    this.metrics
      ?.counter("tel_consult_outcomes_total", "Consult tool calls answered, any outcome")
      .inc();
    this.metrics
      ?.counter(`tel_consult_outcome_${status}_total`, `Consult outcome: ${status}`)
      .inc();
  }

  private finish(result: ConsultResult): ConsultResult {
    this.consultOutcome(result.status);
    return result;
  }

  /**
   * EL's agent asks the originator (PHASE-R § 2–3). ALWAYS resolves — within
   * `holdSec`, before EL's `response_timeout_secs` — with a result we worded.
   * `signal` aborts the hold when EL drops the request or the listener
   * closes; the row then stays as it is (an honest `pending`).
   */
  async askConsult(
    callId: string,
    input: {
      question?: string | undefined;
      collectQuestionId?: string | undefined;
      /** Meeting calls only (PHASE-GC § 3): the member asked. */
      agent?: string | undefined;
    },
    signal?: AbortSignal,
  ): Promise<ConsultResult> {
    const consult = this.cfg.agentPlatform?.consult;
    const call = this.store.getCall(callId);
    if (!consult || !call || TERMINAL_STATUSES.has(call.status)) {
      return this.finish({ status: "call_ended", guidance: CONSULT_GUIDANCE.call_ended });
    }
    // A meeting has its own hold (shorter: the whole room waits) and wording;
    // an ordinary consult call takes exactly the Phase R path (addressee null).
    const roster = this.meetingMembersOf(callId);
    const g: Guidance = roster ? MEETING_GUIDANCE : CONSULT_GUIDANCE;
    const holdMs = (roster && this.cfg.meeting ? this.cfg.meeting.holdSec : consult.holdSec) * 1000;
    const named = (r: ConsultResult, agent: string | null): ConsultResult =>
      this.finish(roster && agent ? { ...r, agent } : r);

    if (input.collectQuestionId) {
      // Scoped to THIS call: another call's id is indistinguishable from none.
      const q = this.store.getConsultQuestion(callId, input.collectQuestionId);
      const agent = q?.addressee ?? input.agent ?? null;
      if (!q) return named({ status: "not_found", guidance: g.not_found }, agent);
      if (q.status === "answered" || q.status === "delivered") {
        return named(this.deliverConsult(q, "collected"), agent);
      }
      if (q.status === "cancelled") {
        return named({ status: "call_ended", guidance: g.call_ended }, agent);
      }
      if (q.status === "unanswered") {
        return named({ status: "unavailable", guidance: g.unavailable }, agent);
      }
      // Still pending: hold for whatever is left of the original hold window.
      const remaining = this.isHostListening(callId, q.addressee)
        ? Math.max(0, q.askedAtMs + holdMs - this.clock.nowMs())
        : 0;
      return named(await this.holdConsult(q, remaining, g, signal), agent);
    }

    // Meeting: the addressee must be on THIS call's roster (the tool's enum is
    // every configured member; presence is per call).
    const addressee = roster ? (input.agent ?? "") : null;
    if (roster && addressee !== null && !roster.includes(addressee)) {
      return named({ status: "not_on_call", guidance: g.not_on_call }, addressee || null);
    }
    const question = (input.question ?? "").trim();
    const norm = normalizeQuestion(question);
    // A repeat of a pending question joins it: no new row, no second notice.
    const existing = norm ? this.store.findPendingConsultByNorm(callId, norm, addressee) : null;
    if (existing) {
      const remaining = Math.max(0, existing.askedAtMs + holdMs - this.clock.nowMs());
      return named(await this.holdConsult(existing, remaining, g, signal), addressee);
    }
    if (this.store.countPendingConsults(callId) >= consult.maxPendingPerCall) {
      return named({ status: "busy", guidance: g.busy }, addressee);
    }
    const q = this.store.insertConsultQuestion({
      id: this.ids.newId(),
      callId,
      question,
      questionNorm: norm,
      status: "pending",
      askedAtMs: this.clock.nowMs(),
      addressee,
    });
    // Only meeting events carry the addressee: a Phase R event is unchanged.
    const to = addressee !== null ? { addressee } : {};
    if (addressee !== null) this.store.incrementMemberQuestions(callId, addressee);
    if (!this.isHostListening(callId, addressee)) {
      // Nobody is polling: don't leave the callee on hold for no one.
      this.store.transitionConsult(callId, q.id, "pending", "unanswered");
      this.emit(callId, "consult.unanswered", {
        questionId: q.id,
        seq: q.seq,
        question: q.question,
        reason: "no_listener",
        ...to,
      });
      return named({ status: "unavailable", guidance: g.unavailable }, addressee);
    }
    this.emit(callId, "consult.asked", {
      questionId: q.id,
      seq: q.seq,
      question: q.question,
      ...to,
    });
    return named(await this.holdConsult(q, holdMs, g, signal), addressee);
  }

  /** Waits for the answer, the deadline, the call ending, or an abort — whichever is first. */
  private holdConsult(
    q: ConsultQuestion,
    holdMs: number,
    g: Guidance,
    signal?: AbortSignal,
  ): Promise<ConsultResult> {
    return new Promise((resolve) => {
      let settled = false;
      const waiters = this.consultWaiters.get(q.id) ?? new Set<ConsultWaiter>();
      this.consultWaiters.set(q.id, waiters);
      const cleanup = () => {
        clearTimeout(timer);
        waiters.delete(waiter);
        if (waiters.size === 0) this.consultWaiters.delete(q.id);
        signal?.removeEventListener("abort", onAbort);
      };
      const settle = (r: ConsultResult) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(r);
      };
      const waiter: ConsultWaiter = (r) => {
        if (r.kind === "call_ended") {
          settle({ status: "call_ended", guidance: g.call_ended });
          return;
        }
        const row = this.store.getConsultQuestion(q.callId, q.id);
        settle(
          row ? this.deliverConsult(row, "held") : { status: "not_found", guidance: g.not_found },
        );
      };
      const onTimeout = () => {
        // The answer may have landed between the timer and now: re-read.
        const row = this.store.getConsultQuestion(q.callId, q.id);
        if (row && (row.status === "answered" || row.status === "delivered")) {
          settle(this.deliverConsult(row, "held"));
          return;
        }
        if (row?.status === "cancelled") {
          settle({ status: "call_ended", guidance: g.call_ended });
          return;
        }
        this.emit(q.callId, "consult.timed_out", { questionId: q.id, holdMs });
        settle({ status: "pending", question_id: q.id, guidance: g.pending });
      };
      const onAbort = () =>
        // EL dropped the request (or the listener is closing): release the
        // waiter only. The row keeps its honest state until the call ends.
        settle({ status: "unavailable", guidance: g.unavailable });
      waiters.add(waiter);
      const timer = setTimeout(onTimeout, holdMs);
      timer.unref();
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** answered → delivered (first delivery wins the stamp); the answer is returned either way. */
  private deliverConsult(q: ConsultQuestion, via: "held" | "collected"): ConsultResult {
    const now = this.clock.nowMs();
    if (
      q.status === "answered" &&
      this.store.transitionConsult(q.callId, q.id, "answered", "delivered", {
        deliveredAtMs: now,
        deliveredVia: via,
      })
    ) {
      this.emit(q.callId, "consult.delivered", {
        questionId: q.id,
        via,
        waitedMs: now - q.askedAtMs,
      });
    }
    return { status: "answered", question_id: q.id, answer: q.answer ?? "" };
  }

  /**
   * The originating agent answers (answer_consult). First answer wins: the
   * guarded pending → answered UPDATE is the claim (D-94); a second gets 409.
   */
  answerConsult(
    callId: string,
    questionId: string,
    answer: string,
  ): { status: "answered"; delivered: boolean; collectable: boolean } {
    const call = this.requireCall(callId);
    const q = this.store.getConsultQuestion(callId, questionId);
    if (!q) throw new CallServiceError(`unknown question ${questionId} on call ${callId}`, 404);
    if (q.status === "cancelled" || TERMINAL_STATUSES.has(call.status)) {
      throw new CallServiceError("call ended; the answer was not delivered", 409);
    }
    const text = answer.trim();
    if (!text) throw new CallServiceError("answer must be non-empty");
    const now = this.clock.nowMs();
    if (
      !this.store.transitionConsult(callId, questionId, "pending", "answered", {
        answer: text,
        answeredAtMs: now,
      })
    ) {
      const current = this.store.getConsultQuestion(callId, questionId);
      throw new CallServiceError(
        current?.status === "unanswered"
          ? "question is closed: nobody was listening when it was asked, and the agent was told so"
          : current?.status === "cancelled"
            ? "call ended; the answer was not delivered"
            : "already answered",
        409,
      );
    }
    this.metrics
      ?.histogram("tel_consult_answer_ms", "Consult asked → answered", CONSULT_ANSWER_BUCKETS_MS)
      .observe(now - q.askedAtMs);
    this.emit(callId, "consult.answered", {
      questionId,
      answer: text,
      answerMs: now - q.askedAtMs,
    });
    const waiters = this.consultWaiters.get(questionId);
    const held = waiters !== undefined && waiters.size > 0;
    if (waiters) for (const w of [...waiters]) w({ kind: "answered", answer: text });
    return { status: "answered", delivered: held, collectable: !held };
  }

  /**
   * The call is over: release every held request with `call_ended`, close
   * pending rows, and delete the bearer so a leaked token dies with its call.
   * Idempotent; runs from `emit` on every terminal event and at startup.
   */
  cancelConsults(callId: string, reason: string): void {
    const cancelled = this.store.cancelPendingConsults(callId);
    for (const id of cancelled) {
      const waiters = this.consultWaiters.get(id);
      if (waiters) for (const w of [...waiters]) w({ kind: "call_ended" });
    }
    this.store.deleteConsultToken(callId);
    this.hostPolls.delete(callId); // every addressee's entry with it
    if (cancelled.length > 0) {
      this.emit(callId, "consult.cancelled", { reason, questionIds: cancelled });
    }
  }

  /** After a restart: consult state left on calls that went terminal while serve was down. */
  sweepEndedConsults(): number {
    const ids = this.store.terminalCallsWithConsultState();
    for (const id of ids) this.cancelConsults(id, "call_ended");
    return ids.length;
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
    if (CALL_MODE_SPECS[this.modeOf(call)].mediaPathOffDevice) {
      await this.endOffDeviceCall(call, reason);
      return;
    }
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
   * O-30: hang an off-device call up at the carrier. The platform cannot end
   * the conversation (D-79), but the carrier holds the phone leg.
   *
   * This does NOT write call.ended or a terminal status. The platform only
   * hands over the transcript once the conversation is `done` (D-83), and the
   * poller stops the moment the call record goes terminal — so closing the
   * record here would lose the whole transcript. Instead the hang-up is
   * announced as `call.hangup_requested` and the poller writes call.ended
   * exactly once, under its `el:terminal` claim, when the platform reports the
   * conversation over. The observer's contract is unchanged: follow
   * get_call_events until call.ended, then read get_transcript.
   */
  private async endOffDeviceCall(call: CallRecord, reason: string): Promise<void> {
    const hangup = this.phoneLegHangup;
    const sid = hangup ? this.store.getPhoneLegSid(call.id) : null;
    if (!hangup || !sid) {
      this.refuseIfOffDevice(call, "end_call", (holder) =>
        !hangup
          ? `${holder} holds the phone leg and exposes no API that hangs up a live conversation, and no carrier hang-up is configured (agentPlatform.twilioHangup). The agent ends the call itself (its end_call tool) or at the profile's max duration (${call.maxDurationSec}s); get_call_events will then deliver call.ended.`
          : `no phone-leg call SID is recorded for this call (${holder} did not return one, or the call predates hang-up support), so it cannot be hung up at the carrier. The agent ends it itself (its end_call tool) or at the profile's max duration (${call.maxDurationSec}s); get_call_events will then deliver call.ended.`,
      );
      return;
    }
    let outcome: "ended" | "already-ended";
    try {
      outcome = await hangup.hangUp(sid);
    } catch (err) {
      const error = String(redactValue((err as Error).message)).slice(0, 400);
      logger.warn("phone-leg hang-up failed", { callId: call.id, via: hangup.id, error });
      throw new CallServiceError(`end_call could not hang up through ${hangup.id}: ${error}`, 502);
    }
    logger.info("phone-leg hang-up", { callId: call.id, via: hangup.id, outcome });
    // One event however many times end_call is repeated.
    if (this.store.recordProviderEvent(call.id, "tel:hangup")) {
      this.emit(call.id, "call.hangup_requested", { reason, via: hangup.id, outcome });
    }
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
    this.hostPolls.clear();
  }
}

function briefVariant(brief: AgentBrief): {
  recordVoice: boolean;
  consult: boolean;
  meeting: boolean;
} {
  return {
    recordVoice: brief.recordVoice,
    consult: brief.consultTool !== undefined,
    // Only the ensemble's tool is addressed (PHASE-GC § 3).
    meeting: brief.consultTool?.addressees !== undefined,
  };
}

export { CallRequestError };
