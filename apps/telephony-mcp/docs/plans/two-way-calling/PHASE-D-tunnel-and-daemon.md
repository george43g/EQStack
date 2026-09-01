# PHASE D — named tunnel + launchd daemon

> Depends on **Phase B** (command registry). Parallel with **C** and **E**.
> [`WORKSTREAM.md`](./WORKSTREAM.md) outranks this file.

## Inherited invariants

| INV | How it binds this phase |
|---|---|
| **INV-5** | `tunnel` and `daemon` verbs are registry commands with thin CLI adapters — not a second command surface bolted onto `cli.ts`. |
| **INV-6** | The new config blocks are Zod-parsed like everything else. No `process.env.X ?? ""` shortcuts for tunnel settings. |
| **INV-9** | Single WAL writer. The supervisor must never let **two** `serve` processes exist — a launchd-managed one plus a hand-started one is the realistic way this breaks. |
| **INV-10** | The tunnel exposes only the three public routes (`public-server.ts:121`). `cloudflared`'s own metrics/`/ready` endpoint binds loopback. Nothing new becomes publicly reachable. Admin (`admin-server.ts:224`) is never routed. |
| **INV-11** | **Never log the tunnel URL or hostname.** Log the tunnel *name*. Never put the tunnel token in `argv` — `ps aux` is world-readable on this Mac. |
| **INV-12** | The tunnel token resolves **by name** through `EnvKeychainSecretProvider` (`stores/secrets.ts:28-57`), env → opkeep. No `.env`, no literal token in config. |
| **INV-14** | Plist rendering and supervisor state machine are unit-testable with injected `spawn`/`fetch`. The default suite starts no tunnel and calls no network. |

## Scope

1. A **named** Cloudflare Tunnel (D-10) on a George-owned domain → `server.publicBaseUrl` becomes a constant that is never edited again, and the Twilio webhook never needs re-pointing.
2. `tunnel` + `daemon` config blocks that existing configs survive.
3. A supervisor: `serve` owns `cloudflared` as a child (start, readiness, restart with backoff, clean kill).
4. A macOS **LaunchAgent** so `serve` survives terminal close, crash and reboot; `tel daemon start|stop|status|logs` wraps `launchctl` (D-9).

## Non-goals

- **Cloudflare Worker front door** — R-1 / D-18, deferred to Phase N. Not a latency fix.
- **Inbound routes** (`/twilio/voice`) — Phases L–M. This phase changes no route.
- **Linux / systemd parity — explicitly PARKED** (D-9). Note it in the code comment; build nothing.
- **Re-pointing the Twilio number's webhook** — a live account change, George's authority (brief §8). With a named tunnel it becomes a one-time action instead of a per-restart one; that is the whole point.
- Auto-provisioning the tunnel via the Cloudflare API. One-time human setup.

---

## Ground truth (verified on this machine, 2026-08-29)

| Fact | Evidence |
|---|---|
| No tunnel automation exists anywhere in `src/` | file listing of `src/**`; no tunnel module |
| `publicBaseUrl` is manual config, optional in schema | `src/config/schema.ts:104-105` |
| `serve` refuses to start without it | `src/gateway/gateway.ts:60-64` |
| `doctor` says "missing — serve will refuse to start (start the tunnel first)" | `src/cli.ts:93` |
| `serve` is a plain foreground process; SIGINT/SIGTERM only; dies with the terminal | `src/cli.ts:59-75` (**not** 60-77) |
| Quick-Tunnel churn is a documented, lived pain | `HANDOFF.md:359-360` |
| `cloudflared` **is installed**: `/opt/homebrew/bin/cloudflared`, version `2026.8.1` | `cloudflared --version` |
| **`~/.cloudflared` does not exist** → `cloudflared tunnel login` has never been run here | `ls ~/.cloudflared` → No such file |
| WebSockets already traverse cloudflared for this app | the 2026-08-02 live ConversationRelay call (brief §0) ran over a Quick Tunnel |
| An in-house LaunchAgent precedent exists, same author, same `node dist/cli.js <verb>` shape | `~/Library/LaunchAgents/com.george43g.up-bank.plist` |
| `@george43g/robustness@0.12.0` exports `./shutdown` and `./watchdog` | its `package.json` `exports` |

**`cloudflared` CLI, read off the installed binary's own `--help` (not from memory):**

- `cloudflared tunnel login` · `create <name>` · `route dns <name> <hostname>` · `list` · `info` · `delete` · `cleanup`
- `cloudflared tunnel run [--token <T> | --token-file <path> | --credentials-file <path>] <name|uuid>`
- `--metrics <addr>` (loopback readiness/metrics listener) · `cloudflared tunnel ready` calls `/ready` and returns an exit code
- `--pidfile <path>` · `--no-autoupdate` · `--loglevel` · `--logfile` · `--output json`
- env equivalents: `TUNNEL_TOKEN`, `TUNNEL_CRED_FILE`, `TUNNEL_METRICS`, `TUNNEL_PIDFILE`, `TUNNEL_ORIGIN_CERT`

**Unknown — verify before implementing:**
- The exact ingress config for the locally-managed style (`config.yml` `ingress:` key names, `originRequest` options). *Verify against `cloudflared tunnel ingress --help` and Cloudflare's tunnel docs.*
- The JSON body of `/ready` (we only rely on the HTTP status). *Verify against `curl 127.0.0.1:<metricsPort>/ready`.*
- Whether `launchctl load/unload` are still needed as a fallback beside `bootstrap/bootout/kickstart/print` on this macOS. *Verify against `man launchctl` on the target machine.*
- `ThrottleInterval` semantics and default. *Verify against `man launchd.plist`.*

---

## Steps

### 1. One-time provisioning (George-gated, not code)

`~/.cloudflared` is absent, so this phase cannot be finished by an agent alone. Write it as a documented runbook in `docs/`, executed by George:

1. `cloudflared tunnel login` (browser OAuth, picks the zone).
2. Create the tunnel and route DNS — **pick one style:**

| Style | Provision | Secret | Ingress lives in |
|---|---|---|---|
| **Locally-managed** | `tunnel create <name>` writes `~/.cloudflared/<UUID>.json` | credentials file on disk | a local `config.yml` |
| **Remotely-managed** *(recommended)* | dashboard/API creates it | one token, resolvable by NAME via opkeep (INV-12) | Cloudflare |

Recommend remotely-managed: one secret by name, nothing local to drift, and the ingress survives a wiped Mac. → **new `## Open` row in DECISIONS.md** (hostname + style are George's).

3. `cloudflared tunnel route dns <name> voice.<george-domain>`
4. Set `server.publicBaseUrl` = `https://voice.<george-domain>` — **once, forever.**
5. Re-point the Twilio number's webhook — one time, and never again (brief §8; still George's authority).

### 2. Config: `tunnel` + `daemon` blocks, without breaking existing configs

`ConfigSchema` is `.strict()` (`schema.ts:148`) — unknown keys fail. But `.strict()` rejects only **unknown** keys, so *adding* known keys is safe in the forward direction. Follow the pattern the file already uses three times — `ServerSchema` (`:102-111`), `LimitsSchema` (`:114-125`), `disclosure` (`:136-146`): `.strict().default({})`, every field defaulted or `.optional()`. A config with neither block parses unchanged.

```ts
export const TunnelSchema = z.object({
  provider: z.enum(["cloudflared"]).default("cloudflared"),
  enabled: z.boolean().default(false),          // opt-in: existing setups keep working
  tunnelName: z.string().min(1).optional(),
  hostname: z.string().min(1).optional(),
  tokenRef: z.string().nullable().default("CLOUDFLARE_TUNNEL_TOKEN"), // NAME, never a value
  credentialsFile: z.string().nullable().default(null),
  binPath: z.string().default("/opt/homebrew/bin/cloudflared"),
  metricsPort: z.number().int().min(1).max(65535).default(20241),
  healthIntervalMs: z.number().int().min(1000).default(15_000),
  restart: z.object({
    initialBackoffMs: z.number().int().min(100).default(1_000),
    maxBackoffMs: z.number().int().min(1000).default(60_000),
    giveUpAfter: z.number().int().min(1).default(10),
  }).strict().default({}),
}).strict().default({});

export const DaemonSchema = z.object({
  label: z.string().default("com.george43g.telephony-mcp"),
  runAtLogin: z.boolean().default(true),
  keepAlive: z.boolean().default(true),
  logDir: z.string().default("~/Library/Logs/telephony-mcp"),
  nodeBin: z.string().nullable().default(null),  // null → process.execPath at install time
}).strict().default({});
```

**Cross-field check in the existing `superRefine` (`schema.ts:149-169`)** — this is the highest-value five lines in the phase:

> if `tunnel.enabled` then `server.publicBaseUrl` must be set **and** `new URL(publicBaseUrl).host === tunnel.hostname`.

Without it, a hostname mismatch means Cloudflare routes to the right box while `validateTwilioSignature` computes the signature against a *different* URL (`public-server.ts:130` and `:82`) — **every webhook and every relay upgrade 403s**, and nothing in the logs says "hostname". Fail at parse instead.

Note the reverse direction is not compatible: a config carrying `tunnel` fed to an older binary fails `.strict()`. Acceptable; say so in the migration note.

### 3. `src/daemon/supervisor.ts` (new) — supervise `cloudflared`

Pure state machine with injected deps (`spawn`, `fetch`, `Clock`), mirroring the `ExecFileFn` seam at `stores/secrets.ts:18-26`.

| Concern | Design |
|---|---|
| **Token** | resolve `tunnel.tokenRef` via `SecretProvider` → pass as `TUNNEL_TOKEN` in the **child env**, or write a `0600` token file and use `--token-file`. **Never `--token <value>`** — argv is visible in `ps aux` to every process on the machine. |
| **Readiness** | `--metrics 127.0.0.1:<metricsPort>`, then poll `http://127.0.0.1:<metricsPort>/ready` until 2xx or timeout. Loopback only (INV-10). |
| **Health loop** | re-poll `/ready` every `healthIntervalMs`; a non-2xx marks the tunnel down and emits an event, it does not kill the gateway. |
| **Restart** | exponential backoff `initialBackoffMs → maxBackoffMs` with jitter; **crash-loop breaker** at `giveUpAfter` — stop, log `tunnel_gave_up`, stay up degraded. Hammering Cloudflare is worse than being visibly down. |
| **Stale child** | pass `--pidfile <stateDir>/cloudflared.pid`; on startup, if that PID is alive and is a `cloudflared`, kill it before spawning. An orphaned cloudflared holding the hostname while a fresh `serve` starts is the silent-failure mode the sibling app already learned (`imsg-mcp` orphan/parent-PID lessons). |
| **Shutdown** | register the child-kill in `@george43g/robustness/shutdown` (adopted in Phase A) rather than extending the ad-hoc handlers at `cli.ts:70-71`. SIGTERM, grace, SIGKILL. |
| **Logging** | through `logger` only (`src/log.ts:31-36`). Log `tunnelName`, never `hostname` or a URL (INV-11). |

**Placement:** launchd supervises `serve`; `serve` spawns `cloudflared`. One process to turn voice on, one lifetime, and the gateway knows whether its own front door is open. Alternative (two independent plists) is listed under Open questions.

### 4. `src/daemon/launchd.ts` (new) — plist + `launchctl`

Split it: `renderPlist(spec): string` is **pure** (snapshot-testable, no `launchctl`); the `launchctl` calls are a thin injected wrapper.

Shape verified against the in-house precedent `~/Library/LaunchAgents/com.george43g.up-bank.plist`:

```xml
<key>Label</key><string>com.george43g.telephony-mcp</string>
<key>ProgramArguments</key>
<array>
  <string>/absolute/path/to/node</string>
  <string>/absolute/path/to/apps/telephony-mcp/dist/cli.js</string>
  <string>serve</string>
</array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>…/Library/Logs/telephony-mcp/launchd.out.log</string>
<key>StandardErrorPath</key><string>…/Library/Logs/telephony-mcp/launchd.err.log</string>
```

Non-obvious requirements:

- **Absolute paths everywhere.** launchd supplies no user `PATH` — the same reason `secrets.ts:15` hardcodes `/usr/bin/security` and `binPath` is a config field here. Resolve `nodeBin` from `process.execPath` at install time and bake it in.
- **LaunchAgent, not LaunchDaemon.** An Agent runs in the logged-in GUI session, so the login keychain is unlocked and `EnvKeychainSecretProvider` (`secrets.ts:39-53`) can read opkeep. A Daemon would survive logout but cannot reach the keychain — every secret would resolve `null` and `startGateway` would throw at `gateway.ts:69-74`. Trade-off, not an oversight → Open question.
- **`KeepAlive: true` + a config error = an infinite respawn.** `cli.ts:33-36` exits 1 on a bad config and `gateway.ts:60-64` throws when `publicBaseUrl` is missing, so launchd restarts forever (throttled ~10 s). Mitigation: `ThrottleInterval` (*verify against `man launchd.plist`*) **plus** `tel daemon status` reporting restart count so a loop is visible rather than silent.
- Stderr is where the structured NDJSON goes (`log.ts:28`), so `StandardErrorPath` is the real log; `tel daemon logs` tails it.

### 5. Registry commands + CLI adapters (INV-5)

| Command | Implementation |
|---|---|
| `daemon install` | render plist → `~/Library/LaunchAgents/<label>.plist`, `launchctl bootstrap gui/$(id -u) <plist>` |
| `daemon uninstall` | `launchctl bootout gui/$(id -u)/<label>`, remove plist |
| `daemon start` / `stop` | `kickstart` / `bootout` |
| `daemon restart` | `kickstart -k` |
| `daemon status` | parse `launchctl print gui/<uid>/<label>` (PID, last exit, restarts) **+** gateway `GET /healthz` (`admin-server.ts:71-77`) **+** tunnel `/ready`. One line per layer. |
| `daemon logs` | tail `StandardErrorPath`, `--follow` |
| `tunnel status` | `cloudflared tunnel info <name>` + local `/ready`. Prints the tunnel **name and state, never the hostname** (INV-11). |

`doctor` gains three checks beside the existing ones (`cli.ts:78-139`): `cloudflared` binary present at `binPath`; tunnel token resolvable by name; `publicBaseUrl` host matches `tunnel.hostname`. Reword `cli.ts:93` — "start the tunnel first" stops being true once the daemon owns it.

---

## Verification

`pnpm --filter telephony-mcp test typecheck lint` → root `pnpm verify`. No network, no tunnel, no paid calls (INV-14).

| # | Test | Pins |
|---|---|---|
| 1 | a config with **neither** `tunnel` nor `daemon` parses unchanged; every default lands | back-compat under `.strict()` |
| 2 | `tunnel.enabled: true` + `hostname` ≠ `publicBaseUrl` host → **parse error** | the 403 trap |
| 3 | `tunnel.enabled: true` with no `publicBaseUrl` → parse error | Step 2 |
| 4 | an unknown key inside `tunnel` → parse error | `.strict()` still strict |
| 5 | `renderPlist()` snapshot: absolute node path, absolute `dist/cli.js`, `serve`, `RunAtLoad`, `KeepAlive`, both log paths | Step 4 |
| 6 | supervisor with a fake spawn: child exits → restart at `initialBackoffMs`, then doubling, capped at `maxBackoffMs` | Step 3 |
| 7 | `giveUpAfter` restarts → stops, logs once, **gateway stays up** | crash-loop breaker |
| 8 | fake `/ready` returning 503 then 200 → reports ready only on 200 | readiness |
| 9 | shutdown → child gets SIGTERM, then SIGKILL after grace, pidfile removed | orphan prevention |
| 10 | **argv scan**: the spawn args contain the token in **zero** positions; the token is present only in the child env or a `0600` file | INV-12 |
| 11 | **log scan**: no emitted log line contains the hostname or an `https://` tunnel URL | INV-11 |
| 12 | a live pidfile pointing at a running fake child → killed before respawn | stale-child path |

**Live verification (separately authorised by George, INV-14):** `cloudflared tunnel login` → create + route → `tel daemon install` → reboot → confirm the hostname answers and one call connects with `publicBaseUrl` never edited.

---

## Seam left behind

| Artefact | Consumed by |
|---|---|
| **A permanent public hostname** | **H** (MCP-over-HTTP needs a URL that does not move), **R** (ElevenLabs agents call our https MCP endpoint as a tool source — D-19), **L–M** (inbound: a stable webhook target is the precondition) |
| Supervised process lifecycle + `tel daemon` | everything operational; the "turn voice on" one-liner |
| `renderPlist()` as a pure function | the Linux/systemd sibling if D-9's parking is ever lifted |
| Backoff + crash-loop breaker | reused for any supervised child (Phase N Worker deploys, cold-spawn caps in D-16) |
| `/ready` + `/healthz` aggregated status | **G / I / J** — the console/TUI/SPA "is voice up?" indicator |

## Blast radius

If this phase is wrong:

- **Hostname mismatch → every webhook 403s.** `validateTwilioSignature` runs against `publicBaseUrl` (`public-server.ts:130`, `:82`). Calls fail with no useful error anywhere. Step 2's `superRefine` exists solely to make this impossible.
- **Token in argv or logs.** A Cloudflare tunnel token is a live credential for George's zone, readable from `ps aux` by anything on the Mac. Unlike a leaked URL, it does not expire on restart. (The Twilio `SK…` leak from the previous cycle — O-8 — is still unrotated; do not add a second one.)
- **Crash loop.** `KeepAlive: true` + a config error = a process respawning every ~10 s forever, quietly. Detectable only if `daemon status` reports restart counts.
- **Orphaned `cloudflared`.** A stale child keeps the hostname bound while a fresh `serve` starts; traffic reaches a dead origin. Silent — the tunnel looks healthy from Cloudflare's side.
- **Two `serve` processes** (launchd's plus a terminal one) → two writers on the WAL DB, breaking INV-9. `daemon status` must make the launchd-managed PID obvious before anyone runs `serve` by hand.
- **Wrong daemon type.** LaunchDaemon instead of LaunchAgent → no keychain → every secret resolves `null` → `gateway.ts:69-74` throws on startup, forever, at boot.

## Open questions

| # | Question | Whose call |
|---|---|---|
| D-a | **Which George-owned domain/hostname**, and locally-managed credentials file vs remotely-managed token? Blocks Step 1 entirely. → new DECISIONS `## Open` row. | George |
| D-b | **LaunchAgent vs LaunchDaemon.** Agent = keychain works, dies at logout. Daemon = survives logout, cannot read secrets. Recommend Agent; this caps whether voice works when George is logged out. → new DECISIONS `## Open` row. | George |
| D-c | Supervisor placement: `serve` parents `cloudflared` (recommended, one lifetime) vs two independent plists (survives a `serve` crash, but "voice on" is two commands). | implementer / George |
| D-d | Should `serve` **refuse to start** when the tunnel never becomes ready, or start degraded and report it? Refusing is honest; degraded lets `doctor` and the console explain the problem. Recommend degraded. | implementer |
| D-e | Exact ingress shape for the locally-managed style — unknown; verify against `cloudflared tunnel ingress --help` + Cloudflare docs before writing any YAML. | implementer (verify) |
| D-f | `launchctl` verb set on this macOS (`bootstrap/bootout/kickstart/print` vs legacy `load/unload`), and `ThrottleInterval` semantics — unknown; verify against `man launchctl` / `man launchd.plist`. | implementer (verify) |
| D-g | O-6 (state/config dir rename during Phase A) collides here: the plist bakes absolute paths and the label. If the dir moves after `daemon install`, the agent points at nothing. Sequence the rename **before** the first install. | George (O-6) |
