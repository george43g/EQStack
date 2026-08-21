# Theme picker overlay — `:theme` opens a list of 8 themes.
# Output: docs/screenshots/03-theme-picker.png

Output docs/screenshots/03-theme-picker.png

Set FontFamily "JetBrains Mono"
Set FontSize 14
Set Width 1400
Set Height 800
Set Padding 20
Set TypingSpeed 60ms

Type "GMAIL_FIXTURE_MODE=1 GMAIL_FIXTURE_DIR=./fixtures/gmail GMAIL_ACCOUNT=work node dist/cli/index.js tui"
Enter
Sleep 3s

# Open the command palette and run `:theme` (no arg → opens picker).
Type ":theme"
Enter
Sleep 1500ms

Screenshot docs/screenshots/03-theme-picker.png

# Esc closes the overlay; Q quits the TUI.
Escape
Sleep 200ms
Type "Q"
Sleep 200ms
