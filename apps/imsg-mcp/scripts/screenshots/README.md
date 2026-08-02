# Screenshots

Auto-generated demo PNGs and GIFs of the CLI/TUI, produced by
[`charmbracelet/vhs`](https://github.com/charmbracelet/vhs).

## Prerequisites

```bash
brew install vhs
brew install --cask font-jetbrains-mono   # vhs reads system fonts; without this the PNGs render garbled
```

(Linux: see the vhs README — there's a `.deb`, `.rpm`, and a static binary. JetBrains Mono is available as a font package in most distros.)

## Regenerate

```bash
pnpm fixtures           # synthetic data — vhs runs the TUI against this
pnpm build              # vhs runs the built dist/cli.js, not the TS source
pnpm screenshots        # writes docs/screenshots/*.png
```

Each `.tape` file in this directory drives one scene. Edit the tape, re-run,
and commit the resulting PNG. Most tapes are 5–10 seconds of recording.

## Drift check (optional CI)

```bash
pnpm screenshots:check  # regenerate, then `git diff --exit-code docs/screenshots/`
```

Fails if any committed screenshot doesn't match what `vhs` produces today —
indicating the UI changed and the docs need a refresh.

## Why CLI screenshots aren't included

Earlier `cli-doctor.tape` / `cli-setup.tape` scenes were dropped because
the rendered output included absolute paths under `/Users/<your-name>/`
even when pointed at the synthetic fixture (resolved via `process.cwd()`).
We can't ship a public README image that leaks a contributor's home dir.
Re-introducing those scenes is a v1.x follow-up — the fix is to either
elide the cwd in `doctor`/`setup` output or run vhs from a `/tmp/demo`
working directory.

## Why VHS

VHS is the only tool we found in 2026 that produces both static PNGs (via
`Screenshot foo.png`) **and** animated GIFs/MP4s from one declarative `.tape`
script, runs fully headless, and is the de facto standard in the
TUI-publishing world (Charm, BubbleTea, lazygit, etc).

If you're hacking on the screenshots: see `vhs --help` and the tape syntax
reference at <https://github.com/charmbracelet/vhs#vhs-command-reference>.
