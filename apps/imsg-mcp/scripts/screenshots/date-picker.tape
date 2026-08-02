# Date-jump modal in calendar-picker mode (default). Tab toggles to free-form
# text mode (handles "1 year ago", "yesterday", "2025-12-25", etc).
# Run: vhs scripts/screenshots/date-picker.tape

Output docs/screenshots/date-picker.png

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

# Land in a chat with messages, switch focus to the message pane.
Type "j"
Sleep 200ms
Type "j"
Sleep 500ms
Tab
Sleep 800ms

# Open the date-jump modal
Type ":"
Sleep 1500ms

Screenshot docs/screenshots/date-picker.png

Escape
Sleep 200ms
Type "q"
Sleep 200ms
