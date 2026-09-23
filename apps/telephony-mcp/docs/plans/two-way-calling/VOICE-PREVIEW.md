# Voice-profile preview session

> George, 2026-09-23: *"set up a call where i can just preview the different
> profiles, speak to them to listen to them and then just verbally adjust them
> and name the one i like"* — after the first delegate call, where the default
> voice *"sound[s] very generic… like an AI… change the speed and the accent,
> make it a bit cooler"*. Design basis: `ELEVENLABS-REALTIME.md`
> Recommendations 2–3 and D-86.

## What George runs

```sh
tel voices preview --watch --open
```

It creates (or updates in place) ONE ElevenLabs agent, `eqstack-preview-voices`,
prints the hosted talk-to link and opens it. George presses call in the browser
and talks on the laptop's mic and speakers — no phone call, no Twilio charge
(ElevenLabs agent minutes only). With `--watch` the command stays running and,
each time a session ends, applies the changes he asked for and saves the voice
he named. Without it the same steps are separate commands, and MCP tools:

| Step | CLI | MCP tool |
|---|---|---|
| Set up / refresh the agent, get the link | `tel voices preview [--candidates N] [--reset]` | `preview_voices` |
| What did the last session ask for? | `tel voices review [conv_…]` | `review_voice_preview` |
| Apply its changes (then reconnect) | `tel voices preview --apply [conv_…]` | `preview_voices {applyFrom}` |
| Save the named voice as a profile | `tel voices save [name] [--from conv_…] [--label L] [--dry-run]` | `save_voice_profile` |

A saved profile is a copy of the base profile (default `default`: prompt,
greeting, limits) with the chosen voice id, speed, stability and similarity.
Use it with `tel call <to> --profile <name> --mode delegate`. A running
`tel serve` read its config at start: restart it to see a new profile.

## How it works (and why this shape)

- **Talking half: EL's hosted page, not our code.** `GET agents/{id}/link`
  returns `token: null` for an agent without auth, and
  `https://elevenlabs.io/app/talk-to?agent_id=…` then gives mic, speaker and
  a live transcript. We build nothing for audio; no SDK is added (D-78 stands).
- **One agent, multi-voice.** The host speaks in River (neutral, not on
  audition); up to 9 candidates are `supported_voices` (10 including the
  default is EL's cap), switched with `<Label>…</Label>` markup, each with its
  own speed/stability/similarity. The line-up, with the reason for each pick,
  is `PREVIEW_CANDIDATES` in `src/domain/voice-preview.ts`.
- **Verbal changes are recorded, then applied between sessions.** The agent
  calls a client tool `adjust_voice {label, speed?, stability?, similarity?,
  note}` with new absolute values; `save_profile {label, name}` records a
  naming. Both are `expects_response: false`: EL acknowledges them itself, so
  the hosted page needs no code to answer them.
- **Pull, not push (INV-10 unchanged).** Tool calls appear in
  `GET conversations/{id}` as `tool_calls[].params_as_json` once the session
  is `done` (a few seconds after hang-up; `processing` first). No webhook, no
  new public route, no tunnel dependency.
- **The agent is the state.** Adjusted settings live in the agent's
  `supported_voices`; a plain re-run keeps them, `--reset` returns to the
  catalogue. There is no sqlite row, so the commands run in the calling
  process, not through `serve` (`LOCAL_COMMANDS` in `src/commands/specs.ts`).
- **The public agent is capped**: 2 concurrent sessions, 40 a day,
  `record_voice: false`.

## Measured 2026-09-23 (text-driven conversation WebSocket, real agent)

- A PATCH does **not** reach a session in progress: a prompt change was
  ignored, and the same sentence in the same voice gave 159,760 / 164,602
  audio bytes before a 0.9 → 1.2 speed PATCH and 154,918 after (a 33 %
  speed-up would be ≈ 120k). Hence "hang up and reconnect to hear it".
- Library voices not added to the account speak inside tags.
- Client tool calls with `expects_response: false` are acknowledged by EL
  (`agent_tool_response … status: success`) with no client answering, and
  are in the conversation record after `done`.

## Not verified

- The hosted page itself was not driven by voice here (no mic in an agent
  session); its behaviour on a client tool it has no handler for is believed
  harmless because EL answers fire-and-forget calls itself.
- Library voices on the **byo-model/direct** path (Twilio ConversationRelay's
  own ElevenLabs access) — a saved profile is known to work for `delegate`
  calls, which use George's account.
