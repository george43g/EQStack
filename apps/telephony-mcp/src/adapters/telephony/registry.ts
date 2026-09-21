/**
 * Telephony adapter registry. `twilio-media-streams` is a reserved id: config
 * accepts it (staging), construction refuses it with an explicit error
 * instead of a silent fallback.
 *
 * `elevenlabs-managed` was reserved here in Phase B and REVERSED by D-75: it
 * is not a telephony adapter (ElevenLabs owns the whole phone leg in delegate
 * mode — there is nothing for a TelephonyAdapter to do), so it now names the
 * AgentPlatformPort configured under the top-level `agentPlatform` block. A
 * config that still says `telephony.type: "elevenlabs-managed"` is refused
 * with a pointer to that block, never silently reinterpreted.
 */
import type { TelephonyConfig } from "../../config/schema.js";
import type { SecretProvider, TelephonyAdapter } from "../../domain/ports.js";
import { TwilioConversationRelayAdapter } from "./twilio-conversation-relay.js";

export const RESERVED_TELEPHONY_IDS = ["elevenlabs-managed", "twilio-media-streams"] as const;

export class AdapterConstructionError extends Error {}

/** The refusal for each reserved id — exported so tests pin the exact pointer. */
export function reservedTelephonyIdError(type: string): string {
  if (type === "elevenlabs-managed") {
    return 'telephony.type "elevenlabs-managed" moved (D-75): ElevenLabs is an agent platform, not a telephony adapter. Keep telephony.type "twilio-conversation-relay" and add a top-level "agentPlatform" block — { "type": "elevenlabs-managed", "apiKeyRef": "ELEVENLABS_API_KEY", "phoneNumberId": "phnum_…" } — then place calls with mode "delegate"';
  }
  return `telephony adapter "${type}" is reserved for a future version — v1 implements only "twilio-conversation-relay"`;
}

export async function buildTelephonyAdapter(
  cfg: TelephonyConfig,
  secrets: SecretProvider,
  fetchImpl: typeof fetch = fetch,
): Promise<TelephonyAdapter> {
  if ((RESERVED_TELEPHONY_IDS as readonly string[]).includes(cfg.type)) {
    throw new AdapterConstructionError(reservedTelephonyIdError(cfg.type));
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
