# Sidebar filter — `/` live-filters conversations by name/slug/handle.
# Run: vhs scripts/screenshots/filter.tape

Output docs/screenshots/filter.png

Set FontSize 13
Set FontFamily "JetBrains Mono"
Set Width 1400
Set Height 800
Set Padding 5
Set TypingSpeed 80ms

Hide
Type "mkdir -p /tmp/imsg-demo && HOME=/tmp/imsg-demo IMSG_TUI_THEME=safe node --env-file=.env.test dist/cli.js tui"
Enter
Wait+Screen@15s /Conversations/
Sleep 1s
Show

Type "/"
Sleep 500ms
Type "quinn"
Sleep 1200ms

Screenshot docs/screenshots/filter.png

Escape
Sleep 200ms
Type "q"
Sleep 200ms
