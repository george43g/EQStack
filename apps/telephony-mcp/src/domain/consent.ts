/**
 * Recording-consent rules. The three invariants (tested, not just documented):
 *
 *  - `never` recipients cannot be recorded — at prepare time or live.
 *  - `manual` recipients start unrecorded; enabling recording is a separate
 *    explicit tool call, and disclosure playback is likewise never automatic.
 *  - `preconsented` recipients record by default unless the request opts out.
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
          "recipient recordingPolicy is 'manual' — calls start unrecorded; use voice_set_recording after disclosure",
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
