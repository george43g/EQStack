# Stage 7 — attachment sync nudge

**Branch**: `feat/attachment-sync-nudge` · **Type**: `feat` · **Depends**: — (parallel)

**Goal**: nudge Messages.app to download an undownloaded attachment (transfer_state -1) before we
try to interpret/open/export it. Best-effort, tiered.

## `src/attachment-sync.ts`

`ensureAttachmentDownloaded(att, chatId, opts): Promise<boolean>`:

- **T1 (default)**: AppleScript activate Messages + open the chat (`imessage://` URL — **exact
  URL format needs a SUPERVISED live test; it launches the real app**) → poll `existsSync` to a
  timeout (default 30s). Opening a conversation is community-verified to pull its attachments.
- **T2 (config `nudge.tier2SyncNow`, default off)**: System Events click Messages ▸ Settings ▸
  iMessage ▸ **Sync Now**. Detect missing **Accessibility permission** → return an actionable
  hint (new permission class to document in README).
- **T3**: per-convo download-all UI script — **documented in STATUS only**, no code (fragile
  across macOS versions).

## Wiring

- `get_attachment`, TUI open/save, export `--include-attachments` call
  `ensureAttachmentDownloaded` first when the file is missing / `transfer_state === -1`.
- Respect `nudge.enabled`; skip entirely when off.

## Tests

- All AppleScript mocked under Vitest (`VITEST=true` pattern in `src/applescript.ts`) — **no real
  app launch in CI**.
- T1 poll logic: file appears → resolves true; timeout → resolves false.
- T2 gated by config + missing-permission hint path.

## Verification

- `pnpm lint && pnpm typecheck && pnpm test` green, both engines.
- **Supervised live test with the user present**: the `imessage://` open URL actually launches
  Messages + opens the right chat, and a known-undownloaded attachment appears within the
  timeout. Confirm the exact URL scheme here — do NOT ship an unverified URL format.

## Notes for the worker

- This is the one stage that touches the real app in a way tests can't fully cover. Land the
  mocked code + tests, but flag the `imessage://` URL as **needs-supervised-verification** in the
  PR description and get the user to run the live check before relying on it.
- Parallel-safe: doesn't depend on the media-intel service, only wires into the same call sites.
