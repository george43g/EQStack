# Media-Intel cycle — overview & worker handoff

_This directory is the **tracked** worker handoff for the Media-Intel cycle. Each `NN-*.md`
file is one stage = one branch + one PR. A worker agent reads its stage file (plus this overview
and the research memo) and implements it end-to-end. Everything needed — decisions, verified DB
facts, code anchors, endpoint notes — lives here so the work survives a context compaction._

Source of truth for research facts: `docs/plans/media-intel/RESEARCH.md` (mirrors the memory
file `project_media_interpretation_research.md`).

## Goal

imsg-mcp v1.8.0 renders rich media shallowly: voice notes are "metadata + maybe a local
transcript", images are visible only to vision-capable MCP hosts, videos are a poster frame,
and Genmoji / reply-context / edit-history data already sitting in `chat.db` goes unused. This
cycle makes the tool **understand** media:

1. Extract everything Apple already computed for free (voice-note transcripts, Genmoji
   descriptions, edit history) straight out of `chat.db`.
2. Add a provider-agnostic **AI interpretation layer** (transcription + vision) with **permanent
   caching** — the same media is never interpreted twice.
3. Expose it uniformly across **MCP / CLI / console / TUI** (surfacing on, toggleable).
4. Give users an **`imsg setup` inquirer wizard** + **TUI settings panel** to configure it.

**Architecture rule (load-bearing): all processing lives in core (`src/`), frontends only
render.** A future web UI must port trivially — no `fetch`/`spawn` in TUI components.

## Locked user decisions (2026-07-21 — do NOT re-litigate)

1. **Wizard**: `inquirer` (new dep; user's explicit choice).
2. **Scope**: everything in one cycle — Apple transcripts + Genmoji + image/video AI description
   + wizard + TUI settings + sync nudge + edit-history drawer + reply-context fix.
3. **Providers**: OpenAI-compatible client with **multiple named provider profiles**. Presets:
   `openai`, `groq`, `openrouter` (user has keys, PREFERRED), `cloudflare` (user has keys),
   `huggingface` (user has account), `ollama` (local, no key), plus custom base URL. Users
   configure one or many, then set a **priority/precedence chain per media type**.
4. **Free-first**: Apple synced transcript → free local brew tools (`hear`/`yap`/`whisper-cli`,
   already in `src/media.ts`) → configured cloud. Default chains are free-first; user reorders.
5. **Triggers**: **lazy-auto + export guard** — any touch (TUI view, `get_attachment`, export)
   walks the full chain incl. cloud; results cached forever. Bulk exports confirm when >N
   uncached cloud calls (default 25, configurable).
6. **Surfacing**: **everywhere, toggleable (default on)** — TUI bubble 🎤 "transcript…", MCP
   `get_messages` text `[voice note: "…"]`, exports embed transcripts/captions,
   `structuredContent` carries fields. Nuance: `get_messages` inlines only cached/instant
   results (never blocks a read on a cloud call); interpretation is *triggered* by
   `get_attachment` / TUI-view / export.
7. **Video**: cost-minimal — sparse, compressed frames (poster is zero-dep; extra sparse frames
   only if `ffmpeg` happens to be on PATH) + audio-track transcript. Goal = rough tag/caption +
   what was said, NOT frame-by-frame analysis.
8. **Sync nudge**: best-effort — T1 open-chat+poll (default), T2 UI-scripted "Sync Now" (opt-in,
   needs Accessibility). T3 (per-convo download-all UI script) documented only.
9. **SIP private-API route**: **time-boxed spike** (research + go/no-go doc, no product code).
10. **Config surfaces**: config file (source of truth) + inquirer wizard + TUI settings panel.
    No granular CLI setters (`imsg config show/edit` already exists).

## Architecture

```
                 ┌──────────────── core (src/) ────────────────┐
chat.db ──► imessage-db ──► media-intel service ──► media-intel cache (~/.imsg-mcp/media-intel.db)
                 │               │  chains: audio/image/video: [apple|local|provider:*]
                 │               │  providers: OpenAI-compatible client (2 shapes):
                 │               │    /audio/transcriptions multipart · /chat/completions multimodal
                 │               └─ concurrency limiter, in-flight dedupe, retry
                 ▼
   app-config (config.json + credentials.json 0600) ◄── inquirer wizard · TUI settings panel
                 │
   ┌─────────────┼──────────────┬───────────────┐
   MCP tools     CLI/console    TUI (render-only)  [future web server]
```

New core modules: `src/media-intel.ts` (service), `src/media-intel-cache.ts` (SQLite),
`src/media-providers.ts` (client + presets), `src/app-config.ts` (absorbs & extends
`tui-config.ts`), `src/attachment-sync.ts` (nudge), `src/edit-history.ts`.

## Stage roadmap

| # | Branch | Type | Content | Depends |
|---|--------|------|---------|---------|
| 0 | `docs/media-intel-plan` | docs | Materialize this directory | — |
| 1 | `feat/apple-native-media-text` | feat(db) | IMAudioTranscription + Genmoji + reply-context kind fix | — |
| 2 | `feat/media-intel-core` | feat(core) | Interpretation service + cache + providers + video pipeline | 1 |
| 3 | `feat/setup-wizard` | feat(cli) | app-config + credentials + inquirer wizard | 2 |
| 4 | `feat/media-intel-surfaces` | feat | MCP/TUI/export/CLI surfacing + TUI VM UX | 2,3 |
| 5 | `feat/edit-history` | feat(db+tui) | message_summary_info edit-history + drawer timeline | — (parallel) |
| 6 | `feat/tui-settings-panel` | feat(tui) | Settings mode: chains/toggles/providers view | 3 |
| 7 | `feat/attachment-sync-nudge` | feat | T1 open-chat+poll · T2 Sync Now (opt-in) · T3 documented | — (parallel) |
| 8 | `docs/sip-private-api-spike` | docs | Time-boxed spike findings + go/no-go | — (parallel) |
| 9 | `docs/media-intel-docs` | docs | README/TOOLS/AGENTS/SKILL/STATUS refresh | all |

**Workflow per stage:** branch → implement (TDD where sensible) → foreground
`pnpm lint && pnpm typecheck && pnpm test` (+ `pnpm test:no-native` where relevant) → push →
PR → CI `build-test` green → merge (**not** squash) via REST API (`$GH_TOKEN` + curl) if `gh`
keychain is flaky → **wait for the release run** before merging the next `feat:` PR
(semantic-release serialization). 1Password unlock needed per commit; **never** skip signing.

## Standing constraints (project rules)

No autonomous message sends. Real personal data never committed; **never echo message/transcript
content** into command output or docs. Test the TUI against `fixtures/chat.db` (+ fresh
`VITE_SLUGS_DB_PATH`), never the real DB. Foreground tests only. Don't touch `engines.npm`.
Don't run `sync-env-data`. Never `git add -A` (`.codex/`, `docs/research/*`,
`.claude/settings.local.json` stay untracked). Merge (not squash); `feat:` releases sequentially.
`docs/plans/media-intel/` IS tracked (it's the worker handoff).
