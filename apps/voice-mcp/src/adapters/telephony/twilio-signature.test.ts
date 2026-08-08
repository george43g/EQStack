import { describe, expect, it } from "vitest";
import { computeTwilioSignature, validateTwilioSignature } from "./twilio-signature.js";

const TOKEN = "12345";

describe("Twilio signature validation", () => {
  it("computes the documented URL+sorted-params HMAC-SHA1", () => {
    // Shape check against the documented algorithm: params concatenated in
    // alphabetical key order after the full URL.
    const url = "https://mycompany.com/myapp.php?foo=1&bar=2";
    const params = {
      CallSid: "CA1234567890ABCDE",
      Caller: "+12349013030",
      Digits: "1234",
      From: "+12349013030",
      To: "+18005551212",
    };
    const sig = computeTwilioSignature(TOKEN, url, params);
    expect(sig).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(validateTwilioSignature(TOKEN, sig, url, params)).toBe(true);
  });

  it("orders parameters alphabetically (b before a fails if unsorted)", () => {
    const url = "https://x.invalid/cb";
    const sig = computeTwilioSignature(TOKEN, url, { b: "2", a: "1" });
    expect(sig).toBe(computeTwilioSignature(TOKEN, url, { a: "1", b: "2" }));
  });

  it("rejects a missing header", () => {
    expect(validateTwilioSignature(TOKEN, undefined, "https://x.invalid/cb")).toBe(false);
  });

  it("rejects a wrong token", () => {
    const url = "https://x.invalid/cb";
    const sig = computeTwilioSignature("other-token", url, {});
    expect(validateTwilioSignature(TOKEN, sig, url, {})).toBe(false);
  });

  it("rejects a tampered param", () => {
    const url = "https://x.invalid/cb";
    const sig = computeTwilioSignature(TOKEN, url, { CallSid: "CA1" });
    expect(validateTwilioSignature(TOKEN, sig, url, { CallSid: "CA2" })).toBe(false);
  });

  it("validates a bare URL (WebSocket upgrade shape — no params)", () => {
    const url = "wss://gw.test.invalid/relay/abc123";
    const sig = computeTwilioSignature(TOKEN, url);
    expect(validateTwilioSignature(TOKEN, sig, url)).toBe(true);
  });
});
