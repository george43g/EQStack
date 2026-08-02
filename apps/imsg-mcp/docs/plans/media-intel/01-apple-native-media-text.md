# Stage 1 — Apple-native extraction (biggest free win)

**Branch**: `feat/apple-native-media-text` · **Type**: `feat(db)` · **Depends**: —

**Goal**: surface text Apple already computed. Zero network, zero keys. Three wins:
IMAudioTranscription voice-note transcripts, Genmoji descriptions, and the reply-to-voice-note
kind fix.

## Code anchors

- `src/parsers/typedstream-parser.ts:62` — `TypedStreamParser` class (extend for attribute runs).
- `src/attributed-body-text.ts:114` — `extractAttributedBodyText` (text runs only today).
- `src/imessage-db.ts` ~1844 — `convertMessage`; ~2073 / ~2107 —
  `fetchExtendedMessageData` / `...Batch`; ~1820–1826 — reply-context assembly.
- `src/types.ts` — `Message`, `Attachment`, `ReplyContext` types.
- `src/mcp-format.ts` — `formatMessage` (+ `messageToStructured` in index/format path).
- TUI: `src/tui/components/MessageBubble.tsx:222–227`, `MessageDrawer.tsx:226–228`,
  `ThreadPane.tsx:128`.

## Steps

1. **Typedstream attributes**: extend `TypedStreamParser` to capture attribute-run dictionaries
   (currently only text runs are decoded). Add `extractAudioTranscription(blob): string | null`
   to `src/attributed-body-text.ts` that reads the `IMAudioTranscription` attribute value.
   Keep the existing `extractAttributedBodyText` behavior unchanged (additive only).
2. **DB layer**: SELECT `is_audio_message` in the extended-message fetch
   (`fetchExtendedMessageData`/`Batch`). In `convertMessage`, when the message is audio AND the
   transcription attribute is present, set new `Message.appleAudioTranscript?: string`.
3. **Genmoji**: attachment queries add `emoji_image_short_description` →
   `Attachment.emojiDescription?: string | null` (`src/types.ts`). Render in `formatMessage` +
   structuredContent.
4. **Reply-context kind fix**: in `imessage-db.ts` (~1822–1826), when the original text is NULL,
   look up the original message's attachments → derive
   `replyToKind: "voice-note" | "image" | "video" | "file"` (mime/uti + `is_audio_message`) and
   use its Apple transcript as `replyToText` when available. TUI:
   - `MessageBubble.tsx:222–227` — label by kind (e.g. `↩ voice note: "transcript…"`).
   - `MessageDrawer.tsx:226–228` — replace `"(unknown)"`.
   - `ThreadPane.tsx:128` — GUID→text lookup carries the kind.
   Add `replyToKind` to `ReplyContext` in `src/types.ts`.

## Tests

- Synthesize typedstream blobs carrying the `IMAudioTranscription` attribute (follow existing
  attributed-body fixture patterns in `tests/`). **NEVER commit real blobs.**
- Reply-kind unit tests on a fixture DB (voice-note original → `replyToKind: "voice-note"`,
  transcript surfaced; image original → `"image"`).
- Genmoji: attachment row with `emoji_image_short_description` → `emojiDescription` populated +
  rendered.

## Verification

- Live read-only spot-check (structure/counts only, no content in output): the 102
  `IMAudioTranscription` messages extract non-empty text; the Naomi reply-to-VM example shows
  "voice note" + transcript instead of "(unknown)" / "image/attachment".
- `pnpm lint && pnpm typecheck && pnpm test` green in both engines.

## Verified byte-recipe for `IMAudioTranscription` (content-safe probe, 2026-07-21)

A read-only structural probe of the real DB (102/657 audio blobs carried the marker) confirmed:

- The transcript is **not** captured by `parseAllNSStrings()` — that scans for the literal
  `"NSString"` byte pattern, but the transcript value is a string stored via a typedstream
  **class back-reference** (the class was already defined by the message's `￼` text run), so
  no fresh `"NSString"` literal precedes it. `parseAllNSStrings()` returns only the 1-char
  `￼` for these messages — that's why the current extractor yields 0 transcript chars.
- The reliable anchor is the literal ASCII **`IMAudioTranscription`** in the blob (in the probe
  it sat at a stable offset, but do not hardcode the offset — `blob.indexOf` it).
- **Framing after the marker** (identical across all sampled blobs):
  `86 92 84 96 96` (5 bytes) → length → UTF-8 transcript bytes.
  - length byte `0x81` → next 2 bytes are the length as **uint16 LE** (covers the long
    transcripts; e.g. 967, 407, 1204 chars observed).
  - length byte `< 0x81` → that single byte IS the length.
  - defensively handle `0x82` → uint32 LE for very long transcripts even if unseen.

**Recommended `extractAudioTranscription(blob)`:**
1. `const off = blob.indexOf(Buffer.from("IMAudioTranscription","ascii"))`; return null if -1.
2. Start at `off + "IMAudioTranscription".length`. Consume the `86 92 84 96 96` framing (validate
   it's present; if the framing bytes differ across macOS versions, scan a small window for the
   first length marker as a fallback and log a warn).
3. Decode the length (rules above), read that many bytes, `toString("utf8")`, trim.
4. Guard: reject if the decoded string is empty or fails a basic sanity check (mostly control
   bytes). Return the transcript otherwise.

Prefer this targeted anchor-based extractor over a full typedstream attribute-run rewrite for
Stage 1 — it's smaller, testable with synthetic blobs, and doesn't risk regressing the existing
text-run path. (A fuller attribute-run parser can come later if more attributes are needed.)

## Notes for the worker

- This stage is pure Apple-native extraction — no provider/AI code, no config. Keep it that way;
  the AI fallback for the ~556 non-synced audio messages arrives in Stage 2/4.
- The typedstream attribute decode is the one genuinely tricky bit — use the verified recipe
  above; regression-test the existing `extractAttributedBodyText` text-run path stays unchanged.
- **Privacy**: synthesize fixture blobs (marker + framing + fake ASCII transcript) — NEVER commit
  or echo a real transcript. Live verification reports counts/non-empty only, never content.
