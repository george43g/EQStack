# CLI: relationship leaderboard + humans/v1 scaffolding. Runs against the
# synthetic fixture; VITE_HUMANS_DIR is pointed at a throwaway dir so no
# real home paths appear in the recording.
# Run: vhs scripts/screenshots/cli-humans.tape

Output docs/screenshots/cli-humans.gif

Set FontSize 14
Set FontFamily "JetBrains Mono"
Set Width 1200
Set Height 700
Set Padding 8
Set TypingSpeed 40ms
Set Framerate 15

Hide
Type "rm -rf /tmp/demo-humans && export VITE_HUMANS_DIR=/tmp/demo-humans && clear"
Enter
Sleep 500ms
Show

Type "node --env-file=.env.test dist/cli.js humans top"
Enter
Sleep 4s

Type "node --env-file=.env.test dist/cli.js humans init --top 3"
Enter
Sleep 4s

Type "ls /tmp/demo-humans"
Enter
Sleep 2s
