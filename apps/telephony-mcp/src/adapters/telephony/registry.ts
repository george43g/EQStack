/**
 * Telephony adapter registry. `elevenlabs-managed` and `twilio-media-streams`
 * are reserved ids: config accepts them (staging), construction refuses them
 * in v1 with an explicit error instead of a silent fallback.
 */
import type { TelephonyConfig } from "../../config/schema.js";
import type { SecretProvider, TelephonyAdapter } from "../../domain/ports.js";
import { TwilioConversationRelayAdapter } from "./twilio-conversation-relay.js";

export const RESERVED_TELEPHONY_IDS = ["elevenlabs-managed", "twilio-media-streams"] as const;

export class AdapterConstructionError extends Error {}

export async function buildTelephonyAdapter(
  cfg: TelephonyConfig,
  secrets: SecretProvider,
  fetchImpl: typeof fetch = fetch,
): Promise<TelephonyAdapter> {
  if ((RESERVED_TELEPHONY_IDS as readonly string[]).includes(cfg.type)) {
    throw new AdapterConstructionError(
      `telephony adapter "${cfg.type}" is reserved for a future version — v1 implements only "twilio-conversation-relay"`,
    );
  }
  const [accountSid, apiKey, apiSecret] = await Promise.all([
    secrets.get(cfg.accountSidRef),
    secrets.get(cfg.apiKeyRef),
    secrets.get(cfg.apiSecretRef),
  ]);
  const missing = [
    accountSid ? null : cfg.accountSidRef,
    apiKey ? null : cfg.apiKeyRef,
    apiSecret ? null : cfg.apiSecretRef,
  ].filter((x): x is string => x !== null);
  if (missing.length > 0) {
    throw new AdapterConstructionError(
      `missing Twilio credentials: ${missing.join(", ")} (env or opkeep keychain cache)`,
    );
  }
  return new TwilioConversationRelayAdapter(
    { accountSid: accountSid as string, apiKey: apiKey as string, apiSecret: apiSecret as string },
    fetchImpl,
  );
}
