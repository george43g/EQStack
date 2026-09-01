/**
 * X-Twilio-Signature validation (HMAC-SHA1 over the full public URL plus the
 * alphabetically-sorted POST params, base64, timing-safe compare). Applies to
 * webhook POSTs and the ConversationRelay WebSocket upgrade request alike —
 * every externally-reachable request must pass or be rejected.
 * https://www.twilio.com/docs/usage/security#validating-requests
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export function computeTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string> = {},
): string {
  let data = url;
  for (const key of Object.keys(params).sort()) {
    data += key + (params[key] ?? "");
  }
  return createHmac("sha1", authToken).update(Buffer.from(data, "utf-8")).digest("base64");
}

export function validateTwilioSignature(
  authToken: string,
  signatureHeader: string | undefined,
  url: string,
  params: Record<string, string> = {},
): boolean {
  if (!signatureHeader) return false;
  const expected = Buffer.from(computeTwilioSignature(authToken, url, params));
  const given = Buffer.from(signatureHeader);
  if (expected.length !== given.length) return false;
  return timingSafeEqual(expected, given);
}
