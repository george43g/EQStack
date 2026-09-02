/**
 * Delivery truth (resilient-send RS-A) — pure derivation of the honest
 * three-state send result and the REALISED send pathway from a chat.db row.
 *
 * Why this exists: the osascript send surface reports "handed to Messages.app",
 * not "delivered". chat.db is the only place that knows whether the message
 * actually left the Mac (`error != 0` = a synchronous IDS/route failure, e.g.
 * 22 = an iMessage-first attempt to an SMS-only number that silently never
 * delivers) and which service it really went out on (an iMessage can be
 * downgraded to SMS). See BRIEF §5.
 *
 * RS-INV-2: never report sent as delivered. Exactly one of delivered / failed /
 * pending, and `pending` carries the do-not-assume disclaimer.
 * Pure and column-tolerant: a reduced chat.db (or an older macOS) may lack
 * is_sent / is_finished / was_downgraded; missing fields are `undefined` and
 * never flip a `delivered` or `failed` verdict.
 */

export type DeliveryState = "delivered" | "failed" | "pending";

/** A chat.db `message` row's delivery-relevant columns, any of which may be absent. */
export interface DeliveryRow {
  error?: number | null;
  isDelivered?: boolean | null;
  isSent?: boolean | null;
  isFinished?: boolean | null;
  /** Base service the row is stamped with. */
  service?: "iMessage" | "SMS" | string | null;
  /** chat.db `was_downgraded` — an iMessage that fell back to SMS. */
  wasDowngraded?: boolean | null;
}

export interface DeliveryStatus {
  state: DeliveryState;
  /** chat.db `error` code when failed (e.g. 22). Undefined otherwise. */
  errorCode?: number;
  /** The pathway Messages.app actually used, downgrade annotated. */
  sendMethod: string;
  note?: string;
}

const PENDING_NOTE =
  "Delivery not confirmed within the poll window. Do NOT assume delivered — re-check with get_messages or wait_for_reply before relying on delivery.";

const IDS_NOTE =
  "Synchronous send failure (IDS route/token — e.g. an iMessage-first attempt to an SMS-only number). The message did not leave this Mac.";

/** Derive the three-state result from a row. Absent verdict columns ⇒ pending. */
export function deriveDeliveryState(row: DeliveryRow): DeliveryState {
  if (row.error !== undefined && row.error !== null && row.error !== 0) return "failed";
  if (row.isDelivered === true) return "delivered";
  return "pending";
}

/**
 * Derive the realised send method. `service` is the base pathway; a downgrade
 * annotation is appended when the row shows an iMessage fell back to SMS.
 */
export function deriveSendMethod(row: DeliveryRow): string {
  const base = row.service === "SMS" ? "SMS" : row.service === "iMessage" ? "iMessage" : "unknown";
  if (row.wasDowngraded === true) return `${base} (downgraded iMessage→SMS)`;
  return base;
}

export function deriveDeliveryStatus(row: DeliveryRow): DeliveryStatus {
  const state = deriveDeliveryState(row);
  const sendMethod = deriveSendMethod(row);
  if (state === "failed") {
    return {
      state,
      sendMethod,
      ...(row.error != null ? { errorCode: row.error } : {}),
      note: IDS_NOTE,
    };
  }
  if (state === "pending") return { state, sendMethod, note: PENDING_NOTE };
  return { state, sendMethod };
}
