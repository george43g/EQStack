# Dev stats overlay — `:stats` toggles a 40-col panel with live heap/RSS/p99.
# Output: docs/screenshots/06-dev-stats.png
#
# We use the `:stats` ex-command rather than the `~` shortcut because some
# terminal emulators (ttyd-via-VHS included) don't deliver bare `~` reliably
# to Ink's input handler. The result is identical — both paths dispatch
# TOGGLE_STATS — but `:stats` survives any keyboard layout quirks.

Output docs/screenshots/06-dev-stats.png

Set FontFamily "JetBrains Mono"
Set FontSize 14
Set Width 1400
Set Height 800
Set Padding 20
Set TypingSpeed 60ms

Type "GMAIL_FIXTURE_MODE=1 GMAIL_FIXTURE_DIR=./fixtures/gmail GMAIL_ACCOUNT=work node dist/cli/index.js tui"
Enter
Sleep 3s

# Open command palette + run `:stats`.
Type ":stats"
Enter

# Sleep through ~2 ticks of the 1Hz poller so the heap/RSS values populate
# (the panel shows "(collecting…)" on the very first tick).
Sleep 2500ms

Screenshot docs/screenshots/06-dev-stats.png

# Close + exit.
Type ":stats"
Enter
Sleep 300ms
Type "Q"
Sleep 200ms
