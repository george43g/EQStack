# Stage 9 — docs refresh

**Branch**: `docs/media-intel-docs` · **Type**: `docs` · **Depends**: all prior stages

**Goal**: fold the shipped cycle into user + agent docs.

## Files to update

- **README.md**: the `imsg setup` wizard; providers (openrouter/cloudflare/hf/ollama + custom);
  `brew install` one-liners; the **new opt-in Accessibility permission** for the T2 Sync Now
  nudge; cost/privacy notes (audio/images leave the device ONLY per config, never by default).
- **TOOLS.md** (or the tools section): new args/fields —
  `get_attachment.interpret`, `export_messages.interpret`, `imsg interpret`, `get_messages`
  inline `[voice note: …]`, `Message.appleAudioTranscript` / `editHistory`,
  `Attachment.emojiDescription`, `ReplyContext.replyToKind`.
- **AGENTS.md / CLAUDE.md conventions**: media-intel service + app-config conventions; the
  "all processing in core, frontends render" rule; new module map.
- **skills/imsg-mcp/SKILL.md**: agent handoff additions.
- **docs/STATUS.md**: record the cycle as shipped; move T3 bulk-sync + SIP go/no-go into the
  backlog with their outcomes.

## Verification

- No stale references; every new flag/field/key documented.
- `pnpm lint` (Biome also lints docs fences where configured) — mainly a manual read-through.

## Notes for the worker

- This is the closeout. Ensure the STATUS.md "Where things stand" line and the release table
  reflect the new minor version(s). Keep the memory files
  (`project_session_handoff.md`, `project_media_interpretation_research.md`) updated too —
  mark the cycle complete.
