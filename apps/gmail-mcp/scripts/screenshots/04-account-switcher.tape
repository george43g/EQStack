# Account switcher overlay — `:account` opens the multi-account picker.
# Output: docs/screenshots/04-account-switcher.png
#
# Both fixture accounts (work + personal) render with synthetic
# @fixture.test emails — proves the fixture-config-dir isolation works.

Output docs/screenshots/04-account-switcher.png

Set FontFamily "JetBrains Mono"
Set FontSize 14
Set Width 1400
Set Height 800
Set Padding 20
Set TypingSpeed 60ms

Type "GMAIL_FIXTURE_MODE=1 GMAIL_FIXTURE_DIR=./fixtures/gmail GMAIL_ACCOUNT=work node dist/cli/index.js tui"
Enter
Sleep 3s

# Open the command palette and run `:account` (opens the switcher).
Type ":account"
Enter
Sleep 1500ms

Screenshot docs/screenshots/04-account-switcher.png

Escape
Sleep 200ms
Type "Q"
Sleep 200ms
