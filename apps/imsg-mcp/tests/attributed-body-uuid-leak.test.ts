/**
 * Attachment-only attributedBody blobs must extract NO text — the only
 * stringy content in them is attribute metadata (file-transfer GUIDs,
 * sticker/attachment UUIDs), which leaked as message text in two shapes on
 * real data: "Mat_<uuid>…" (transfer GUID + its length byte 'M' = 77) and
 * "$<uuid>" / bare "<uuid>" (attachment GUID, '$' = 0x24 = 36). Both the
 * Rust parser and this TS fallback must filter them.
 */
import { describe, expect, it } from "vitest";
import { extractAttributedBodyText } from "../src/attributed-body-text.js";

/** Byte-accurate replica of a real attachment-only blob (synthetic UUIDs). */
function makeAttachmentOnlyBlob(guidValue: string, lengthByte: number): Buffer {
  const head = Buffer.concat([
    Buffer.from([0x04, 0x0b]),
    Buffer.from("streamtyped"),
    Buffer.from([0x81, 0xe8, 0x03, 0x84, 0x01, 0x40, 0x84, 0x84, 0x84, 0x12]),
    Buffer.from("NSAttributedString"),
    Buffer.from([0x00, 0x84, 0x84, 0x08]),
    Buffer.from("NSObject"),
    Buffer.from([0x00, 0x85, 0x92, 0x84, 0x84, 0x84, 0x08]),
    Buffer.from("NSString"),
    Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b, 0x03]),
    Buffer.from("￼"), // the actual "text": one object-replacement char
    Buffer.from([0x86, 0x84, 0x02]),
    Buffer.from("iI"),
    Buffer.from([0x01, 0x01, 0x92, 0x84, 0x84, 0x84, 0x0c]),
    Buffer.from("NSDictionary"),
    Buffer.from([0x00, 0x94, 0x84, 0x01, 0x69, 0x04, 0x92, 0x84, 0x96, 0x96, 0x22]),
    Buffer.from("__kIMFileTransferGUIDAttributeName"),
    Buffer.from([0x86, 0x92, 0x84, 0x96, 0x96, lengthByte]),
    Buffer.from(guidValue),
    Buffer.from([0x86, 0x92, 0x84, 0x96, 0x96, 0x1d]),
    Buffer.from("__kIMMessagePartAttributeName"),
    Buffer.from([0x86, 0x86, 0x86]),
  ]);
  return head;
}

describe("attachment-only blobs extract no text (TS fallback)", () => {
  it("bare-UUID attachment GUID ('$' length byte) yields undefined", () => {
    const uuid = "82B8D98D-360F-41EE-8841-0215247DFAE9";
    const blob = makeAttachmentOnlyBlob(uuid, 0x24); // '$' = 36
    const out = extractAttributedBodyText(blob);
    expect(out).toBeUndefined();
  });

  it("transfer GUID ('M' length byte, at_… value) yields undefined", () => {
    const value = "at_00000000-1111-2222-3333-4444444444440_AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
    const blob = makeAttachmentOnlyBlob(value, value.length); // 77 = 'M'
    const out = extractAttributedBodyText(blob);
    expect(out).toBeUndefined();
  });

  it("a genuine sentence containing a UUID still extracts", () => {
    // Sanity: the metadata filters must not eat real text.
    const text = "the id is DB19B098-9804-4E16-B3B4-AB3E4F539B6D ok";
    const blob = Buffer.concat([
      Buffer.from([0x04, 0x0b]),
      Buffer.from("streamtyped"),
      Buffer.from([0x81, 0xe8, 0x03, 0x84, 0x01, 0x40, 0x84, 0x84, 0x84, 0x12]),
      Buffer.from("NSAttributedString"),
      Buffer.from([0x00, 0x84, 0x84, 0x08]),
      Buffer.from("NSObject"),
      Buffer.from([0x00, 0x85, 0x92, 0x84, 0x84, 0x84, 0x08]),
      Buffer.from("NSString"),
      Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b, text.length]),
      Buffer.from(text),
      Buffer.from([0x86, 0x84, 0x02]),
    ]);
    expect(extractAttributedBodyText(blob)).toBe(text);
  });
});

describe("structured-parse-first (no byte-scan when NSString parses)", () => {
  it("attribute NAMES never leak either (EmojiImageAttributeName)", () => {
    // Same attachment-only blob shape but the surviving byte-scan candidate
    // would be an attribute name fragment — with structured-first it never runs.
    const blob = makeAttachmentOnlyBlob("82B8D98D-360F-41EE-8841-0215247DFAE9", 0x24);
    const withEmojiAttr = Buffer.concat([
      blob,
      Buffer.from([0x92, 0x84, 0x96, 0x96, 0x1c]),
      Buffer.from("__kIMEmojiImageAttributeName"),
      Buffer.from([0x86, 0x86]),
    ]);
    expect(extractAttributedBodyText(withEmojiAttr)).toBeUndefined();
  });
});

describe("chat-properties snippet fallback", () => {
  it("rejects binary-plist structural noise, keeps real UTF-16 text", async () => {
    const { extractNullPaddedAsciiText } = await import("../src/plist-text.js");
    // "(I_d~" style noise: null-interleaved printable structural bytes.
    const noise = Buffer.from([0, 0x28, 0, 0x49, 0, 0x5f, 0, 0x64, 0, 0x7e]);
    expect(extractNullPaddedAsciiText(noise)).toBeUndefined();
    // Genuine UTF-16BE-ish text survives.
    const real = Buffer.from("hello there mate".split("").flatMap((c) => [0, c.charCodeAt(0)]));
    expect(extractNullPaddedAsciiText(real)).toBe("hello there mate");
  });
});
