import { describe, expect, it } from "vitest";
import { assertRecordingToggleAllowed, ConsentError, initialRecordingState } from "./consent.js";

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
