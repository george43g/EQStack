# Hero workflow GIF — boot → open thread → close → :account → swap → ~stats.
# Output: docs/screenshots/workflow-demo.gif
#
# Kept under ~12s wallclock so the GIF stays under a couple MB and renders
# inline in GitHub markdown. Each beat sleeps long enough to read but not
# longer.

Output docs/screenshots/workflow-demo.gif

Set FontFamily "JetBrains Mono"
Set FontSize 14
Set Width 1400
Set Height 800
Set Padding 20
Set TypingSpeed 70ms
Set Framerate 24
Set PlaybackSpeed 1.0

Type "GMAIL_FIXTURE_MODE=1 GMAIL_FIXTURE_DIR=./fixtures/gmail GMAIL_ACCOUNT=work node dist/cli/index.js tui"
Enter
Sleep 2500ms

# Beat 1 — boot pause so viewers see the inbox.
Sleep 1s

# Beat 2 — open the highlighted thread.
Enter
Sleep 1500ms

# Beat 3 — close back to the inbox.
Type "q"
Sleep 800ms

# Beat 4 — open the account switcher.
Type ":account"
Enter
Sleep 1200ms

# Beat 5 — close it (no swap; just demonstrating the modal).
Escape
Sleep 500ms

# Beat 6 — toggle the dev stats overlay so viewers see the live ticker.
Type "~"
Sleep 1800ms

# Final exit.
Type "~"
Sleep 200ms
Type "Q"
Sleep 200ms
