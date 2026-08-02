# Stage 4 — surfacing everywhere

**Branch**: `feat/media-intel-surfaces` · **Type**: `feat` · **Depends**: Stages 2, 3

**Goal**: route every frontend through the media-intel service. Surfacing on, toggleable. TUI
gains the voice-note UX (transcript / loading / retry / listen). **Frontends stay render-only** —
all `fetch`/`spawn` stays in core.

## MCP (`src/index.ts`, `src/mcp-schemas.ts`, `src/mcp-format.ts`)

- `get_attachment` (~`src/index.ts:1739`) routes through media-intel instead of calling
  `transcribeAudioBest` directly; add `interpret?: boolean` override; keep `transcriptSource`.
- `get_messages` inlines `[voice note: "…"]` for **cached/instant** results only (policy: never
  block a read on a cloud call) via `formatMessage` / `messageToStructured`.
- `export_messages` gains `interpret` + guard args.
- Schemas updated in `src/mcp-schemas.ts`.

## Export (`src/exportStream.ts:73`, `src/export-formats.ts`)

- Pre-pass per page collects uncached media → guard prompt in CLI context when count > threshold
  (`--yes` to skip; MCP arg equivalent) → interpret with the limiter → transcripts/captions
  embedded in `md` / `csv` / `json` / `ndjson`.

## TUI (render-only; state via hooks, no fetch/spawn in components)

- Bubble: 🎤 + transcript / "⏳ transcribing…" / "(uninterpreted — R to run)" states.
- Drawer: full text + source + `R` retry.
- Visible-VM debounced interpret trigger honoring auto mode.
- InfoDrawer rows show interpretation status.
- Verify `o` QuickLook plays audio (qlmanage does) for voice notes / rich media.
- Add `f` reveal-in-Finder (`open -R`) in the message drawer + info drawer.
- **Input-guard law**: every new key handled inside its mode's guard block (retry `R`, reveal
  `f`) — no leaks into browse mode.

## CLI / console

- Shared formatter output flows automatically.
- Add `imsg interpret <attachment-rowId> [--force]` scriptable command.

## Tests

- Formatter snapshots (`[voice note: "…"]` inline; cached-only for get_messages).
- Export-with-interpret fixture run (fake provider, no network).
- TUI render states (transcript / loading / uninterpreted).
- Wiring source-assertions (input-guard law: new keys handled inside mode guards) — pattern:
  `tests/tui-info-drawer-wiring.test.ts`.

## Verification

- `pnpm lint && pnpm typecheck && pnpm test` green, both engines.
- Live fixtures TUI: a voice note shows loading → transcript; `R` retries; `o` plays audio;
  `f` reveals in Finder. (fixtures only — never the real DB.)
- One supervised live cloud smoke with the user's OpenRouter key AFTER the wizard ships (user
  present, tiny file) — NOT in CI.

## Notes for the worker

- The policy nuance matters: `get_messages` must never block on cloud. It shows cached/instant
  (apple/local) results inline; cloud interpretation is *triggered* by `get_attachment`, a TUI
  view, or export — and cached forever after.
- This is the largest surface-area PR. Consider landing MCP + export first, TUI second within the
  same branch if the diff gets unwieldy, but keep it one PR (one `feat` release).
