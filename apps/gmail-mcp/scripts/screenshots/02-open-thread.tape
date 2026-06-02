# Open the first thread → MessagePane render.
# Output: docs/screenshots/02-open-thread.png

Output docs/screenshots/02-open-thread.png

Set FontFamily "JetBrains Mono"
Set FontSize 14
Set Width 1400
Set Height 800
Set Padding 20
Set TypingSpeed 60ms

Type "GMAIL_FIXTURE_MODE=1 GMAIL_FIXTURE_DIR=./fixtures/gmail GMAIL_ACCOUNT=work node dist/cli/index.js tui"
Enter
Sleep 3s

# Press Enter to open the highlighted thread. The MessagePane renders the
# subject + headers + body for each message in the thread.
Enter
Sleep 2s

Screenshot docs/screenshots/02-open-thread.png

# `q` closes the message pane back to the inbox; `Q` quits the TUI.
Type "Q"
Sleep 200ms
