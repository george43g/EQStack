# Canonical workflow: find a thread in the TUI, copy its slug, quit, and
# paste it into `imsg export`. Animated GIF for the README hero shot.
# Run: vhs scripts/screenshots/workflow-find-export.tape

Output docs/screenshots/workflow-find-export.gif

Set FontSize 13
Set FontFamily "JetBrains Mono"
Set Width 1400
Set Height 800
Set Padding 5
Set TypingSpeed 60ms
Set Framerate 24

Hide
Type "mkdir -p /tmp/imsg-demo && HOME=/tmp/imsg-demo IMSG_TUI_THEME=safe node --env-file=.env.test dist/cli.js tui"
Enter
Wait+Screen@15s /Conversations/
Sleep 1s
Show

# Open the filter
Type "/"
Sleep 500ms
# Filter to something the fixture chats are likely to match. The fixture
# generates `+1-555-01xx` synthetic numbers + lorem names; "55501" hits.
Type "55501"
Sleep 1s
Escape
Sleep 500ms

# Move down a few rows to land on a chat with messages.
Type "j"
Sleep 300ms
Type "j"
Sleep 300ms
Type "j"
Sleep 500ms

# Press y to copy the slug. The TUI shows a "Copied: …" footer toast.
Type "y"
Sleep 1500ms

# Quit
Type "q"
Sleep 800ms

# Now run the export command. Use a stable output path so the demo is
# reproducible — the slug copied above lands in the clipboard but the GIF
# narrates it via a typed example.
Type "imsg export <slug> --since '3 months ago' --include-attachments \"
Enter
Sleep 300ms
Type "  --output ~/group.md"
Sleep 2s
