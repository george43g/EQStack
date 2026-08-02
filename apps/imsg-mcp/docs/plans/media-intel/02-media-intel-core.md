# Stage 2 — media-intel core

**Branch**: `feat/media-intel-core` · **Type**: `feat(core)` · **Depends**: Stage 1

**Goal**: one service, per-media-type chains, permanent cache. **No frontend code.** Everything
here is importable by MCP / CLI / TUI / a future web server without pulling in any UI.

## New modules

### `src/media-providers.ts` — client + presets

- Presets table (base URLs in `RESEARCH.md §8`): openai, groq, openrouter, cloudflare (asks
  account id), huggingface, ollama, + custom base URL.
- `ProviderClient` with two invocation shapes — generalize `transcribeAudioCloud`
  (`src/media.ts` ~:233, keep its injectable `fetchImpl` + timeout pattern) into:
  - `transcriptions(file): Promise<string>` — multipart `POST /audio/transcriptions`.
  - `chatMultimodal({ text, images?: Buffer[], audio?: Buffer }): Promise<string>` — base64
    `image_url` / `input_audio` content parts on `POST /chat/completions`.
- Compress images before send (`sips` downscale ≤768px, JPEG) to keep cost/latency low.
- Capability map (verify at impl): `/audio/transcriptions` = openai, groq, cloudflare;
  chat-multimodal vision = all; chat `input_audio` = openrouter (audio models), openai; ollama =
  vision-via-chat only (llava/qwen-vl), no transcriptions.

### `src/media-intel-cache.ts` — SQLite `~/.imsg-mcp/media-intel.db`

- Table `media_intel(attachment_guid PK, kind, status 'done'|'failed', text, extra_json, source,
  model, file_sig, dur_ms, error, created_at)`. Mirror `src/analytics-cache.ts` patterns
  (open/migrate/get/put).
- `file_sig` = size+mtime (or hash) of the on-disk attachment — invalidate if the file changes.
- In-flight dedupe = in-memory `Map<guid, Promise>`. `retry(guid)` deletes the row + reruns.

### `src/media-intel.ts` — the service

- `interpretAttachment(att, ctx): Promise<InterpretResult>` walks the configured chain for the
  media type:
  - `apple` → `Message.appleAudioTranscript` (instant, from Stage 1).
  - `local` → existing `TRANSCRIBERS` (`src/media.ts:167` — hear/yap/whisper-cli).
  - `provider:<name>` → `ProviderClient` (transcribe or vision by kind).
- Returns `{ text, source, model?, cached }` | `{ status: "pending" }` | failure record.
- Concurrency limiter (default 3), `AbortSignal` support.
- `countUncachedCloud(atts): number` for the export guard (Stage 4).
- Auto-mode gate from config: `"all"` (any chain incl. cloud) / `"free"` (apple+local only) /
  `"off"` (no auto interpretation; explicit calls only).

### Video pipeline (inside the service)

- Poster via `videoPosterFrame` (`src/media.ts:94`).
- IF `ffmpeg` on PATH: sample sparse frames at 25/50/75% (downscaled/compressed) —
  optional-brew-tool pattern like mpv. Otherwise poster only.
- Audio track via `avconvert -p PresetAppleM4A <in> <tmp.m4a>` (macOS built-in) → audio chain.
- ONE cached record with `extra_json = { description, transcript }`. Goal = rough tag/caption +
  what was said, not frame-by-frame.

## Tests

- Injected `fetch` fakes per provider shape (pattern: `tests/cloud-transcription.test.ts` — no
  network ever).
- Chain-order fallback (apple miss → local miss → provider hit).
- Cache: hit path, never-interpret-twice, `retry()` clears + reruns.
- Auto-mode gating (`all`/`free`/`off`).
- Video pipeline with stubbed exec (poster + optional frames + audio-track transcript merged
  into one record).

## Verification

- `pnpm lint && pnpm typecheck && pnpm test` green, both engines.
- Cache invariant proven by test: interpret twice → second call is `cached: true`.
- Cloud paths never touch the network in Vitest (injected fetch).

## Notes for the worker

- **Do not** wire this into any frontend here — that's Stage 4. This PR should add the service +
  cache + providers + tests, importable but not yet surfaced. Keeps the diff reviewable and the
  release atomic.
- Reuse `src/media.ts` helpers (sips/qlmanage/mdls/avconvert already there) — don't add new deps
  beyond what a provider client needs (native `fetch` is fine on Node 24).
