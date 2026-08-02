# Message detail drawer — opens on Enter for the highlighted message.
# Shows full text, reply context, attachments, reactions, edit history.
# Run: vhs scripts/screenshots/message-drawer.tape

Output docs/screenshots/message-drawer.png

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

# Find a chat with attachments. The synthetic fixture generates some.
Type "j"
Sleep 200ms
Type "j"
Sleep 500ms
Tab
Sleep 500ms

# Jump up to a message that carries an attachment (📎) so the drawer's
# attachment section + o/s/y keys are actually visible. The fixture is
# deterministic; if generate-fixtures.ts changes its RNG draws, re-derive
# this offset (sidebar row / messages-from-bottom of the nearest 📎 row).
Type "4"
Sleep 100ms
Type "k"
Sleep 500ms

# Open the drawer
Enter
Sleep 1500ms

Screenshot docs/screenshots/message-drawer.png

Escape
Sleep 200ms
Type "q"
Sleep 200ms
