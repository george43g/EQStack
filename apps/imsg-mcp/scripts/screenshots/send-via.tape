# Send-via modal — pressing S on a conversation surfaces the URL-scheme
# picker for every installed compatible app (Messages, SMS, Signal,
# WhatsApp, Telegram, FaceTime, Viber).
# Run: vhs scripts/screenshots/send-via.tape

Output docs/screenshots/send-via.png

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

# Pick a single-handle DM (easier for the picker to enumerate options).
Type "j"
Sleep 200ms
Type "j"
Sleep 800ms

# The picker binds in the THREAD pane — Tab focus over first.
Tab
Sleep 500ms

# Open the send-via picker
Type "S"
Sleep 1500ms

Screenshot docs/screenshots/send-via.png

Escape
Sleep 200ms
Type "q"
Sleep 200ms
