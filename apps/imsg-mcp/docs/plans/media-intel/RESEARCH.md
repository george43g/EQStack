# Media-Intel — verified research facts

_All DB probes were read-only against the real `~/Library/Messages/chat.db`, structure/counts
only (no message or transcript content echoed). Verified 2026-07-21._

## 1. Voice-note transcripts — accessible, free, local

iPhone-generated voice-note transcripts sync into `chat.db` as a **typedstream ATTRIBUTE** keyed
**`IMAudioTranscription`** inside `message.attributedBody` (verified by identifier-scan of
received-audio blobs). Coverage on the real DB: **102 of 658** audio messages (46 received + 56
sent; iOS 17+-era only — old `.caf` voice notes predate it).

`extractAttributedBodyText` (`src/attributed-body-text.ts:114`) currently extracts only the text
run (the object-replacement char for audio) and **drops the attribute dictionaries** → returns 0
chars for these. Work = extend the typedstream parse to capture attribute runs.

Fallback chain for the other ~556 (no synced transcript): existing local transcribers → opt-in
cloud (`IMSG_TRANSCRIBE_*` / configured providers).

## 2. Other free wins in the schema

- `attachment.emoji_image_short_description` — **Genmoji carry Apple-authored text
  descriptions** (107 rows on the real DB).
- Also present: `emoji_image_content_identifier`, `preview_generation_state`,
  `is_commsafety_sensitive`, `message.schedule_type` / `message.schedule_state`.

## 3. iCloud attachment download state (real DB)

`attachment.transfer_state`: 5 (done) = 14,639 · **-1 = 1,823 (undownloaded/purged)** · 0 = 104 ·
6 = 51. Only 5 of the 200 most-recent are missing on disk → the gaps are mostly OLD media.

## 4. Sync-nudge research

No public download API exists. `IMTransferAgent` is a private SIP'd daemon; `brctl` is
iCloud-Drive-only — both ruled out. Messages syncs only while **open**; opening a conversation
pulls its attachments.

- **T1 (default)**: AppleScript-activate Messages.app + open the specific chat (`imessage://` URL)
  + poll for the file with a timeout. `imessage://` open needs a **supervised live test** during
  implementation (it launches the real app).
- **T2 (escalation, opt-in)**: UI-script Messages ▸ Settings ▸ iMessage ▸ **"Sync Now"** via
  System Events — requires the **Accessibility permission** (new permission class to document).
- **T3 (researched, fragile, docs-only)**: conversation-info pane has a per-thread
  download-all-attachments affordance — UI-scriptable but brittle across macOS versions.

## 5. Edit history

Lives in `message.message_summary_info` (a bplist). Key **`"ec"`** maps message-part index →
array of prior versions, each with `"t"` (typedstream attributedBody) + `"d"` (date, Mac epoch);
retracted parts under **`"rp"`**. Reference implementation: ReagentX/imessage-exporter
(`edited.rs`). Real DB has ~502 edited messages; the user's known example is in the Naomi thread.

## 6. Reply-to-VM bug root cause

`imessage-db.ts` (~line 1820–1826) sets `replyTo.replyToText = originalText`; a voice-note
original has NULL text → TUI `MessageDrawer.tsx:228` shows "(unknown)" and
`MessageBubble.tsx:222–227` falls back to a generic "image/attachment" label. `ThreadPane.tsx:128`
builds a GUID→text lookup that also lacks attachment-kind awareness.

## 7. Current media surface (what already works)

images → MCP image block (≤1536px, HEIC→PNG, base64 ≤5MB); video → QuickLook poster + `mdls`;
audio → `mdls` + local/cloud transcript; tapbacks incl. iOS18 custom emoji parsed; link previews
via `message_summary_info`. **Gaps**: IMAudioTranscription not read, Genmoji descriptions not
surfaced, no AI image/video description.

## 8. Provider endpoint notes (verify at implementation)

Two OpenAI-compatible shapes:
- **`POST /audio/transcriptions`** (multipart) — openai, groq (`whisper-large-v3`), cloudflare
  (`@cf/openai/whisper`). NOT ollama.
- **`POST /chat/completions`** multimodal — vision via base64 `image_url` content parts (all
  providers incl. ollama with llava/qwen-vl); audio via `input_audio` content parts (openrouter
  audio-capable models, openai).

Preset base URLs: openai `https://api.openai.com/v1` · groq `https://api.groq.com/openai/v1` ·
openrouter `https://openrouter.ai/api/v1` · ollama `http://localhost:11434/v1` · cloudflare
`https://api.cloudflare.com/client/v4/accounts/{id}/ai/v1` (needs account id — wizard asks) ·
huggingface `https://router.huggingface.co/v1`.

## 9. Config landscape

`imsg setup` exists (`src/setup.ts`, non-interactive). Config resolution (`src/tui-config.ts`):
`$XDG_CONFIG_HOME/imsg-mcp/config.json` → `$HOME/.config/imsg-mcp/config.json` →
`$HOME/.imsg-mcp/config.json` (writes the XDG path). Data dir `~/.imsg-mcp/` holds `slugs.db`,
`analytics-cache.db`. Credentials candidate: `~/.imsg-mcp/credentials.json` chmod 600. OAuth is
NOT applicable to transcription/vision providers → wizard = questions + masked key paste.

## Prior-art repos

- ReagentX/imessage-exporter — edit history, transcripts, attachment download FAQ.
- BlueBubblesApp/bluebubbles-server — Private API (dylib injection into Messages → IMCore).
- sveinbjornt/hear, finnvoor/yap — local transcribers.
