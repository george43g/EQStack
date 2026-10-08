# Local speech-to-text and OCR engines for imsg-mcp (gmac, macOS 15.7.7 arm64)

Measured 2026-10-08. Samples are synthetic only (`say` + ImageMagick) and live in `samples/` next to this file.
Harness: `run.sh` (wall time via `date`, 90 s alarm, stdin closed), `wer.py` (word error rate, lower-cased, punctuation stripped).

## 0. Headline findings (read these first)

1. **Installing `whisper-cli` currently BREAKS imsg's chain instead of helping.** `media.ts:167-195` runs `whisper-cli -f <path> -np -nt` with **no `-m`**. whisper-cli then looks for `models/ggml-base.en.bin` relative to the *cwd* of the imsg process, exits 3 ("model file not found"), `transcribeAudio` swallows it and returns `null`. `detectTranscriber` uses `which` and caches the first hit, so it never falls through to `hear`. There is no env var for the model (checked `strings` on the binary and `--help`: only `WHISPER_ARG_DEVICE`, `WHISPER_COMMON_MINIAUDIO_SKIP`). The code needs a change (wave 2): pass `-m <resolved model>` and convert audio first.
2. **whisper-cli cannot read iMessage voice memos directly.** It accepts only flac, mp3, ogg, wav (its own usage line). CAF/Opus, M4A, AIFF all fail with exit 11. `afconvert -f WAVE -d LEI16@16000 -c 1 in.caf out.wav` (macOS built-in, 0.04 s) fixes it.
3. **`hear` accepts CAF/Opus, CAF/AAC, M4A, WAV and AIFF directly** and is the best zero-config fit for iMessage voice memos. Its only weak point is Speech Recognition TCC consent (section 2).
4. **`yap` cannot run on macOS 15.** Not installed (section 4).
5. **OCR: `mac-ocr` (npm) is installed and verified**; imsg has no OCR hook yet.

## 1. Test matrix

Reference texts: `samples/t1.txt` (long, 8.9 s voice-memo style), `t2.txt` (short, numbers). Audio made with `say -v Samantha|Daniel -o x.aiff`, then:

```
afconvert -f WAVE -d LEI16@16000 -c 1 a1.aiff a1.wav     # rc 0
afconvert -f m4af -d aac            a1.aiff a1.m4a       # rc 0
afconvert -f caff -d opus           a1.aiff a1-opus.caf  # rc 0  (24 kHz mono Opus, 33 KB, the iMessage .caf shape)
afconvert -f caff -d aac            a1.aiff a1-aac.caf   # rc 0
```
`afconvert -d opus` IS supported on 15.7.7.

### Speech (t1, 8.9 s). WER is vs the reference text.

| Engine / model | Input | rc | Wall | WER |
|---|---|---|---|---|
| hear -d | a1.wav | 0 | 6.49 s (first run, cold) | 9.1 % |
| hear -d | a1.m4a | 0 | 0.86 s | 9.1 % |
| hear -d | a1-opus.caf | 0 | 0.73 s | 9.1 % |
| hear -d | a1-aac.caf | 0 | 0.93 s | 9.1 % |
| hear -d | a1.aiff | 0 | 2.26 s | 9.1 % |
| whisper-cli base.en | a1.wav | 0 | 17.7 s cold, 0.47 s warm | 0.0 % |
| whisper-cli base.en | a1.m4a / opus.caf / aiff | **11** | 0.25 s | n/a (cannot decode) |
| whisper-cli large-v3-turbo-q5_0 | a1.wav | 0 | 1.83 s first, 1.34 s warm | 0.0 % |
| whisper-cli large-v3-turbo-q5_0 | a1.m4a / opus.caf / aiff | **11** | 0.4 s | n/a |
| afconvert opus.caf -> wav, then turbo | rt.wav | 0 | 0.04 s + 1.09 s | 0.0 % |
| whisper-cli with no `-m` (what imsg does today) | a1.wav | **3** | 0.01 s | n/a, "model file not found 'models/ggml-base.en.bin'" |

hear's 9.1 % is "6:30" vs "half past six" (a spoken-form versus numeric-form normalisation, same meaning). t2 (short, numbers): hear -> "The quarterly invoice for Acme robotics totals $4200 due on March 15" (wav and opus.caf, 0.5 s); whisper base.en and turbo -> "...totals $4,200, due on March 15." All 37.5 % WER by the strict metric, all semantically correct. hear has no punctuation or commas unless `-p`. Whisper punctuates and capitalises.

### OCR (mac-ocr 1.1.1)

| Sample | Command | rc | Wall | Result |
|---|---|---|---|---|
| o1.png (clean 1000x420 invoice) | `mac-ocr o1.png` | 0 | 0.73 s (0.55 s as jpg) | WER 3.8 %: one misread, "ref" read as "ret" |
| o2.png (dark mode, noisy phone-style 390x300) | `mac-ocr o2.png` | 0 | 0.45 s | WER 0.0 % |
| o2.png | `mac-ocr o2.png --fast` | 0 | 0.24 s | WER 29.4 %, garbled; do not use |
| both | `ocrmac` Python API | 0 | 0.46-0.57 s | same text as mac-ocr |

PNG and JPEG both fine. Accurate mode (the default) is the one to use.

## 2. Engines

### hear (SFSpeechRecognizer)
- Install: no Homebrew formula in core. The tap (`brew tap sveinbjornt/hear https://github.com/sveinbjornt/hear && brew install sveinbjornt/hear/hear`) builds from source and **needs full Xcode**, so I used the signed + notarised release binary instead:
  `curl -L -O https://github.com/sveinbjornt/hear/releases/download/0.8/hear-0.8.zip && unzip hear-0.8.zip && install -m755 hear-0.8/hear ~/.local/bin/hear`
  (Developer ID `5WX26Y89JP`, spctl says "origin=Developer ID". The upstream `install.sh` needs sudo for /usr/local/bin; avoided.)
- Version 0.8; binary `~/.local/bin/hear` (170 KB, arm64+x86_64). `hear -v` prints the version; `-V` is invalid.
- Models: none to manage; uses the system Speech model. On-device needs the dictation language model for the locale. en-US worked offline with `-d` (`hear -s` lists 50+ locales).
- Invocation imsg uses: `hear -d -i <file>` (stdout = transcript, one line, no punctuation, `$4200` style numerals). `-p` adds punctuation (macOS 13+); `-l en-AU` sets locale.
- Formats: WAV, M4A, CAF/Opus, CAF/AAC, AIFF all OK directly (AVAudioFile reads whatever CoreAudio reads).
- Missing file -> `No file at path '...'`, rc 1.
- **Permissions:** Speech Recognition (kTCCServiceSpeechRecognition). hear calls `requestAuthorization`; strings show it handles denied / restricted / notDetermined and prints "Speech recognition authorization denied/restricted/not determined". Possible message: "Speech recognizer not available. Try enabling Siri in System Settings."
  - On this Mac it ran with no prompt because TCC attributes the request to the *responsible process*, and `~/Library/Application Support/com.apple.TCC/TCC.db` has exactly one Speech row: `/opt/homebrew/Cellar/skhd/0.3.9/bin/skhd`, auth_value 2 (allowed). The tmux/claude chain is descended from skhd, so hear inherited that grant. **Not verified:** what happens when hear's responsible process has no grant (I did not reset TCC; that would be a GUI-consent change). Expected: macOS shows the consent dialog for the host app (Terminal/iTerm/the MCP host) once; with no GUI session (ssh, launchd daemon, CI) the status stays notDetermined and hear exits with the message above, so imsg gets `null`.
  - Practical rule for docs: run `hear -d -i some.wav` once from the app that hosts the MCP server and click Allow.
- Caveats: `-d` forces on-device (imsg already passes it). Long files: Apple's recogniser has ~1 minute practical limit per request and hear is slower than whisper on long audio (6.5 s cold start). Accuracy is a notch below whisper on proper nouns ("Acme robotics").

### whisper.cpp (`whisper-cli`)
- Install: `brew install whisper-cpp` (formula name is `whisper.cpp`, old name accepted). Version 1.9.5, `/opt/homebrew/bin/whisper-cli`, links ggml, llama.cpp, sdl2-compat. Metal GPU used by default (`-ng` disables).
- Models in `~/.local/share/whisper-models/` (downloaded from `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/<name>`):
  - `ggml-large-v3-turbo-q5_0.bin` 574,041,195 bytes (548 MB). **Recommended.** Multilingual, 0 % WER on t1, ~1.1-1.4 s warm for 9 s of audio, first load ~2 s.
  - `ggml-base.en.bin` 147,964,211 bytes (141 MB). English only, equally exact on these samples, 0.4-0.5 s warm, but 17.7 s on the very first run (Metal pipeline compile) and visibly weaker on noisy or accented speech in general. Good fallback for small machines.
  - Bigger options not fetched: `ggml-large-v3-turbo.bin` (1.6 GB, unquantised), `ggml-small.en.bin` (466 MB).
- **Model selection: flag only.** `-m FNAME`, default `models/ggml-base.en.bin` relative to cwd. No env var, no config file. So imsg must pass `-m` itself (suggest env/config `IMSG_WHISPER_MODEL`, default `~/.local/share/whisper-models/ggml-large-v3-turbo-q5_0.bin`).
- Invocation to adopt: `whisper-cli -m <model> -f <wav> -np -nt` (stdout = text, leading space, punctuated; progress lines go to stderr). Add `-l auto` only with a multilingual model.
- Formats: **flac, mp3, ogg, wav only.** M4A / CAF / AIFF fail (rc 11, "failed to read audio file"). Convert first: `afconvert -f WAVE -d LEI16@16000 -c 1 in out.wav` (works for CAF/Opus, 0.04 s; no ffmpeg needed). ffmpeg also works (`ffmpeg -i in.caf -ar 16000 -ac 1 out.wav`, rc 0).
- Permissions: none (offline, no TCC).
- Draft shim proving the fix works from the outside (not installed): `shim/whisper-cli` adds `-m` and afconvert; results: opus.caf -> 0 % WER in 1.28 s, m4a -> 0 % in 1.08 s, rc 0.
- Caveat: because `which whisper-cli` now succeeds, imsg will pick it before hear and fail until fixed (finding 1). Either land the code change, or `brew uninstall whisper-cpp` meanwhile, or put the shim first on PATH.

### yap (finnvoor/yap) - NOT INSTALLED
- Package.swift: `platforms: [.macOS("26")]`; Homebrew formula: `depends_on macos: :tahoe`; README: "on macOS 26". It uses SpeechAnalyzer/SpeechTranscriber, which does not exist on 15.7.7. Also unsupported on virtualised macOS.
- Consequence: the `yap` entry in imsg's chain is dead code on this Mac (and any pre-Tahoe Mac). On macOS 26 the chain could prefer it (`brew install yap`; imsg calls `yap transcribe <file>`). Not testable here.

### OCR: mac-ocr (privatenumber/mac-ocr) - INSTALLED
- Install: `npm install -g mac-ocr`. Version 1.1.1, MIT, prebuilt universal binary (no Xcode), macOS 10.15+. Path: `~/.local/share/mise/installs/node/24/bin/mac-ocr` (lives under the mise node install, so it vanishes if the mise node version is switched or removed; `npx mac-ocr` is the portable form).
- Apple Vision `VNRecognizeTextRequest`, accurate mode by default, fully on-device, no TCC prompt.
- Invocations: `mac-ocr img.png` (text on stdout); `mac-ocr img.png --format json` (bounding boxes + confidence); `cat shot.png | mac-ocr`; `-l en-US` for languages; PDFs supported; `mac-ocr document ...` (structured tables) needs macOS 26.
- Formats: PNG, JPEG verified; HEIC/PDF per README (not tested; iMessage screenshots are often HEIC/PNG, worth a quick check in wave 2).
- Considered and rejected: `ocrmac` (pip/uv, installed to `~/.local/share/uv/tools/ocrmac` and works, but its `ocrmac` console script is an empty click stub, Python API only); `schappim/macOCR` (screen-capture to clipboard, interactive); `riddleling/macocr`, `xulihang/macOCR` (small, build from source). Remove the uv install with `uv tool uninstall ocrmac` if unwanted (47 MB).
- Caveats: one misread on clean text ("ref" -> "ret"), so downstream use should treat OCR as approximate (match fuzzily, show confidence if used for search). `--fast` is unusable on small text.

## 3. Recommended default local chain for wave 2

Transcription (voice memos arrive as CAF/Opus):
1. **Normalise first** in imsg: if the file is not wav/mp3/ogg/flac, `afconvert -f WAVE -d LEI16@16000 -c 1 <in> <tmp>.wav` (always present on macOS), delete the temp afterwards. Only whisper needs it; hear can take the original.
2. **Order: whisper-cli (turbo q5_0) -> hear -> yap(macOS 26 only)**. Reasoning: whisper is the most accurate, punctuates, runs offline with no TCC dependency, and works headless (MCP server under launchd/ssh). hear is the zero-install-size fallback, but its consent dependency makes it unreliable headless. If George prefers least setup, hear first is also defensible: it needs no download and accepts CAF directly.
3. Change `detectTranscriber` so it checks *usability* not just `which` (whisper-cli present but no model => skip, fall through to hear). Add `IMSG_WHISPER_MODEL` (file path) and an `IMSG_TRANSCRIBER=auto|hear|whisper|yap|none` override so the choice is the user's, as George asked. Cloud stays strictly opt-in, last.
4. Add `-m` to args; bump timeouts: first whisper call cold-starts (2 s turbo, up to 18 s base.en).

OCR (new hook): `mac-ocr <image>` first (stdout text), fall back to nothing. Detect with `which mac-ocr`, allow `IMSG_OCR=auto|mac-ocr|none` and `IMSG_OCR_CMD`.

## 4. Draft user-facing install docs

### Local transcription and OCR (no cloud)
imsg-mcp can turn voice memos into text and read text in screenshots entirely on your Mac. Nothing leaves the device unless you opt in to a cloud endpoint.

**Option A - whisper.cpp (best accuracy, works headless)**
```sh
brew install whisper-cpp
mkdir -p ~/.local/share/whisper-models
curl -L -o ~/.local/share/whisper-models/ggml-large-v3-turbo-q5_0.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin   # 548 MB
export IMSG_WHISPER_MODEL=~/.local/share/whisper-models/ggml-large-v3-turbo-q5_0.bin       # proposed key
```
Smaller, English-only: `ggml-base.en.bin` (141 MB).

**Option B - hear (Apple Speech, nothing to download)**
```sh
curl -L -O https://github.com/sveinbjornt/hear/releases/download/0.8/hear-0.8.zip
unzip hear-0.8.zip && install -m755 hear-0.8/hear ~/.local/bin/hear      # ~/.local/bin must be on PATH
hear -d -i any-recording.wav       # run once from the app that hosts imsg-mcp, click Allow on the
                                   # "Speech Recognition" prompt (System Settings > Privacy & Security > Speech Recognition)
```
Needs Siri/Dictation language support enabled for your language. Without the permission, transcription silently returns nothing.

**Option C - yap (macOS 26 Tahoe or newer only)**: `brew install yap`. Does not run on macOS 15 or earlier.

**Screenshots / OCR**
```sh
npm install -g mac-ocr        # Apple Vision, on-device, no permission prompt
mac-ocr screenshot.png
```

**Choosing**: imsg tries the engines in the order above; to force one set `IMSG_TRANSCRIBER=whisper|hear|yap|none` (proposed). Verify with `whisper-cli -m "$IMSG_WHISPER_MODEL" -f sample.wav -np -nt`, `hear -d -i sample.wav`, `mac-ocr sample.png`. Voice memos are `.caf` (Opus): whisper needs them converted, which imsg does with the built-in `afconvert`.

## 5. Needs George / not done
- TCC: only skhd holds Speech Recognition. If imsg-mcp is launched from another host app (Claude Desktop, Cursor, Terminal, launchd), that app needs its own one-time Allow click. Cannot be done by an agent.
- hear's behaviour with an ungranted host was not exercised (would require resetting or clicking TCC).
- Nothing in this repo was edited. Installed outside the repo: `/opt/homebrew/bin/whisper-cli` (+ ggml, llama.cpp, sdl2-compat deps), `~/.local/bin/hear`, `~/.local/share/whisper-models/` (722 MB), `mac-ocr` (npm global under mise node 24.15.0), `ocrmac` (uv tool, optional).
