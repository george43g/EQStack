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
import { type Config, ConfigError, effectiveCallSettings } from "../config/schema.js";
import { ConsentError, initialRecordingState } from "./consent.js";
import type { Clock, EventStore, IdProvider } from "./ports.js";
import type { ResolvedRecipient } from "./recipients.js";
import type { CallMode, CallRequest } from "./types.js";
import { CALL_MODE_SPECS } from "./types.js";

export class CallRequestError extends Error {}

export interface PlaceCallInput {
  /** Config alias OR raw E.164 (resolved before this layer). */
  to: string;
  objective: string;
  context?: string | undefined;
  profile?: string | undefined;
  record?: boolean | undefined;
  mode?: CallMode | undefined;
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
}

/** Pure: no store writes, no ids, no clock. Throws on consent/config errors. */
export function buildCallPlan(
  cfg: Config,
  resolved: ResolvedRecipient,
  input: PlaceCallInput,
): CallPlan {
  const mode = input.mode ?? "byo-model";
  if (!CALL_MODE_SPECS[mode].implemented) {
    throw new CallRequestError(`call mode '${mode}' is not implemented yet`);
  }
  const profileName = input.profile ?? "default";
  const settings = effectiveCallSettings(cfg, profileName);
  const recordingEnabled = initialRecordingState(
    resolved.recordingPolicy,
    input.record,
    settings.profile.record,
  );
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
