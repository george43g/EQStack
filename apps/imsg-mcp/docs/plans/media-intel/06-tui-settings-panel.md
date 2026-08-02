# Stage 6 — TUI settings panel

**Branch**: `feat/tui-settings-panel` · **Type**: `feat(tui)` · **Depends**: Stage 3

**Goal**: a TUI settings mode to view/edit the interpret config without leaving the app.

## Behavior

- New Mode `"settings"`, opened via the `Ctrl-P` palette + a keybinding (`,`).
- View/edit:
  - Chains (reorder audio/image/video precedence).
  - Toggles (auto mode, inline transcripts, export threshold, nudge tiers).
  - Provider list (enabled + key-present indicator — **NO key entry in the TUI**; wizard/file
    only).
- Writes via `app-config` (Stage 3).

## Input-guard law (load-bearing)

The TUI has one top-level `useInput`; every modal mode MUST have its own guard block that
early-returns, or browse-mode keys (most dangerously `q` = quit) leak in. The settings mode needs
a dedicated early-return guard: `q` closes the panel, not the app.

## Code anchors / patterns

- Mode + guard pattern: the info drawer (`InfoDrawer.tsx` + the `"info"` Mode guard in
  `App.tsx`).
- HelpBar entry for the new key.
- `@inkjs/ui` is available for settings inputs (select, toggle).

## Tests

- Render test (patterns: `tests/info-drawer.test.tsx`).
- Wiring source-assertion (patterns: `tests/tui-info-drawer-wiring.test.ts`): the `,` key opens
  settings; the settings mode has a dedicated guard; `q`/`Esc` closes it; it renders.
- Config-write round-trip via `app-config`.

## Verification

- `pnpm lint && pnpm typecheck && pnpm test` green, both engines.
- Live fixtures TUI: open settings, reorder a chain, toggle a flag, confirm it persists to the
  config file and `q` closes the panel (not the app).

## Notes for the worker

- Read-heavy panel: it shows provider key **presence** (a check), never the key value. Editing
  keys stays in the wizard/file to avoid TUI secret handling.
