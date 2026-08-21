# `gmail tui` screenshots

VHS-driven screenshots for the README + `docs/SCREENSHOTS.md` gallery. Every
tape boots `gmail tui` in fixture mode against the committed corpus, so the
outputs are deterministic and never touch real Gmail.

## Local regeneration

```sh
# One-time deps (macOS):
brew install vhs ttyd ffmpeg
brew install --cask font-jetbrains-mono

# Regenerate all tapes:
pnpm screenshots

# Or a single tape:
vhs scripts/screenshots/01-boot-inbox.tape
```

## Convention

- Filenames are number-prefixed (`01-…`, `02-…`) so `docs/screenshots/` orders
  match the gallery doc order.
- Every tape repeats the same `Set` block (font, size, theme, padding) so each
  is standalone — VHS has no include directive.
- Output paths are **repo-root-relative** (e.g. `Output docs/screenshots/01-boot-inbox.png`),
  not tape-relative. `pnpm screenshots` runs `vhs` from the repo root.
- Bootstrap env always sets `GMAIL_FIXTURE_MODE=1 GMAIL_FIXTURE_DIR=./fixtures/gmail
  GMAIL_ACCOUNT=work`. For the `nodist/cli/index.js tui` invocation the build
  must be fresh — `pnpm build` before running tapes.
- Use `Hide` / `Show` around the bootstrap command so the screenshot only
  captures the steady-state TUI, not the user typing the launcher.
- Prefer `Wait /pattern/` over `Sleep` once the tape stabilises — sleeps are
  brittle on slower CI runners; waits block on actual rendered text.

## Pinning

VHS version is pinned in `.github/workflows/screenshots.yml` (env
`VHS_VERSION`). Bump local + workflow in lockstep. Today: VHS **0.11.0**.

## Adding a new tape

1. Pick the next prefix number.
2. Copy `01-boot-inbox.tape` as a skeleton.
3. Add the keystroke sequence between `Show` and the final `Screenshot`.
4. `vhs scripts/screenshots/NN-thing.tape` → confirm the PNG looks right.
5. `pnpm screenshots:check` should be clean (no drift in other tapes).
6. Reference the new image from `docs/SCREENSHOTS.md` and (optionally) the
   top-level `README.md`.

## Debugging a tape

- Add `Sleep 5s` near the start, run the tape interactively, watch what
  happens. Remove the long sleep once stable.
- VHS prints the rendered frames to stderr while recording — pipe to a
  file (`vhs ... 2> /tmp/vhs.log`) for inspection.
- If a sequence is timing-sensitive, replace `Sleep` with `Wait /Inbox/`
  (or whatever text confirms the state you want).
- On CI the runner is slower than local — bump waits up rather than down
  when in doubt.
