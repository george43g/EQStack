/**
 * Parse a message's edit / unsend history out of `message.message_summary_info`
 * (a binary plist). Structure (verified against the real DB, ReagentX
 * imessage-exporter `edited.rs` is the reference):
 *
 *   root.ec  → { "<partIndex>": [ { t: <typedstream Buffer>, d: <number date> }, … ] }
 *              the ordered versions of each edited message part.
 *   root.rp  → [ <partIndex>, … ]  parts the sender RETRACTED (unsent).
 *
 * The bplist decode is a thin wrapper; the interesting logic — reading the
 * dict, decoding each version's typedstream text, and normalizing the Cocoa
 * date — lives in the pure `parseEditSummary`, which is unit-tested with plain
 * objects (no bplist serialization required).
 */
import bplist from "bplist-parser";
import { extractAttributedBodyText } from "./attributed-body-text.js";
import type { EditHistory, EditVersion } from "./types.js";

const MAC_EPOCH_OFFSET_SECONDS = 978_307_200; // 2001-01-01 → 1970-01-01

/** Cocoa/Core Data date (seconds — or, defensively, nanoseconds — since 2001) → Date. */
function cocoaDateToDate(d: unknown): Date | null {
  if (typeof d !== "number" || !Number.isFinite(d)) return null;
  // chat.db stores nanoseconds; plist edit dates are seconds. Detect by magnitude.
  const seconds = Math.abs(d) > 1e15 ? d / 1e9 : d;
  const ms = (seconds + MAC_EPOCH_OFFSET_SECONDS) * 1000;
  const date = new Date(ms);
  const year = date.getUTCFullYear();
  // Guard against garbage — voice/edit history only exists on modern macOS.
  if (year < 2015 || year > 2100) return null;
  return date;
}

/** Coerce a typedstream value (Buffer/Uint8Array) to decoded text. */
function decodeVersionText(t: unknown): string | null {
  if (Buffer.isBuffer(t)) return extractAttributedBodyText(t) ?? null;
  if (t instanceof Uint8Array) return extractAttributedBodyText(Buffer.from(t)) ?? null;
  return null;
}

/**
 * Pure parse of an already-decoded `message_summary_info` dict into an
 * {@link EditHistory}. Returns null when the dict carries no edit/retract data.
 */
export function parseEditSummary(
  root: Record<string, unknown> | null | undefined,
): EditHistory | null {
  if (!root || typeof root !== "object") return null;

  const parts: EditHistory["parts"] = [];
  const ec = (root as { ec?: unknown }).ec;
  if (ec && typeof ec === "object") {
    for (const [key, value] of Object.entries(ec as Record<string, unknown>)) {
      const part = Number.parseInt(key, 10);
      if (!Number.isFinite(part) || !Array.isArray(value)) continue;
      const versions: EditVersion[] = value.map((v) => {
        const entry = (v ?? {}) as { t?: unknown; d?: unknown };
        return { text: decodeVersionText(entry.t), date: cocoaDateToDate(entry.d) };
      });
      if (versions.length > 0) parts.push({ part, versions });
    }
    parts.sort((a, b) => a.part - b.part);
  }

  const retractedParts: number[] = [];
  const rp = (root as { rp?: unknown }).rp;
  if (Array.isArray(rp)) {
    for (const p of rp) {
      const n = typeof p === "number" ? p : Number.parseInt(String(p), 10);
      if (Number.isFinite(n)) retractedParts.push(n);
    }
  }

  if (parts.length === 0 && retractedParts.length === 0) return null;
  return { parts, retractedParts };
}

/**
 * Decode `message_summary_info` (binary plist) into an {@link EditHistory}.
 * Returns null on absent/unparseable data or when there's no edit/retract info.
 */
export function extractEditHistory(msi: Buffer | null | undefined): EditHistory | null {
  if (!msi || msi.length === 0) return null;
  try {
    const parsed = bplist.parseBuffer(msi) as unknown[];
    const root = parsed?.[0] as Record<string, unknown> | undefined;
    return parseEditSummary(root);
  } catch {
    return null;
  }
}
