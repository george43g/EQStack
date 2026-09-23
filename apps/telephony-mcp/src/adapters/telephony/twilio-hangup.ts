/**
 * Twilio hang-up for off-device calls (O-30) — the one REST call that ends a
 * delegate call's phone leg, which ElevenLabs placed on a Twilio SUBACCOUNT
 * and exposes no endpoint to end (D-79). Plain fetch, the same style as
 * `twilio-conversation-relay.ts`; no Twilio SDK.
 *
 * `POST /2010-04-01/Accounts/{subaccount}/Calls/{CallSid}.json` with
 * `Status=completed`, Basic auth `apiKeySid:secret`. Twilio answers a leg that
 * is already over with error 21220 ("call is not in-progress"); that is the
 * outcome end_call wanted, so it resolves `already-ended` and a repeated
 * end_call stays idempotent.
 *
 * INV-12: the secret resolves by NAME on each request through the
 * SecretProvider — a missing secret fails this one end_call, naming the
 * variable, instead of stopping `serve`. It never appears in an error: the
 * response body is scrubbed of it before it becomes a message, and neither
 * SID is put in a message either (errors name the path template).
 */
import { redactValue } from "@george43g/robustness";
import type { TwilioHangupConfig } from "../../config/schema.js";
import type { PhoneLegHangupPort, SecretProvider } from "../../domain/ports.js";
import { TwilioApiError } from "./twilio-conversation-relay.js";

/** Twilio: "Call is not in-progress. Cannot redirect." — the leg already ended. */
export const TWILIO_CALL_NOT_IN_PROGRESS = 21220;

const LABEL = "POST /Accounts/{AccountSid}/Calls/{CallSid}.json";

export interface TwilioHangupOptions extends TwilioHangupConfig {
  secrets: SecretProvider;
  fetchImpl?: typeof fetch;
  apiBase?: string;
  timeoutMs?: number;
}

function twilioErrorCode(text: string): number | null {
  try {
    const code = (JSON.parse(text) as { code?: unknown }).code;
    return typeof code === "number" ? code : null;
  } catch {
    return null;
  }
}

export class TwilioPhoneLegHangup implements PhoneLegHangupPort {
  readonly id = "twilio";
  private fetchImpl: typeof fetch;
  private apiBase: string;

  constructor(private opts: TwilioHangupOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.apiBase = (opts.apiBase ?? "https://api.twilio.com").replace(/\/$/, "");
  }

  async hangUp(phoneLegSid: string): Promise<"ended" | "already-ended"> {
    const secret = await this.opts.secrets.get(this.opts.apiSecretRef);
    if (!secret) {
      throw new TwilioApiError(
        0,
        `missing Twilio hang-up secret: ${this.opts.apiSecretRef} (env or opkeep keychain cache)`,
      );
    }
    const auth = Buffer.from(`${this.opts.apiKeySid}:${secret}`).toString("base64");
    const url =
      `${this.apiBase}/2010-04-01/Accounts/${encodeURIComponent(this.opts.accountSid)}` +
      `/Calls/${encodeURIComponent(phoneLegSid)}.json`;
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({ Status: "completed" }).toString(),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
    });
    if (res.ok) return "ended";
    // Scrub the secret (and the header value built from it) before anything
    // is truncated or kept: an echo must not survive a cut.
    const text = (await res.text().catch(() => ""))
      .split(secret)
      .join("[redacted]")
      .split(auth)
      .join("[redacted]");
    const code = twilioErrorCode(text);
    if (code === TWILIO_CALL_NOT_IN_PROGRESS) return "already-ended";
    throw new TwilioApiError(
      res.status,
      `Twilio ${LABEL} → ${res.status}${code !== null ? ` (code ${code})` : ""}: ${String(
        redactValue(text.slice(0, 300)),
      )}`,
    );
  }
}

/** Null when the block is absent: end_call then keeps refusing on off-device calls. */
export function buildPhoneLegHangup(
  cfg: TwilioHangupConfig | undefined,
  secrets: SecretProvider,
  fetchImpl: typeof fetch = fetch,
): PhoneLegHangupPort | null {
  return cfg ? new TwilioPhoneLegHangup({ ...cfg, secrets, fetchImpl }) : null;
}
