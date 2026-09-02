/**
 * Recipient resolution — the INV-2 seam. A recipient is EITHER a configured
 * alias (nickname + defaults, never a permission) OR a raw E.164, for which an
 * ephemeral recipient is synthesised with `recordingPolicy: "manual"` (D-4).
 *
 * The two namespaces cannot collide: alias keys match ^[a-z0-9][a-z0-9-]*$
 * and E.164 always starts with "+".
 *
 * INV-11: `number` lives in memory only, from resolve to telephony.createCall.
 * It must never be persisted, logged, or emitted — everything downstream
 * carries alias + numberSuffix.
 *
 * Phases L–M resolve a CALLER through this same shape.
 */
import { lastFour } from "@george43g/robustness";
import type { Config, RecordingPolicy } from "../config/schema.js";
import { E164Schema } from "../config/schema.js";
import { CallRequestError } from "./call-requests.js";

export interface ResolvedRecipient {
  /** Config key, or `adhoc-<last4>` for a raw number. */
  alias: string;
  /** Full E.164 — in-memory ONLY, never persisted (INV-11). */
  number: string;
  displayName: string | null;
  recordingPolicy: RecordingPolicy;
  source: "config" | "adhoc";
}

export function adhocAlias(number: string): string {
  return `adhoc-${lastFour(number)}`;
}

export function resolveRecipient(cfg: Config, to: string): ResolvedRecipient {
  const configured = cfg.recipients[to];
  if (configured) {
    return {
      alias: to,
      number: configured.number,
      displayName: configured.displayName ?? null,
      recordingPolicy: configured.recordingPolicy,
      source: "config",
    };
  }
  if (E164Schema.safeParse(to).success) {
    return {
      alias: adhocAlias(to),
      number: to,
      displayName: null,
      recordingPolicy: "manual",
      source: "adhoc",
    };
  }
  // A parse failure, not a permission gate (INV-6): aliases are conveniences.
  throw new CallRequestError(
    `'${to}' is neither a configured alias nor E.164 (expected +<country><number>, e.g. +61400000000)`,
  );
}
