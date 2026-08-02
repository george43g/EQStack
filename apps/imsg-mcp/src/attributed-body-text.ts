import { tryLoadNative } from "./native-bridge.js";
import { TypedStreamParser } from "./parsers/typedstream-parser.js";

/** Cache the native lookup once — null means TS fallback path. */
let _nativeParseAttributedBody: ((blob: Buffer) => string | null) | null | undefined;
function getNativeParser(): ((blob: Buffer) => string | null) | null {
  if (_nativeParseAttributedBody !== undefined) return _nativeParseAttributedBody;
  const native = tryLoadNative();
  _nativeParseAttributedBody = native ? native.parseAttributedBody.bind(native) : null;
  return _nativeParseAttributedBody;
}

/**
 * Decide whether to trust a native parser result. The Rust path uses simpler
 * heuristics and may return attachment IDs / metadata that the TS path knows
 * to filter. When we're unsure, fall through to TS for safety.
 */
function nativeResultLooksTrustworthy(text: string): boolean {
  // Attachment GUID markers — never user-visible text
  if (/at_\d+_[0-9A-F-]{8,}/i.test(text)) return false;
  // Bare/length-byte-leaked UUID attribute values.
  if (/^.?[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i.test(text)) return false;
  if (/^.?at_[0-9A-F][0-9A-F_-]{19,}$/i.test(text)) return false;
  // Apple internal attribute name markers
  if (/__kIM[A-Z]/.test(text)) return false;
  // Class / archiver metadata
  if (/\$class|streamtyped|NSKeyedArchiver/.test(text)) return false;
  if (/^NS[A-Z][a-z]+/.test(text)) return false;
  // Doubled-uppercase-letter prefix — almost certainly a typedstream length-byte
  // leak (e.g. "HHeres the question..." where the byte 'H' = 0x48 = 72 is the
  // length of the actual content "Heres the question..."). The Rust path uses
  // simple split-on-control heuristics that don't understand typedstream framing,
  // so it can include the length byte as the first char of the result.
  // Reject so we fall through to the TS path's structured parser.
  if (/^([A-Z])\1[a-z]/.test(text)) return false;
  return true;
}

const METADATA_PATTERNS = [
  /^streamtyped$/i,
  /^NS[A-Z]/,
  /^[^A-Za-z0-9]*__kIM/,
  /^MessagePartAttributeName$/i,
  /^DataDetectedAttributeName$/i,
  /^CalendarEventAttributeName$/i,
  /^X\$version/,
  /^WversionYdd-result/,
  /^bplist/,
  /^\$class/,
  /^RMSV\$class/,
  /^NSData$/,
  /^NSDictionary$/,
  /^NSNumber$/,
  /^NSValue$/,
  /^at_\d+_[0-9A-F-]+$/i,
  // Bare-UUID attribute values (sticker/attachment GUIDs), optionally with the
  // leaked typedstream length byte in front ("$FE7B0D17-…", '$' = 0x24 = 36 =
  // a UUID's length). No human message is exactly a bare UUID.
  /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i,
  /^.[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i,
  // Transfer-GUID with leaked length byte ("Mat_BDA9FB97-…", 'M' = 77).
  /^.at_[0-9A-F][0-9A-F_-]{19,}$/i,
  /FileTransferGUIDAttributeName/i,
  /BaseWritingDirectionAttributeName/i,
  /^\d{2}.*��/,
];

// biome-ignore lint/suspicious/noControlCharactersInRegex: attributedBody payloads contain binary control bytes.
const CONTROL_OR_DEL_RE = /[\x00-\x1F\x7F]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: attributedBody payloads contain binary control bytes.
const CONTROL_SPLIT_RE = /[\x00-\x1F\x7F]+/g;

/** Max time (ms) to spend parsing a single attributedBody blob before giving up. */
const PARSE_TIMEOUT_MS = 200;

function normalizeCandidate(text: string): string | null {
  const normalized = text
    .replace(/^[+;:"'()&\s]+/, "")
    .replace(/^[^A-Za-z\d\s](?=[A-Z])/, "")
    .replace(/^[a-z\d](?=[A-Z])/, "")
    // Strip leading single uppercase letter when followed by another uppercase + lowercase
    // (length-byte artifact from typedstream — e.g. "OYes" -> "Yes" for a 79-char string,
    //  "JThat" -> "That" for a 74-char string). Only triggers when the leading letter is
    //  immediately followed by an uppercase + lowercase pattern indicating the real
    //  sentence start.
    .replace(/^[A-Z](?=[A-Z][a-z])/, "")
    .replace(CONTROL_OR_DEL_RE, " ")
    .replace(/\uFFFD+/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized || normalized === "�" || normalized === "￼") return null;
  if (normalized.length < 2 && !/[\u{1F300}-\u{1FAFF}]/u.test(normalized)) return null;
  if (/^[A-Za-z0-9]{1,2}$/.test(normalized)) return null;
  if (METADATA_PATTERNS.some((pattern) => pattern.test(normalized))) return null;
  return normalized;
}

function scoreCandidate(text: string): number {
  let score = 0;
  if (/[A-Za-z]/.test(text)) score += 50;
  if (/\d/.test(text)) score += 10;
  if (/\s/.test(text)) score += 30;
  if (/[.!?]/.test(text)) score += 15;
  if (/[\u{1F300}-\u{1FAFF}]/u.test(text)) score += 100;
  if (/^[A-Za-z0-9]{1,3}$/.test(text)) score -= 100;
  score += Math.min(text.length, 200);
  return score;
}

/** Boost factor for structured NSString candidates over heuristic byte-scan ones. */
const STRUCTURED_BOOST = 500;

/**
 * ASCII attribute-name marker for an iPhone-generated voice-note transcript
 * (iOS 17+). Present in ~102/658 audio blobs on the dev DB; absent on older
 * `.caf` voice notes that predate on-device transcription.
 */
const AUDIO_TRANSCRIPTION_MARKER = Buffer.from("IMAudioTranscription", "ascii");

/**
 * Fixed typedstream framing observed between the `IMAudioTranscription`
 * attribute name and the transcript value's length byte, identical across every
 * sampled iOS 17+ voice-note blob. All five bytes are >= 0x84, which sits above
 * both the multi-byte length markers (0x81/0x82) and any single-byte length
 * (<= 0x80) — that clean gap powers the defensive fallback scan below.
 */
const AUDIO_VALUE_FRAMING = Buffer.from([0x86, 0x92, 0x84, 0x96, 0x96]);

/**
 * Extract the iPhone-generated voice-note transcript from a message's
 * `attributedBody`, if present. Apple stores it as a typedstream ATTRIBUTE keyed
 * `IMAudioTranscription` whose value string uses a class back-reference — so the
 * literal-"NSString"-scanning {@link extractAttributedBodyText} never sees it
 * (it returns only the `￼` audio placeholder). We anchor on the ASCII
 * marker instead.
 *
 * Returns `undefined` when the blob has no synced transcript (the caller then
 * falls back to on-device / cloud transcription).
 */
export function extractAudioTranscription(blob: Buffer | null): string | undefined {
  if (!blob) return undefined;
  const markerAt = blob.indexOf(AUDIO_TRANSCRIPTION_MARKER);
  if (markerAt === -1) return undefined;

  let pos = markerAt + AUDIO_TRANSCRIPTION_MARKER.length;

  // Primary path: consume the known 5-byte value framing.
  if (blob.subarray(pos, pos + AUDIO_VALUE_FRAMING.length).equals(AUDIO_VALUE_FRAMING)) {
    pos += AUDIO_VALUE_FRAMING.length;
  } else {
    // Fallback (framing drift across macOS versions): the length marker is the
    // first byte in a small window that is a multi-byte marker (0x81/0x82) or a
    // single-byte length (<= 0x80); framing bytes are all >= 0x84.
    const scanEnd = Math.min(pos + 8, blob.length);
    let found = -1;
    for (let i = pos; i < scanEnd; i++) {
      const b = blob[i] as number;
      if (b === 0x81 || b === 0x82 || b <= 0x80) {
        found = i;
        break;
      }
    }
    if (found === -1) return undefined;
    pos = found;
  }

  if (pos >= blob.length) return undefined;
  const lenByte = blob[pos++] as number;
  let length: number;
  if (lenByte === 0x81) {
    if (pos + 2 > blob.length) return undefined;
    length = blob.readUInt16LE(pos);
    pos += 2;
  } else if (lenByte === 0x82) {
    if (pos + 4 > blob.length) return undefined;
    length = blob.readUInt32LE(pos);
    pos += 4;
  } else {
    length = lenByte;
  }
  if (length <= 0 || pos + length > blob.length) return undefined;

  const text = blob.toString("utf8", pos, pos + length).trim();
  // Reject mostly-control-byte garbage from a mis-framed read.
  if (!text || !/[\p{L}\p{N}]/u.test(text)) return undefined;
  return text;
}

export function extractAttributedBodyText(blob: Buffer | null): string | undefined {
  if (!blob) return undefined;

  // Fast path: native Rust parser, when available. We only trust the native
  // result when it looks like a real message (passes our metadata filter and
  // doesn't start with attachment-id markers). Otherwise fall through to the
  // TS implementation, which has more sophisticated heuristics.
  const native = getNativeParser();
  if (native) {
    try {
      const result = native(blob);
      if (result && result.length > 1 && nativeResultLooksTrustworthy(result)) {
        return result;
      }
    } catch {
      // Fall through to TS implementation on any native failure
    }
  }

  const parser = new TypedStreamParser(blob);
  const candidates = new Map<string, number>();
  const deadline = Date.now() + PARSE_TIMEOUT_MS;

  const remember = (values: string[], boost = 0) => {
    for (const value of values) {
      const normalized = normalizeCandidate(value);
      if (!normalized) continue;
      const score = scoreCandidate(normalized) + boost;
      // Use the highest score we've seen for this candidate
      const prev = candidates.get(normalized) ?? -Infinity;
      if (score > prev) candidates.set(normalized, score);
    }
  };

  // Phase 1: structured NSString parsing — these have correct length bytes,
  // so they avoid the "leading length-byte" artifact (e.g. "OYes lmk..." for a 79-char string).
  // Boost their score so they win over byte-scan fallbacks.
  let structuredTrusted = false;
  try {
    if (Date.now() < deadline) {
      const strings = parser.parseAllNSStrings();
      // A well-parsed NSString IS the message text (or "\uFFFC" for
      // attachment-only messages — deliberately empty). Everything else in
      // the blob is attribute METADATA — transfer GUIDs, attachment UUIDs,
      // attribute names — which the byte-scan phases kept resurrecting in
      // new shapes ("Mat_<uuid>", "$<uuid>", "EmojiImageAttributeName"…).
      // Trust the structured parse (and skip the scans) only when it yields
      // usable text or a pure attachment placeholder — a parse that produces
      // only garbage means the blob's framing is one we don't understand,
      // and the scans remain the fallback for exactly that case.
      structuredTrusted = strings.some(
        (entry) =>
          normalizeCandidate(entry.content) !== null || /^[\uFFFC\s]+$/.test(entry.content),
      );
      remember(
        strings.map((entry) => entry.content),
        STRUCTURED_BOOST,
      );
    }
  } catch {
    // Ignore parser failures — continue with fallback strategies
  }

  if (!structuredTrusted) {
    // Phase 2: heuristic text extraction (byte-by-byte scan)
    // Lower priority — may pick up length bytes as text artifacts.
    try {
      if (Date.now() < deadline) {
        remember(parser.extractReadableText());
      }
    } catch {
      // Ignore parser failures — continue with fallback strategies
    }

    // Phase 3: raw UTF-8 split (always works, cheapest fallback)
    if (Date.now() < deadline) {
      remember(blob.toString("utf8").split(CONTROL_SPLIT_RE));
    }
  }

  const best = [...candidates.entries()].sort((a, b) => b[1] - a[1])[0];
  return best?.[0];
}
