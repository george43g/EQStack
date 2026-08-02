/**
 * Parser for Apple's typedstream format used in NSArchiver.
 * Forked from imessage-parser's TypedStreamParser to remove the upstream dependency.
 *
 * This handles the binary `attributedBody` column in the iMessage database,
 * which stores NSAttributedString data serialised via NSArchiver (typedstream format).
 *
 * SAFETY: All loops have iteration guards to prevent infinite loops on malformed blobs.
 */
import { BufferReader } from "./buffer-reader.js";

export interface NSStringData {
  className: string;
  content: string;
  encoding: string;
}

/**
 * Preamble bytes following "NSString" before the length byte.
 * Apple uses variants of this 5-byte sequence — most commonly 0x94, but
 * 0x95 appears for messages that contain DataDetector annotations
 * (phone numbers, dates, auth codes). Both must be recognized or the
 * length byte will be misread (causing extracted text leaks like
 * "()*+Z$classname...").
 */
const PREAMBLE_BYTE_2_VARIANTS = new Set([0x94, 0x95]);
const PREAMBLE_LEN = 5;

function matchesNSStringPreamble(bytes: Buffer | null): boolean {
  if (!bytes || bytes.length < PREAMBLE_LEN) return false;
  return (
    bytes[0] === 0x01 &&
    PREAMBLE_BYTE_2_VARIANTS.has(bytes[1]) &&
    bytes[2] === 0x84 &&
    bytes[3] === 0x01 &&
    bytes[4] === 0x2b
  );
}

const METADATA_KEYWORDS = [
  "streamtyped",
  "NSMutableAttributedString",
  "NSAttributedString",
  "NSObject",
  "NSMutableString",
  "NSString",
  "NSDictionary",
  "NSNumber",
  "NSValue",
  "NSFont",
  "NSParagraphStyle",
  "__kIM",
  "NSData",
  "bplist",
  "NSKeyedArchiver",
  "NS.rangeval",
  "Z$classname",
  "$class",
  "$classname",
];

export class TypedStreamParser {
  private reader: BufferReader;
  private headerParsed = false;

  constructor(buffer: Buffer) {
    this.reader = new BufferReader(buffer);
  }

  /** Parse all NSString objects found in the buffer. */
  parseAllNSStrings(): NSStringData[] {
    const strings: NSStringData[] = [];
    this.parseHeader();

    const maxIter = this.reader.length;
    let iter = 0;
    while (this.reader.remaining > 0 && iter++ < maxIter) {
      const posBefore = this.reader.position;
      const found = this.parseNSString();
      if (found) {
        strings.push(found);
      } else if (this.reader.remaining > 0) {
        // If parseNSString didn't advance, skip ahead
        if (this.reader.position <= posBefore) {
          this.reader.skip(1);
        }
      }
      // Stall detection: if position hasn't changed, force advance
      if (this.reader.position <= posBefore && this.reader.remaining > 0) {
        this.reader.skip(1);
      }
    }

    return strings;
  }

  /** Fallback: extract readable text segments by scanning for printable byte runs. */
  extractReadableText(): string[] {
    this.reader.seek(0);
    const texts: string[] = [];
    let current = "";
    let inText = false;

    const maxIter = this.reader.length;
    let iter = 0;
    while (this.reader.remaining > 0 && iter++ < maxIter) {
      const posBefore = this.reader.position;
      const byte = this.reader.readUInt8();

      if ((byte >= 32 && byte <= 126) || byte === 9 || byte === 10 || byte === 13) {
        // ASCII printable or whitespace
        current += String.fromCharCode(byte);
        inText = true;
      } else if (byte >= 0xc0 && byte <= 0xf7) {
        // Potential UTF-8 multi-byte sequence start
        const extraBytes = byte < 0xe0 ? 1 : byte < 0xf0 ? 2 : 3;
        if (this.reader.remaining >= extraBytes) {
          // Read continuation bytes
          const bytes = [byte];
          let valid = true;
          for (let i = 0; i < extraBytes; i++) {
            const cont = this.reader.readUInt8();
            if ((cont & 0xc0) !== 0x80) {
              valid = false;
              break;
            }
            bytes.push(cont);
          }
          if (valid) {
            try {
              current += Buffer.from(bytes).toString("utf8");
              inText = true;
            } catch {
              this.flushSegment(current, inText, texts);
              current = "";
              inText = false;
            }
          } else {
            this.flushSegment(current, inText, texts);
            current = "";
            inText = false;
          }
        } else {
          // Not enough bytes for UTF-8 sequence
          this.flushSegment(current, inText, texts);
          current = "";
          inText = false;
        }
      } else {
        // Control char or invalid byte
        this.flushSegment(current, inText, texts);
        current = "";
        inText = false;
      }

      // Stall detection: position must have advanced
      if (this.reader.position <= posBefore) {
        if (this.reader.remaining > 0) this.reader.skip(1);
        else break;
      }
    }

    this.flushSegment(current, true, texts);
    return texts;
  }

  // ── Private ──────────────────────────────────────────────────────────

  private parseHeader(): void {
    if (this.headerParsed) return;
    const magic = this.reader.peekBytes(11);
    if (!magic || magic.toString("ascii") !== "streamtyped") return;

    this.reader.skip(11);
    // Skip until we find an uppercase letter (class name start), with iteration guard
    const maxSkip = Math.min(this.reader.remaining, 256);
    let skipped = 0;
    while (this.reader.remaining > 0 && skipped++ < maxSkip) {
      const next4 = this.reader.peekBytes(4);
      if (next4 && /^[A-Z]/.test(next4.toString("ascii"))) break;
      this.reader.skip(1);
    }
    this.headerParsed = true;
  }

  private parseNSString(): NSStringData | null {
    const pos = this.reader.findPattern("NSString");
    if (pos === -1) {
      // No more NSString patterns — skip to end to stop the loop
      this.reader.seek(this.reader.length);
      return null;
    }

    this.reader.seek(pos + 8); // skip "NSString"

    const preamble = this.reader.peekBytes(PREAMBLE_LEN);
    if (matchesNSStringPreamble(preamble)) {
      this.reader.skip(PREAMBLE_LEN);
    }

    if (this.reader.remaining < 1) return null;
    const lengthByte = this.reader.readUInt8();
    let length: number;
    if (lengthByte === 0x81) {
      if (this.reader.remaining < 2) return null;
      length = this.reader.readUInt16LE();
    } else {
      length = lengthByte;
    }

    if (length === 0 || length > this.reader.remaining) return null;

    return {
      className: "NSString",
      content: this.reader.readString(length, "utf8"),
      encoding: "utf8",
    };
  }

  private flushSegment(text: string, inText: boolean, out: string[]): void {
    if (!inText || text.length <= 3) return;
    const cleaned = this.cleanText(text);
    if (cleaned.length > 3) out.push(cleaned);
  }

  private cleanText(text: string): string {
    let cleaned = text;
    for (const kw of METADATA_KEYWORDS) {
      cleaned = cleaned.replaceAll(kw, "");
    }
    return (
      cleaned
        .replace(/\{[^}]*\}/g, "")
        .replace(/\[[^\]]*\]/g, "")
        // biome-ignore lint/suspicious/noControlCharactersInRegex: typedstream blobs contain binary control bytes.
        .replace(/[\x00-\x1f]/g, "")
        .replace(/\s+/g, " ")
        .trim()
    );
  }
}
