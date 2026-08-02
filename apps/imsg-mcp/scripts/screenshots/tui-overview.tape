# TUI overview — sidebar + thread, default safe theme.
# Run: vhs scripts/screenshots/tui-overview.tape

Output docs/screenshots/tui-overview.png

Set FontSize 13
Set FontFamily "JetBrains Mono"
Set Width 1400
Set Height 800
Set Padding 5
Set TypingSpeed 50ms

Hide
Type "mkdir -p /tmp/imsg-demo && HOME=/tmp/imsg-demo IMSG_TUI_THEME=safe node --env-file=.env.test dist/cli.js tui"
Enter
Wait+Screen@15s /Conversations/
Sleep 1s
Show

# Move into the sidebar and pick a heavy thread.
Type "j"
Sleep 200ms
Type "j"
Sleep 200ms
Type "j"
Sleep 1s
# Tab into the thread pane so the focused-border is visible.
Tab
Sleep 1s
# Scroll the thread to the bottom for the "active" look.
Type "G"
Sleep 1s

Screenshot docs/screenshots/tui-overview.png

Type "q"
Sleep 200ms
