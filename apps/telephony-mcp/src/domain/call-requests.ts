/**
 * One-shot call flow (Phase C — D-5/D-38/D-55).
 *
 * `buildCallPlan` is PURE: resolve settings + recording consent into the plan
 * `dryRun` returns. `createCallRequest` persists the request — still
 * load-bearing DATA: `RelaySession` reads `mode` and `context` off it after
 * the WebSocket attaches. The two-stage prepare/start flow and its TTL are
 * gone (D-5); idempotency moved to the keyed-hash claim in the store.
 *
 * INV-11: nothing here sees a full number except via ResolvedRecipient, and
 * only `numberSuffix` leaves this module.
 */

import { lastFour } from "@george43g/robustness";
import type { RecordingPolicy } from "../config/schema.js";
import {
  AGENT_PLATFORM_HOLDER,
  type Config,
  ConfigError,
  effectiveCallSettings,
} from "../config/schema.js";
import { ConsentError, initialRecordingState, resolveThirdPartyRecording } from "./consent.js";
import type { Clock, EventStore, IdProvider } from "./ports.js";
import type { ResolvedRecipient } from "./recipients.js";
import type { CallMode, CallRequest } from "./types.js";
import { CALL_MODE_SPECS } from "./types.js";

export class CallRequestError extends Error {}

/**
 * The originating agent's half of the consult harness (PHASE-R § 6), returned
 * as a `place_call` notice on every consult call — dryRun included.
 */
export const CONSULT_HOST_NOTICE =
  "This call can ask you questions. Stay in a get_call_events loop (waitMs ~25000) until call.ended. Answer each consult.asked with answer_consult promptly: short, speakable, self-contained. If you don't know, say so in the answer rather than waiting. The caller is on hold while you think.";

export interface PlaceCallInput {
  /** Config alias OR raw E.164 (resolved before this layer). */
  to: string;
  objective: string;
  context?: string | undefined;
  profile?: string | undefined;
  record?: boolean | undefined;
  mode?: CallMode | undefined;
  /**
   * D-76: required (or auto-supplied by consent.autoApproveThirdPartyDisclosures)
   * to record a call whose recording a third party makes and holds.
   */
  acknowledgeThirdPartyRecording?: boolean | undefined;
}

/** What would happen — the dryRun payload. Carries numberSuffix, never number. */
export interface CallPlan {
  recipientAlias: string;
  numberSuffix: string;
  displayName: string | null;
  source: "config" | "adhoc";
  objective: string;
  context: string | null;
  profile: string;
  mode: CallMode;
  recordingEnabled: boolean;
  recordingPolicy: RecordingPolicy;
  maxDurationSec: number;
  /**
   * Who would make and hold a recording of this call: "telephony-mcp" (our
   * encrypted local store, INV-13) or a named third party (D-76).
   */
  recordingHolder: string;
  /** The consent surface in plain words (D-76). Empty when there is nothing to disclose. */
  notices: string[];
}

/** Pure: no store writes, no ids, no clock. Throws on consent/config errors. */
export function buildCallPlan(
  cfg: Config,
  resolved: ResolvedRecipient,
  input: PlaceCallInput,
): CallPlan {
  const mode = input.mode ?? "byo-model";
  const spec = CALL_MODE_SPECS[mode];
  if (!spec.implemented) {
    throw new CallRequestError(`call mode '${mode}' is not implemented yet`);
  }
  // Off-device modes need a platform to hold the call (Phase Q, D-75).
  if (spec.mediaPathOffDevice && !cfg.agentPlatform) {
    throw new CallRequestError(
      `call mode '${mode}' needs the "agentPlatform" config block ({ "type": "elevenlabs-managed", "apiKeyRef": "ELEVENLABS_API_KEY", "phoneNumberId": "phnum_…" }) — none is configured`,
    );
  }
  // Phase R: the consult loop needs its public tool channel configured.
  if (spec.supportsConsult && !cfg.agentPlatform?.consult) {
    throw new CallRequestError(
      `call mode '${mode}' needs the "agentPlatform.consult" config block ({ "toolsBaseUrl": "https://tools.<your-domain>", "holdSec": 45, "maxPendingPerCall": 3, "hostIdleSec": 90, "allowedSourceIps": [ElevenLabs egress IPs] }) — none is configured`,
    );
  }
  const profileName = input.profile ?? "default";
  const settings = effectiveCallSettings(cfg, profileName);
  // INV-3's three policies decide first; the third-party rule (D-76) only
  // ever narrows what they allowed.
  const thirdParty =
    spec.mediaPathOffDevice && cfg.agentPlatform
      ? AGENT_PLATFORM_HOLDER[cfg.agentPlatform.type]
      : null;
  const { recordingEnabled, notice } = resolveThirdPartyRecording({
    recordingEnabled: initialRecordingState(
      resolved.recordingPolicy,
      input.record,
      settings.profile.record,
    ),
    requested: input.record,
    holder: thirdParty,
    acknowledgedPerCall: input.acknowledgeThirdPartyRecording === true,
    autoApprove: cfg.consent.autoApproveThirdPartyDisclosures,
  });
  return {
    recipientAlias: resolved.alias,
    numberSuffix: lastFour(resolved.number),
    displayName: resolved.displayName,
    source: resolved.source,
    objective: input.objective,
    context: input.context ?? null,
    profile: profileName,
    mode,
    recordingEnabled,
    recordingPolicy: resolved.recordingPolicy,
    maxDurationSec: settings.maxDurationSec,
    recordingHolder: thirdParty ?? "telephony-mcp",
    notices: [...(notice ? [notice] : []), ...(spec.supportsConsult ? [CONSULT_HOST_NOTICE] : [])],
  };
}

/** Persist the request the plan describes; returns the load-bearing record. */
export function createCallRequest(
  plan: CallPlan,
  store: EventStore,
  clock: Clock,
  ids: IdProvider,
): CallRequest {
  const request: CallRequest = {
    id: ids.newId(),
    recipientAlias: plan.recipientAlias,
    numberSuffix: plan.numberSuffix,
    objective: plan.objective,
    context: plan.context,
    profile: plan.profile,
    mode: plan.mode,
    recordingEnabled: plan.recordingEnabled,
    maxDurationSec: plan.maxDurationSec,
    createdAtMs: clock.nowMs(),
    startedCallId: null,
  };
  store.createCallRequest(request);
  return request;
}

export { ConfigError, ConsentError };
