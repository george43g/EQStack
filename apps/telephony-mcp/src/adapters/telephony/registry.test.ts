/**
 * Amendment C / D-75: `telephony.type: "elevenlabs-managed"` (the reversed
 * Phase B reservation) must fail with a pointer to the agentPlatform block,
 * never silently; `twilio-media-streams` keeps its plain reservation.
 */
import { describe, expect, it } from "vitest";
import { FakeSecrets, fakeSecretValues, testConfig } from "../../../tests/helpers.js";
import {
  AdapterConstructionError,
  buildTelephonyAdapter,
  RESERVED_TELEPHONY_IDS,
  reservedTelephonyIdError,
} from "./registry.js";

const secrets = new FakeSecrets(fakeSecretValues());

describe("reserved telephony ids", () => {
  it("both reserved ids are still reserved", () => {
    expect([...RESERVED_TELEPHONY_IDS]).toEqual(["elevenlabs-managed", "twilio-media-streams"]);
  });

  it("elevenlabs-managed refuses construction and points at the agentPlatform block", async () => {
    const cfg = testConfig({
      telephony: { type: "elevenlabs-managed", fromNumber: "+61255501234" },
    });
    const attempt = buildTelephonyAdapter(cfg.telephony, secrets);
    await expect(attempt).rejects.toBeInstanceOf(AdapterConstructionError);
    const msg = reservedTelephonyIdError("elevenlabs-managed");
    expect(msg).toContain("D-75");
    expect(msg).toContain('"agentPlatform"');
    expect(msg).toContain('"type": "elevenlabs-managed"');
    expect(msg).toContain('mode "delegate"');
    expect(msg).not.toMatch(/future version/);
    await expect(buildTelephonyAdapter(cfg.telephony, secrets)).rejects.toThrow(msg);
  });

  it("twilio-media-streams keeps its plain reservation", async () => {
    const cfg = testConfig({
      telephony: { type: "twilio-media-streams", fromNumber: "+61255501234" },
    });
    await expect(buildTelephonyAdapter(cfg.telephony, secrets)).rejects.toThrow(
      /"twilio-media-streams" is reserved for a future version/,
    );
  });
});
