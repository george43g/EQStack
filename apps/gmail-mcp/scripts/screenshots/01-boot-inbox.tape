# Boot → fixture-mode inbox.
# Output: docs/screenshots/01-boot-inbox.png
# Regenerate: `pnpm screenshots` (from repo root)

Output docs/screenshots/01-boot-inbox.png

Set FontFamily "JetBrains Mono"
Set FontSize 14
Set Width 1400
Set Height 800
Set Padding 20
Set TypingSpeed 60ms

# We do NOT use Hide/Show — VHS's Hide stops frame recording, which would
# yield a blank screenshot when `Screenshot` fires inside the hidden window.
# Leaving the launch command visible is fine; the screenshot fires after the
# steady state is reached, and the typed command scrolls out of frame inside
# the alt-screen TUI.
Type "GMAIL_FIXTURE_MODE=1 GMAIL_FIXTURE_DIR=./fixtures/gmail GMAIL_ACCOUNT=work node dist/cli/index.js tui"
Enter
Sleep 3s

Screenshot docs/screenshots/01-boot-inbox.png

# Clean exit so VHS doesn't hang waiting for the tape to time out.
Type "Q"
Sleep 200ms
