import { describe, expect, it } from "vitest";
import { COMMAND_NAMES } from "../commands/specs.js";
import {
  assertRecordingToggleAllowed,
  ConsentError,
  initialRecordingState,
  resolveThirdPartyRecording,
  thirdPartyRecordingNotice,
} from "./consent.js";

describe("recording consent rules", () => {
  it("never: recording is impossible and requesting it is an error", () => {
    expect(initialRecordingState("never", undefined, true)).toBe(false);
    expect(initialRecordingState("never", false, undefined)).toBe(false);
    expect(() => initialRecordingState("never", true, undefined)).toThrow(ConsentError);
  });

  it("manual: always starts unrecorded; requesting recording up-front is an error", () => {
    expect(initialRecordingState("manual", undefined, true)).toBe(false);
    expect(() => initialRecordingState("manual", true, undefined)).toThrow(ConsentError);
  });

  it("preconsented: on by default, request overrides profile default", () => {
    expect(initialRecordingState("preconsented", undefined, undefined)).toBe(true);
    expect(initialRecordingState("preconsented", undefined, false)).toBe(false);
    expect(initialRecordingState("preconsented", false, true)).toBe(false);
    expect(initialRecordingState("preconsented", true, false)).toBe(true);
  });

  it("live toggle: enabling for 'never' is refused; disabling is always allowed", () => {
    expect(() => assertRecordingToggleAllowed("never", true)).toThrow(ConsentError);
    expect(() => assertRecordingToggleAllowed("never", false)).not.toThrow();
    expect(() => assertRecordingToggleAllowed("manual", true)).not.toThrow();
    expect(() => assertRecordingToggleAllowed("preconsented", true)).not.toThrow();
  });
});

describe("manual-policy refusal names a tool that exists", () => {
  it("points at set_recording (the INV-1 name), never the retired voice_set_recording", () => {
    let message = "";
    try {
      initialRecordingState("manual", true, undefined);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("use set_recording after disclosure");
    expect(message).not.toContain("voice_set_recording");
    // And the tool it names is really registered.
    expect(COMMAND_NAMES).toContain("set_recording");
  });
});

describe("third-party recording (D-76)", () => {
  const base = { holder: "ElevenLabs", acknowledgedPerCall: false, autoApprove: false };

  it("a holder of null (our own encrypted store) changes nothing", () => {
    expect(
      resolveThirdPartyRecording({
        ...base,
        holder: null,
        recordingEnabled: true,
        requested: true,
      }),
    ).toEqual({ recordingEnabled: true, notice: null });
  });

  it("nothing to decide when recording is already off", () => {
    expect(
      resolveThirdPartyRecording({ ...base, recordingEnabled: false, requested: false }),
    ).toEqual({ recordingEnabled: false, notice: null });
  });

  it("explicit record: true without acknowledgement throws, naming the holder and both ways out", () => {
    const attempt = () =>
      resolveThirdPartyRecording({ ...base, recordingEnabled: true, requested: true });
    expect(attempt).toThrow(ConsentError);
    expect(attempt).toThrow(/ElevenLabs, a third party/);
    expect(attempt).toThrow(/acknowledgeThirdPartyRecording: true/);
    expect(attempt).toThrow(/consent\.autoApproveThirdPartyDisclosures/);
  });

  it("an implicit default without acknowledgement starts unrecorded and says so", () => {
    const d = resolveThirdPartyRecording({ ...base, recordingEnabled: true, requested: undefined });
    expect(d.recordingEnabled).toBe(false);
    expect(d.notice).toMatch(/^Recording is OFF/);
  });

  it("per-call acknowledgement records and discloses where the recording lives", () => {
    const d = resolveThirdPartyRecording({
      ...base,
      acknowledgedPerCall: true,
      recordingEnabled: true,
      requested: true,
    });
    expect(d.recordingEnabled).toBe(true);
    expect(d.notice).toBe(thirdPartyRecordingNotice("ElevenLabs"));
    expect(d.notice).toMatch(/not in telephony-mcp's encrypted local store/);
  });

  it("the config flag auto-approves AND silences — explicit or implicit", () => {
    for (const requested of [true, undefined]) {
      expect(
        resolveThirdPartyRecording({
          ...base,
          autoApprove: true,
          recordingEnabled: true,
          requested,
        }),
      ).toEqual({ recordingEnabled: true, notice: null });
    }
  });
});
