# Analytics: relationship leaderboard — command palette (Ctrl-P) opens a
# fuzzy command list; analytics types render as virtual panes.
# Run: vhs scripts/screenshots/analytics-leaderboard.tape

Output docs/screenshots/analytics-leaderboard.png

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

# Open the command palette and pick the leaderboard analytic.
Ctrl+p
Sleep 800ms
Type "leaderboard"
Sleep 800ms
Enter
Sleep 2500ms

Screenshot docs/screenshots/analytics-leaderboard.png

Type "q"
Sleep 300ms
Type "q"
Sleep 200ms
