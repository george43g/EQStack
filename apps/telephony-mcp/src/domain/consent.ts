/**
 * Recording-consent rules. The three invariants (tested, not just documented):
 *
 *  - `never` recipients cannot be recorded — at prepare time or live.
 *  - `manual` recipients start unrecorded; enabling recording is a separate
 *    explicit tool call, and disclosure playback is likewise never automatic.
 *  - `preconsented` recipients record by default unless the request opts out.
 *
 * Plus the third-party rule (D-76), applied AFTER those three: when the
 * recording would be made and held by someone other than us (a delegate call
 * recorded by ElevenLabs), it needs an explicit acknowledgement — per call, or
 * auto-supplied by `consent.autoApproveThirdPartyDisclosures`.
 */
import type { RecordingPolicy } from "../config/schema.js";

export class ConsentError extends Error {}

/** Decide the recording state a new call request starts with. */
export function initialRecordingState(
  policy: RecordingPolicy,
  requested: boolean | undefined,
  profileDefault: boolean | undefined,
): boolean {
  switch (policy) {
    case "never":
      if (requested === true) {
        throw new ConsentError(
          "recipient recordingPolicy is 'never' — recording cannot be requested",
        );
      }
      return false;
    case "manual":
      if (requested === true) {
        throw new ConsentError(
          "recipient recordingPolicy is 'manual' — calls start unrecorded; use set_recording after disclosure",
        );
      }
      return false;
    case "preconsented":
      return requested ?? profileDefault ?? true;
  }
}

/** Guard a live recording toggle. Disabling is always allowed. */
export function assertRecordingToggleAllowed(policy: RecordingPolicy, enable: boolean): void {
  if (enable && policy === "never") {
    throw new ConsentError("recipient recordingPolicy is 'never' — recording cannot be enabled");
  }
}

/** Plain-language statement of where a third-party recording lives (D-76). */
export function thirdPartyRecordingNotice(holder: string): string {
  return `This call is recorded by ${holder}, a third party. The recording is made and held in ${holder}'s own storage under ${holder}'s retention settings — not in telephony-mcp's encrypted local store — and telephony-mcp never copies it locally. To delete it, delete the conversation at ${holder}.`;
}

export interface ThirdPartyRecordingDecision {
  recordingEnabled: boolean;
  /** Present unless the caller auto-approved third-party disclosures. */
  notice: string | null;
}

/**
 * D-76. Runs after `initialRecordingState` (so `never`/`manual` have already
 * refused or started unrecorded). When the recording's holder is a third
 * party:
 *
 *  - explicit `record: true` without an acknowledgement → ConsentError that
 *    names the holder and both ways to acknowledge;
 *  - an IMPLICIT default (preconsented / profile `record`) without an
 *    acknowledgement → starts unrecorded, with a notice saying why: the
 *    recipient's standing consent was to OUR encrypted recording, and it does
 *    not stretch to a third party's storage;
 *  - acknowledged per call → records, notice included;
 *  - acknowledged by the config flag → records, notice suppressed.
 *
 * `holder` null means we hold it ourselves (INV-13) and nothing changes.
 */
export function resolveThirdPartyRecording(opts: {
  recordingEnabled: boolean;
  requested: boolean | undefined;
  holder: string | null;
  acknowledgedPerCall: boolean;
  autoApprove: boolean;
}): ThirdPartyRecordingDecision {
  const { recordingEnabled, requested, holder, acknowledgedPerCall, autoApprove } = opts;
  if (!recordingEnabled || holder === null) return { recordingEnabled, notice: null };
  if (autoApprove) return { recordingEnabled: true, notice: null };
  if (acknowledgedPerCall)
    return { recordingEnabled: true, notice: thirdPartyRecordingNotice(holder) };
  if (requested === true) {
    throw new ConsentError(
      `recording refused: on this call the recording would be made and held by ${holder}, a third party — not in telephony-mcp's encrypted local store, and never copied locally. To record anyway, pass acknowledgeThirdPartyRecording: true (or set consent.autoApproveThirdPartyDisclosures: true in config to acknowledge this for every call); otherwise pass record: false.`,
    );
  }
  return {
    recordingEnabled: false,
    notice: `Recording is OFF: on this call a recording would be made and held by ${holder}, a third party, and the recipient's default recording consent does not extend to third-party storage. To record, pass record: true with acknowledgeThirdPartyRecording: true (or set consent.autoApproveThirdPartyDisclosures).`,
  };
}
