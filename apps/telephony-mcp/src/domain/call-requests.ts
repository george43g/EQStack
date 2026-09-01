/**
 * Two-stage outgoing-call flow.
 *
 * Stage 1 (`voice_prepare_call`): resolve an allowlisted alias, apply consent
 * rules, persist an EXPIRING request that shows the number suffix, purpose,
 * profile, duration, and recording state.
 *
 * Stage 2 (`voice_start_call`): requires that request id plus explicit
 * confirmation. Retries after a successful dial return the already-created
 * call instead of dialing twice (`startedCallId`).
 */

import { lastFour } from "@george43g/robustness";
import { type Config, ConfigError, effectiveCallSettings } from "../config/schema.js";
import { ConsentError, initialRecordingState } from "./consent.js";
import type { Clock, EventStore, IdProvider } from "./ports.js";
import type { CallMode, CallRequest } from "./types.js";
import { CALL_MODE_SPECS } from "./types.js";

export class CallRequestError extends Error {}

export interface PrepareCallInput {
  recipient: string;
  objective: string;
  context?: string | undefined;
  profile?: string | undefined;
  record?: boolean | undefined;
  mode?: CallMode | undefined;
}

export function prepareCallRequest(
  cfg: Config,
  store: EventStore,
  clock: Clock,
  ids: IdProvider,
  input: PrepareCallInput,
): CallRequest {
  const recipient = cfg.recipients[input.recipient];
  if (!recipient) {
    throw new CallRequestError(
      `unknown recipient alias: ${input.recipient} (recipients are allowlisted in config)`,
    );
  }
  const profileName = input.profile ?? "default";
  const settings = effectiveCallSettings(cfg, profileName);
  const recordingEnabled = initialRecordingState(
    recipient.recordingPolicy,
    input.record,
    settings.profile.record,
  );
  const mode = input.mode ?? "byo-model";
  if (!CALL_MODE_SPECS[mode].implemented) {
    throw new CallRequestError(`call mode '${mode}' is not implemented yet`);
  }
  const now = clock.nowMs();
  const request: CallRequest = {
    id: ids.newId(),
    recipientAlias: input.recipient,
    numberSuffix: lastFour(recipient.number),
    objective: input.objective,
    context: input.context ?? null,
    profile: profileName,
    mode,
    recordingEnabled,
    maxDurationSec: settings.maxDurationSec,
    createdAtMs: now,
    expiresAtMs: now + cfg.limits.callRequestTtlMinutes * 60_000,
    startedCallId: null,
  };
  store.createCallRequest(request);
  return request;
}

/**
 * Validate a request for starting. Returns the request; when it was already
 * started, the caller must return the existing call (idempotent retry) and
 * MUST NOT dial again.
 */
export function resolveStartableRequest(
  store: EventStore,
  clock: Clock,
  requestId: string,
  confirm: boolean,
): CallRequest {
  if (!confirm) {
    throw new CallRequestError("explicit confirmation required (confirm: true) to start a call");
  }
  const request = store.getCallRequest(requestId);
  if (!request) throw new CallRequestError(`unknown call request: ${requestId}`);
  if (request.startedCallId === null && clock.nowMs() > request.expiresAtMs) {
    throw new CallRequestError(
      `call request ${requestId} expired — prepare a new one (voice_prepare_call)`,
    );
  }
  return request;
}

export { ConfigError, ConsentError };
