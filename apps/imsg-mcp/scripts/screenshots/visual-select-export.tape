# Visual select + export — V enters visual mode, j/k extend the selection,
# e opens the export modal (Tab cycles Markdown/CSV/JSON), y copies text.
# Run: vhs scripts/screenshots/visual-select-export.tape

Output docs/screenshots/visual-select-export.gif

Set FontSize 13
Set FontFamily "JetBrains Mono"
Set Width 1400
Set Height 800
Set Padding 5
Set TypingSpeed 100ms
Set Framerate 15

Hide
Type "mkdir -p /tmp/imsg-demo && HOME=/tmp/imsg-demo IMSG_TUI_THEME=safe node --env-file=.env.test dist/cli.js tui"
Enter
Wait+Screen@15s /Conversations/
Sleep 1s
Show

# Into a busy thread.
Type "j"
Sleep 300ms
Type "j"
Sleep 500ms
Tab
Sleep 800ms

# Enter visual select and grow the selection upward.
Type "V"
Sleep 800ms
Type "k"
Sleep 400ms
Type "k"
Sleep 400ms
Type "k"
Sleep 400ms
Type "k"
Sleep 800ms

# Open the export modal and cycle formats.
Type "e"
Sleep 1200ms
Tab
Sleep 800ms
Tab
Sleep 1200ms

Escape
Sleep 500ms
Escape
Sleep 500ms
Type "q"
Sleep 200ms
