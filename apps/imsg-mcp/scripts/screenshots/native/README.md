# Native macOS screenshots

These captures use `screencapture` against real macOS app windows — Quick Look, Messages.app, WhatsApp, etc. They **cannot** run in CI because they need a real WindowServer.

## Run

```bash
pnpm screenshots:native
```

Each `*.sh` runs sequentially. Output lands in `docs/screenshots/native/`.

## Permissions

The first run will prompt for:

- **Screen Recording** — required for `screencapture -w` / `screencapture -W`
- **Automation** — required for `osascript` to control specific apps

Grant these to the terminal/IDE running the script (not to imsg-mcp itself).

## When to refresh

Rarely. Refresh when:

- macOS major version changes the Quick Look or window chrome
- A third-party app (WhatsApp, Signal, Telegram) changes its launch UI
- You change which apps imsg-mcp targets via URL schemes

## Adding a capture

1. Add `your-capture.sh` to this directory. Make it executable: `chmod +x your-capture.sh`.
2. Top-of-file comment documents the permission needed + what's captured.
3. `set -euo pipefail` at the top, `screencapture` writes to `docs/screenshots/native/<name>.png`.
4. The script should clean up after itself (kill `qlmanage`, close opened apps, etc).
5. Add a row to `docs/SCREENSHOTS.md` so the new PNG appears in the gallery.
