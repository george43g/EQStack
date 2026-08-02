# Stage 3 — app-config + credentials + inquirer wizard

**Branch**: `feat/setup-wizard` · **Type**: `feat(cli)` · **Depends**: Stage 2

**Goal**: config file is the source of truth; `imsg setup` gains an interactive inquirer flow to
build it. New dep: `inquirer`.

## `src/app-config.ts`

Absorb `src/tui-config.ts` (same file + resolution order; keep `tui-config.ts` re-exporting for
back-compat). Widen the Zod schema with the `interpret` block:

```jsonc
{
  "theme": "safe", "accentColor": "#1982FC",           // existing flat TUI keys stay (back-compat)
  "interpret": {
    "auto": "all",                                      // "all" | "free" | "off"
    "inlineTranscripts": true,
    "exportConfirmThreshold": 25,
    "chains": {
      "audio": ["apple", "local", "provider:openrouter"],
      "image": ["provider:openrouter"],
      "video": ["provider:openrouter"]
    },
    "providers": [
      { "name": "openrouter", "preset": "openrouter",
        "models": { "transcribe": "openai/gpt-4o-mini-audio-preview", "vision": "..." } },
      { "name": "ollama", "preset": "ollama" }
    ],
    "nudge": { "enabled": true, "tier2SyncNow": false, "timeoutSeconds": 30 }
  }
}
```

- Credentials live in `~/.imsg-mcp/credentials.json` (chmod 600):
  `{ "<providerName>": "sk-…" }`. Read/write helpers enforce 0600.
- Env `IMSG_TRANSCRIBE_PROVIDER` / `_API_KEY` / `_MODEL` still honored — mapped to an implicit
  provider (back-compat with the shipped v1.7.0 cloud-transcription path).

## `imsg setup` interactive flow

Keep the existing non-interactive `--write claude|cursor` path (`src/cli.ts:840` →
`src/setup.ts`; existing fns: `probeMachine:66`, `buildMcpServerEntry:96`, `buildMcpSnippet:130`,
`getHostConfigPath:144`, `writeHostConfig:163`). Add an interactive inquirer flow:

1. **Doctor probe**: FDA, `chat.db` reachable, which local tools are found — offer `brew install`
   one-liners for `hear` / `yap` / `whisper-cli` / optional `ffmpeg` / `mpv`.
2. **Add/edit providers**: preset select or custom URL; masked key paste; cloudflare asks account
   id; optional live validation ping.
3. **Per-media-type chain ordering** (ordered select for audio/image/video).
4. **Toggles**: auto mode (explain cost/privacy), inline transcripts, export threshold, nudge
   tiers.
5. **Write** config + credentials + a summary of what was saved.

## Tests

- Config schema round-trip (parse → serialize → parse).
- Credentials file perms = 0600 after write.
- **Extract wizard logic into pure question-plan / apply functions** so they test WITHOUT a TTY
  (inquirer mocked). The interactive prompt loop is a thin shell over pure functions.

## Verification

- `pnpm lint && pnpm typecheck && pnpm test` green, both engines.
- Manual: `imsg setup` runs the interactive flow, writes a valid config the Zod schema accepts.
- Existing non-interactive `imsg setup --write …` path unchanged (regression test).

## Notes for the worker

- Reuse the existing config resolution in `tui-config.ts` — do not invent a second resolution
  order. `app-config.ts` becomes the canonical module; `tui-config.ts` re-exports.
- No key entry in the TUI (Stage 6) — keys only via wizard or the file. This stage owns the key
  I/O.
