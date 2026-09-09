# WALL-ST-E — Claude Company’s self-hosted executor

WALL-ST-E is the autotrading representative for your floor. The central Claude
Company site publishes authenticated research calls; it does not custody funds,
receive wallet keys, sign transactions, or know whether your executor is running.

The polling executor runs on a machine you control. **Installing it arms it**: one
command, and it asks you for what live trading needs. The wallet it creates is empty
and this installer never funds one, so nothing can move until you send it SOL
yourself. Pass `--dry-run` if you would rather watch it decide without arming it.
Browser signing and webhook execution remain disabled; the only live-capable path is
the local `poller.mjs` service.

Trading is risky, and these controls do not make the calls profitable. Use a new,
dedicated burner wallet and fund it with no more than you can lose.

## Install in one command

On a Mac, or on a Linux host you control (a small VPS is fine), paste one line and
answer one prompt:

```bash
curl -fsSL https://claudedotcompany.com/install.sh | bash -s -- --floor <YOUR_FLOOR_NUMBER>
```

**Both platforms are first-class and take the same command.** Everything except the
last step is one shared path with one set of guarantees — Node, the burner wallet, the
hidden secret prompt, the staged and per-file-checked release, the 0600 environment.
Only the supervisor differs:

| | Linux | macOS |
|---|---|---|
| Supervisor | systemd system unit `cc-executor` | per-user LaunchAgent `com.claudeco.wallste` |
| Installed by | this script, writing a hardened unit | [`macos-launchagent.sh`](#macos-launchagent-lifecycle), invoked by this script |
| Needs `sudo` | yes, for the system unit | **no**, nothing outside your home folder |
| Logs | `journalctl -u cc-executor` | `~/Library/Logs/ClaudeCompany/wallste.stdout.log` |
| Stop it | `sudo systemctl stop cc-executor` | `bash <release>/macos-launchagent.sh unload` |

Windows has neither, and is covered [under WSL2](#windows-install-under-wsl2) below.

**That one command arms it.** There is no rehearsal install to do first and no second
command afterwards. On the terminal it asks you for the published release commit it
must sign with, then walks you through two private RPCs and a Jupiter key, and then
makes you retype the new wallet's own public key before it will arm — see
[Explicit live installation](#explicit-live-installation).

**Arming is not funding, and funding is the switch.** The burner it generates starts
empty, and an empty wallet cannot trade. Nothing happens until you send SOL to the
printed address from a wallet of your own, which is a step this installer has no part
in and cannot take for you.

The installer will:

- generate a brand-new, **empty** burner wallet on that machine at
  `~/claudeco-executor/burner.json`, mode `0600`, and never transmit it anywhere;
- ask for the floor's executor feed secret through `/dev/tty` — never as a flag,
  because argv lands in your shell history and in the process list;
- offer to install a **private** copy of Node if the host has none in range: the
  official build, verified against nodejs.org's own `SHASUMS256.txt` before anything
  is unpacked, kept under the install directory. No `sudo`, no package manager, no
  shell profile edited, and any system Node left exactly as it is;
- run `node --check` on every staged file and `npm ci --ignore-scripts`, then hand the
  finished release to the platform's supervisor — a hardened systemd unit on Linux, or
  `macos-launchagent.sh install` and `load` on macOS. It refuses to install over a
  WALL-ST-E agent that is already running, rather than repointing it at a new wallet.

Ask the installer anything before you run it:

```bash
curl -fsSL https://claudedotcompany.com/install.sh | bash -s -- --help
```

`--help` prints the safe default, every flag, and where the key is written. If you
would rather read the whole thing first, download it, compare its SHA-256 with the
value shown beside the install button on the site, and run it from disk.

Watch what it decides — the installer prints the right one for your platform when it
finishes:

```bash
sudo journalctl -u cc-executor -f                                  # Linux
tail -f ~/Library/Logs/ClaudeCompany/wallste.stdout.log            # macOS
```

### Double-click install (macOS download)

`Install WALL-ST-E.command` is the same one-liner in a file a person can
double-click. It opens Terminal, says in plain words that this installs a bot which
trades real money and that funding the new wallet is the on switch, shows the
installer's SHA-256, asks for the floor number, and runs it.

macOS quarantines anything downloaded from a browser, so the first launch must be
**right-click → Open** (or `xattr -d com.apple.quarantine "Install WALL-ST-E.command"`
in Terminal) — a plain double-click will refuse with "unidentified developer".

The launcher passes a floor number and nothing else: it holds no credentials, no
wallet, no caps and no acknowledgement. Everything that makes the install real is
asked for by `install.sh` on the terminal, one value at a time. It asks for no
administrator password, because nothing on the macOS path needs one.

Two Mac-specific things worth knowing before you fund anything. A laptop that is
asleep is not trading — the runner keeps the machine awake on AC power and
[pauses entries on battery](#macos-launchagent-lifecycle) — so for a funded wallet an
always-on host is safer. And if a WALL-ST-E agent is already loaded on that Mac, the
installer stops before creating anything and tells you to unload it deliberately
first, rather than repointing a running executor at a new wallet.

### Prefer to clone it yourself?

Piping a script into a shell is a reasonable thing to refuse. Install from the exact
40-character release commit shown by the floor UI instead, and review the checkout
before running it:

```bash
git clone https://github.com/gtjvv976mb-netizen/Claude-Company.git
cd Claude-Company
git checkout --detach <PUBLISHED_COMMIT_SHA>
bash executor/install.sh --floor <YOUR_FLOOR_NUMBER> \
  --expected-commit <PUBLISHED_COMMIT_SHA>
```

This is no longer a *required* second act for live mode. Live still refuses piped or
mutable runtime downloads — the modules that sign are read out of that commit's own
Git blobs — but when this machine has no checkout of the commit you named, the
installer clones it and detaches at it for you, and then verifies it exactly as it
verifies one you cloned yourself: HEAD must equal your `--expected-commit`, the head
must be detached rather than a moving branch, and every runtime file must be clean
against it. A checkout you supply that is already detached at that commit is used as
it stands.

### Windows: install under WSL2

Windows has no systemd, so Git Bash, MSYS2 and Cygwin cannot run the executor —
the installer detects all three and says so rather than failing obscurely. WSL2 is
a real Linux host and everything above works there unchanged.

In PowerShell, as Administrator, once:

```powershell
wsl --install -d Ubuntu
```

Reboot if it asks. Then open the **Ubuntu** app from the Start menu and run this
inside that Ubuntu shell — not PowerShell, not Git Bash:

```bash
sudo apt-get update && sudo apt-get install -y curl
curl -fsSL https://claudedotcompany.com/install.sh | bash -s -- --floor <YOUR_FLOOR_NUMBER>
```

Two WSL2 facts worth knowing before you fund anything: closing the last Ubuntu
window stops WSL2, and a stopped WSL2 stops the executor; and Windows suspending
the VM has the same effect. For a wallet you intend to fund, a small always-on Linux
VPS is the safer host.

### Unattended feed authentication

For a scripted install, create a mode-`0600` secret file and add `--secret-file`:

```bash
umask 077
install -m 600 /dev/null ./claudeco-secret
${EDITOR:-vi} ./claudeco-secret
bash executor/install.sh --floor <YOUR_FLOOR_NUMBER> \
  --secret-file ./claudeco-secret
```

`CC_SECRET` authenticates the read-only floor feed. It is not a wallet key and
cannot move funds.

## The first-start rule

On its first successful feed read, WALL-ST-E records the newest delivery ID and
skips everything older. It does **not** replay calls that were published before the
poller started. This is true in dry-run and live mode.

After that cursor is established, only later deliveries are eligible. Do not delete
the state database to force a replay; reconcile the journal and wallet first.

## macOS LaunchAgent lifecycle

This is the supervisor behind the macOS install above, and it is also usable on its
own. `install.sh` does not reimplement any of it: on a Mac it prepares exactly what
this script requires — Node, the install directory, the locally generated 0600 burner,
the hidden secret prompt, the 0600 environment, the staged and per-file-checked
release — and then hands `macos-launchagent.sh` **absolute** `--executor-dir` and
`--env-file` paths for `install` and then `load`, in that order.

By itself the script creates no environment, wallet, journal, or live
acknowledgement, and it never funds anything. Run it directly when you already have a
configured executor directory. It consumes the existing owner-only
`.cc-executor.env`; it never sources that file through a shell:

```bash
chmod 600 executor/.cc-executor.env
npm ci --prefix executor --ignore-scripts
bash executor/macos-launchagent.sh install --executor-dir "$PWD/executor"
bash executor/macos-launchagent.sh load --executor-dir "$PWD/executor"
```

`install` only writes the plist. The separate `load` command validates the runtime,
requires the installed plist to match it byte-for-byte, and refuses to start while a
manually launched poller still owns the executor lock. It does not terminate that
process; stop it deliberately, verify it released the lock, and retry `load`.
The runner also rejects unknown environment names and any imported runtime file that
is symlinked, owned by another user, or writable by group/other. `LOCK_FILE`, if
present, must resolve exactly to `STATE_DB` plus `.lock`; alternate lock names are
refused so two pollers cannot mutate one journal.

`install` persistently disables the label before writing the auto-discovered plist, so
login cannot bypass the separate `load` preflight. `load` enables it only after the
conflict check and reports success only when the launched pid owns the canonical lock.
The agent then uses `RunAtLoad`, `KeepAlive`, a 15-second restart backoff, an absolute
working directory, and durable logs under `~/Library/Logs/ClaudeCompany/`. On macOS the
lock-owning Node runner also starts `/usr/bin/caffeinate -i -s -w` directly and verifies
that its exact child PID holds both no-idle-sleep and no-system-sleep assertions while
the host is on AC power. If the Mac moves to battery, the runner atomically creates and
validates the owner-only entry-pause sentinel but keeps the exact idle-sleep assertion
and lock-owning poller alive, so exits and reconciliation continue while the Mac remains
awake. AC restoration never removes that pause. Every launchd entry boundary also
re-proves AC plus both assertions synchronously before signing or disclosing bytes.
Losing the child identity, idle assertion, or an AC-side system assertion pauses first
and then restarts fail-closed. This does not change persistent Energy Saver settings,
and the assertion ends with the runner. Control the service without editing the
environment, wallet, journal, or safety sentinels:

If the configured entry-pause sentinel cannot be safely published, the runner creates
an owner-only `${LOCK_FILE}.sleep-assertion-fault` latch beside the canonical process
lock. The poller treats that latch as an entry pause, readiness refuses it, and the
monitor reports it as critical. No executor component clears the latch automatically;
an operator must repair the pause control, review the incident, and explicitly remove
that exact latch before entries can be reconsidered. If neither control can be written,
the supervisor retains its fsynced assertion-identity record; a restart cannot replace
that record until it first succeeds in publishing one of the durable entry blocks.
The same rule applies to an otherwise healthy runner stopping for any reason: a
handled signal, fatal poller startup, uncaught exit, or explicit unload publishes the
pause (or fault latch) before the assertion record can be removed. A clean unload
therefore leaves entries paused for the next explicit readiness review; no process
exit is treated as permission to resume exposure.

```bash
bash executor/macos-launchagent.sh status
bash executor/macos-launchagent.sh unload
bash executor/macos-launchagent.sh uninstall
```

`unload` persistently disables and stops only the supervised process; it does not close
an on-chain position or restart at the next login. `uninstall` requires an explicit
unload first and removes only the plist. Neither operation removes logs, state,
`PAUSE_ENTRIES_FILE`, or `HARD_STOP_FILE`.

For a live upgrade, never mutate the directory from which a running process imports.
Stage a complete, detached, versioned checkout first. The release workflow requires the
existing environment path explicitly, binds every tracked runtime file to the reviewed
commit, installs locked dependencies, and runs focused signing/supervisor tests before
one atomic rename makes the release visible:

```bash
RELEASE_SHA="paste-reviewed-40-character-commit-here"
LEGACY_EXECUTOR=/absolute/path/to/the/current/executor
ENV_FILE=/absolute/path/to/the/current/executor/.cc-executor.env
RELEASES_DIR="$HOME/Library/Application Support/ClaudeCompany/releases"

bash executor/macos-release.sh stage \
  --expected-commit "$RELEASE_SHA" \
  --env-file "$ENV_FILE" \
  --legacy-workdir "$LEGACY_EXECUTOR" \
  --releases-dir "$RELEASES_DIR"
```

`stage` prints the canonical entry-pause path, but never a credential. Create that exact
sentinel and wait for the current executor to report entries paused. Then explicitly
unload the existing LaunchAgent, or deliberately stop the known manual poller from the
terminal/service that started it. The updater never kills a PID and refuses adoption
while either the old configured lock or the canonical state lock still has a live owner.
With the old process stopped and the pause still present:

```bash
RELEASE_DIR="$RELEASES_DIR/$RELEASE_SHA"
bash "$RELEASE_DIR/executor/macos-release.sh" install \
  --expected-commit "$RELEASE_SHA" \
  --env-file "$ENV_FILE" \
  --legacy-workdir "$LEGACY_EXECUTOR" \
  --release-dir "$RELEASE_DIR"

bash "$RELEASE_DIR/executor/macos-launchagent.sh" load \
  --executor-dir "$RELEASE_DIR/executor" \
  --env-file "$ENV_FILE"

node "$RELEASE_DIR/executor/monitor.mjs" \
  --executor-dir "$RELEASE_DIR/executor" \
  --env-file "$ENV_FILE" --json

launchctl print "gui/$(id -u)/com.claudeco.wallste"
pmset -g batt
pmset -g assertions
```

`install` does not load the agent. It requires the pause sentinel and canonicalizes
relative wallet/state/control paths against the explicitly supplied old working
directory. It preserves an already configured `0.05`/`0.5`/`0.15`-or-lower raised-cap
tuple only when all three raw values and the existing wallet acknowledgement match the
current v2 ceremony exactly. A missing, partial, legacy-v1, mismatched, incoherent, or
out-of-range raise is normalized to the `0.005` SOL/trade, `0.01` SOL/rolling-24h
deployment, and `0.01` SOL rolling realized-loss entry-brake defaults; already lower
values stay lower. The migration never creates a raised-cap acknowledgement and updates
`EXECUTOR_SOURCE_COMMIT`.
The reviewed gross ATA-rent default is `4200000` lamports so one temporary WSOL ATA and
one destination ATA can be built; an explicitly lower `MAX_RENT_LAMPORTS` remains lower.
The old environment is retained beside it as an owner-only rollback file. Secret values,
wallet, journal, pause, and hard-stop files are never exposed or replaced; the migration
never raises exposure.
Keep entries paused until
the new monitor reports `safeToUnpause: true`; no release command removes that sentinel.

### Arming a reviewed cap profile on macOS

After versioned adoption, macOS operators can create the current v2 cap
acknowledgement locally. First unload the LaunchAgent and create the configured
entry-pause sentinel. The command below confirms that the login policy is disabled,
the canonical executor lock has no live owner, the pause is present, and the public
wallet derived from the protected keypair exactly matches `LIVE_TRADING_ACK`:

```bash
bash "$RELEASE_DIR/executor/macos-launchagent.sh" arm-caps \
  --executor-dir "$RELEASE_DIR/executor" \
  --env-file "$ENV_FILE" \
  --max-sol 0.05 \
  --daily-sol-cap 0.5 \
  --daily-loss-cap 0.15
```

`arm-caps` works only at a real local terminal. It prints the exact wallet-and-values
v2 sentence and requires the operator to type it completely; piped input, the revoked
v1 sentence, a different wallet, changed numeric text, a partial tuple, an incoherent
tuple, or a value outside the reviewed maxima is refused. On success it atomically
updates all three raw cap fields plus `LIVE_CAPS_ACK`, retains a mode-`0600` copy of the
previous environment beside it, starts no service, and leaves entries paused. It never
loads the service, removes a safety sentinel, funds the burner, or signs a
transaction. Keep the pause present, explicitly load the same pinned release, and only
then run the monitor against that live process:

```bash
bash "$RELEASE_DIR/executor/macos-launchagent.sh" load \
  --executor-dir "$RELEASE_DIR/executor" \
  --env-file "$ENV_FILE"

node "$RELEASE_DIR/executor/monitor.mjs" \
  --executor-dir "$RELEASE_DIR/executor" \
  --env-file "$ENV_FILE" --json
```

Consider removing the entry pause only if the running process reports the exact armed
caps and the monitor reports `safeToUnpause: true`. Loading is not permission to
unpause, and no command in this workflow removes the sentinel.

## Explicit live installation

Live mode requires all of the following:

- a dedicated burner wallet generated and held on the executor host;
- two private HTTPS Solana RPC endpoints from independent providers, each supplied from
  its own mode-`0600` file — or entered through the guided prompts below, which write
  exactly those files for you;
- a Jupiter API key, from a mode-`0600` file or the same guided prompts;
- the exact 40-character published commit, as `--expected-commit` or typed at the
  prompt — the installer never looks it up for you, because a commit chosen by
  whatever answered would be a release verifying itself against its own answer;
- per-trade, rolling deployment, and rolling-loss caps for a supervised canary; and
- a terminal acknowledgement made by retyping the displayed burner public key.

### The guided route

If you run the live install on a terminal and leave any of `--rpc-file`,
`--secondary-rpc-file` or `--jupiter-key-file` off, the installer walks you through
that credential instead of refusing. For each one it says what it is and why it is
needed, points at a provider with a free tier, reads the value **hidden** from
`/dev/tty`, and then **checks it against the provider before accepting it** — a real
`getLatestBlockhash` for each RPC, a real (taker-less, unsignable) price quote for
the Jupiter key. A value the provider rejects is never stored; you are shown the
provider's own error and asked again, up to three times.

Accepted values are written mode `0600` under `~/claudeco-executor`
(`.rpc-primary`, `.rpc-secondary`, `.jupiter-key`), so a later re-run is unattended.
Nothing you type is echoed, and no credential is ever passed as a command argument —
not to the installer, and not to `curl`, whose request is fed in through stdin
precisely so that an RPC URL never appears in `/proc/PID/cmdline`.

The wizard runs **only** in live mode and **only** when a terminal is present. A
`--dry-run` install needs no credentials at all, and a scripted live install with all
three files and `--expected-commit` never sees a prompt.

### Going live on macOS

A live install on a Mac takes the same flags and asks the same two questions, and it
additionally routes the adoption through
[`macos-release.sh`](#macos-launchagent-lifecycle) — the same versioned-release
workflow this project uses for its own executor. `install.sh` invokes it with absolute
`--env-file`, `--legacy-workdir` and release paths (relative ones are refused before
either script runs) and it does the rest itself: it clones the pinned commit, verifies
every runtime blob against that commit, runs the executor test suite, and only then
binds the stopped, entry-paused executor to the immutable release it built. Those
versioned releases live under `~/claudeco-executor/versioned-releases/<commit>/`, kept
separate from the installer's own `releases/` so nothing prunes one.

Because `macos-release.sh` requires an entry pause before it will bind a release, a
live macOS install comes up **entry-paused on purpose**. Review the wallet and the
monitor, then lift it deliberately:

```bash
rm ~/claudeco-executor/PAUSE_ENTRIES
```

`macos-release.sh` is used **only** on this route. It gates on a live environment —
its validator aborts with `versioned live adoption requires EXECUTE=1` and then
demands `LIVE_TRADING_ACK`, `JUPITER_API_KEY`, `SOLANA_RPC` and
`SOLANA_RPC_SECONDARY` — so a dry-run install cannot satisfy it, and the installer
does not try to. A default macOS install adopts its staged release through
`macos-launchagent.sh install` and `load` directly, and stays `EXECUTE=0`.

### The scripted route

Prepare the Jupiter key and RPC files without putting credentials in shell history:

```bash
umask 077
install -m 600 /dev/null ./jupiter-api-key
install -m 600 /dev/null ./primary-rpc
install -m 600 /dev/null ./secondary-rpc
${EDITOR:-vi} ./jupiter-api-key
${EDITOR:-vi} ./primary-rpc
${EDITOR:-vi} ./secondary-rpc
```

With no cap flags, a live install uses the canary defaults: **0.005 SOL per trade**,
**0.01 SOL deployed in every rolling 24-hour window**, and a **0.01 SOL rolling
realized-loss brake**. Deployment accounting includes finalized entry fees and fees
paid by failed on-chain attempts. The default live invocation needs no cap arguments:

```bash
bash executor/install.sh --floor <YOUR_FLOOR_NUMBER> \
  --live \
  --expected-commit <PUBLISHED_COMMIT_SHA> \
  --rpc-file /absolute/path/to/primary-rpc \
  --secondary-rpc-file /absolute/path/to/secondary-rpc \
  --jupiter-key-file /absolute/path/to/jupiter-api-key
```

Use genuinely independent providers for the two RPC files, not two
API keys or paths on the same provider. The secondary endpoint is read-only and is
used to prevent a missing or lagging primary history response from authorizing a
duplicate replacement transaction. Live installation refuses the public Solana RPC,
an omitted secondary endpoint, or endpoints with the same provider hostname.

The installer prints the dedicated burner’s **public** key and asks you to
retype it through the terminal. That exact value becomes `LIVE_TRADING_ACK`. The
service refuses live mode if the acknowledgement, wallet, API key, both private RPCs,
state database, or required file permissions do not pass startup checks.

An operator may deliberately raise the three money caps, up to the reviewed code
maxima of **0.05 SOL per trade**, **0.5 SOL daily deployment**, and a **0.15 SOL daily
realized-loss entry brake**. The brake stops future entries after recorded rolling
losses reach the threshold; it is not a guarantee that realized loss cannot overshoot
because fills, slippage, and fees remain uncertain. If any cap is above its canary
default, all three must be supplied together;
the daily deployment cap must also be at least the per-trade cap:

```bash
bash executor/install.sh --floor <YOUR_FLOOR_NUMBER> \
  --live \
  --expected-commit <PUBLISHED_COMMIT_SHA> \
  --max-sol 0.05 \
  --daily-cap 0.5 \
  --daily-loss-cap 0.15 \
  --rpc-file /absolute/path/to/primary-rpc \
  --secondary-rpc-file /absolute/path/to/secondary-rpc \
  --jupiter-key-file /absolute/path/to/jupiter-api-key
```

After the burner public key exists and the normal wallet acknowledgement succeeds,
the installer displays a second, versioned sentence naming that exact wallet and the
three literal cap values. It reads the sentence only from the local terminal and
stores the exact match as `LIVE_CAPS_ACK` in the owner-only environment file. A legacy
v1 sentence, a sentence for another wallet, a changed number, a partial set of raised
caps, or a non-interactive install fails closed. The installer does not accept this
acknowledgement as an argument and neither a browser nor the Claude Company server can
perform the activation.

`EXECUTE=1` by itself is not an activation procedure. Do not paste a private key,
Jupiter key, or executor feed secret into Claude Company or a command-line argument.
Keep the private RPC configuration on the executor host. Fund only the displayed
burner address, only after confirming the installed paths and dry-run output.

## What remains local

The host keeps:

- `burner.json`, the dedicated wallet key;
- the mode-`0600` environment file and API credentials;
- `STATE_DB`, the durable cursor, position record, and transaction journal; and
- the pause/hard-stop sentinel files.

The central site keeps none of those items. It cannot start, pause, or inspect the
local service, and the browser must not display “LIVE” without executor telemetry.
Verify the real mode, wallet address, signatures, and fills in the host logs and on a
Solana explorer you trust.

The legacy `executor.mjs` webhook adapter verifies signed event envelopes for dry-run
testing only. It cannot sign or broadcast trades. The browser transaction relay is
also disabled.

## Transaction safety and recovery

Live polling uses `jupiter.mjs` for Jupiter Swap API v2 order validation and execution
and `journal.mjs` for durable intent/attempt records. Before a transaction is signed,
the executor checks the intended wallet, mints, amount, fees, price impact, expiry,
resolved v0 program instructions, payer/signers, transaction size, and RPC simulation.
Both independent RPC providers must deserialize, validate, and simulate the exact same
unsigned bytes. Every writable address is then loaded as a direct, read-only static key
in one separate unsigned Memo simulation: no account batching, address lookup table,
signature, journal write, or broadcast path is involved. The same response must bind
every row to one context slot and internally consistent fee/pre/post balance evidence.
A second atomic snapshot after the swap simulation must preserve the same
authority/capability fingerprint. Routes that cannot fit the 1,232-byte snapshot packet,
or providers that omit the required evidence, fail the no-sign readiness gate rather
than weakening it. After the final scan, each provider must still report at least 32
blocks of order lifetime from chain-height evidence fenced to that scan slot.
A final entry order must still match the monitored authored entry zone; a price-only
exit needs two next-tick witnesses and the final executable order must still breach its
stored stop or target.

The first live canary accepts only Jupiter Metis exact-in routes and classic SPL Token
mints. Token-2022 routes fail closed. Source and destination custody must be the wallet’s
canonical associated token accounts, with no delegate, close authority, frozen state, or
unexpected writable wallet-owned token account.

The journal is written before submission. If submission has an ambiguous network
result, the executor reconciles the recorded signature and retries the same signed
attempt when safe; it does not silently create a second order. Confirmed entries and
exits are applied idempotently, using actual input/output amounts returned by Jupiter
and verified on chain.

Never delete `STATE_DB` or edit a journal row to clear an uncertain attempt. Engage
the hard stop, inspect the signature and wallet on chain, and reconcile the holding
before restarting. The executor manages only positions it recorded; unrelated wallet
assets are outside its book.

Entry orders keep the strict `MAX_PRICE_IMPACT_PCT` cap. Exit marks are still observed
when impact exceeds that entry cap so stop, age, and desk-exit policy cannot disappear
during a liquidity collapse. Signed exits use the separate
`MAX_EXIT_PRICE_IMPACT_PCT` emergency cap (50% by default). If an exit exceeds that cap,
the durable position is retained, new entries are blocked, and the host logs
`MANUAL EXIT REQUIRED`; the operator must reconcile or exit from the burner wallet.

## Pause and hard stop

The installer records explicit paths in the protected environment file:

- If the file named by `PAUSE_ENTRIES_FILE` exists, WALL-ST-E refuses new buys but
  continues monitoring, closing recorded positions, and reconciling pending attempts.
- If the file named by `HARD_STOP_FILE` exists, WALL-ST-E creates no new submissions,
  including automated exits. It still reconciles transactions that were already
  signed or submitted. Existing positions require operator supervision or manual
  management while the sentinel remains present.

The service also refuses to run a second live process against the same `STATE_DB`.
An active, unreadable, or invalid-owner lock fails closed. A lock whose recorded PID is
provably absent is atomically quarantined and reclaimed; competing restarts still resolve
to one owner. Never delete a lock manually while an executor may be alive.
Inspect `sudo journalctl -u cc-executor -f` after changing either sentinel. Stopping
the systemd service is the host-level emergency brake:

```bash
sudo systemctl stop cc-executor
```

Stopping the process does not close an on-chain position.

## Independent health monitor

Run the read-only monitor from a separate scheduler or terminal:

```bash
npm run monitor -- --executor-dir /absolute/path/to/executor
```

It checks the process-lock owner, SQLite integrity, pending transaction states,
position reconciliation flags, pause/stop files, authenticated feed lag, and the
server's copy of the executor heartbeat. Output is sanitized JSON; it never imports
the signer, prints credentials, changes controls, restarts the process, or submits a
transaction. Exit code `2` means critical/manual action, `1` means degraded, and `0`
means healthy or intentionally entry-paused.

An intentional pause remains reported as `status: "entries-paused"`; it is never
described as actively healthy. In that state only, `safeToUnpause: true` and
`unpauseReadiness: "ready"` certify that every other check passed, including the
exact LaunchAgent supervisor topology, canonical lock owner, working directory, AC
sleep assertion, journal wallet, configured source commit, and the running process's
byte-for-byte runtime fingerprint. For live mode it also reads the pinned Pyth SOL/USD
account through both configured RPC providers and requires a successful heartbeat probe
from the fixed WSOL-to-USDC Jupiter route. That probe must have used both RPC providers
within the last five minutes without signing, journaling, or calling Jupiter's execute
endpoint. A manual poller, missing sleep assertion, feed rollback, absent or stale
execution-readiness probe, or unavailable/stale/divergent oracle view blocks
`safeToUnpause` without printing an endpoint or credential. When no pause exists the
readiness value is `"not-paused"`, not a standing recommendation to change controls.

## Snipe-v3 policy and local execution guards

The server record and executor import the same `trade-policy.mjs` decision core:

- The desk’s explicit exit closes the recorded position in full only when its mint
  and `call_id` both match the originating call persisted with that position.
- On upgrade, a legacy position missing `call_id` is recovered from its exact durable
  entry intent when possible. If it cannot be proven, new exposure stays blocked and
  the next valid same-mint desk exit closes that legacy holding in full. This explicit
  risk-reducing fallback can exit early, but cannot open or enlarge exposure.
- The authored stop is enforced.
- At `1.35x`, the stop ratchets to breakeven.
- At `1.5x`, a 25% trailing stop begins ratcheting behind the high.
- Auto mode closes in full at the authored target or shared `2x` default, whichever
  arrives first. An explicit multiple such as `10x` overrides the authored target;
  a later desk exit still wins.
- An unresolved position reaches its age exit at 12 hours.
- Snipe-v3 does not emit a partial exit; legacy `SCALE_OUT_PCT` values are ignored.

The local executor adds signing-path guards around that core. Price-only stops and
targets need two consecutive local observations and a still-breached final executable
order; explicit desk, rug, and age exits do not wait for a price witness. The position
mark comes from the actual net SOL custody delta of a fully validated, unsigned on-chain
simulation, never from Jupiter's displayed `outAmount`. Both independent RPC providers
must simulate that same unsigned exit, validate the same custody account, and agree on
the proceeds within 1%; the lower result is used. If no valid executable mark can be
produced on two consecutive ticks, the executor freezes new exposure and latches a
risk-reducing exit; it does not silently reinterpret missing data as a hold. The final
exit may remain latched if no safe route can be built, requiring manual action.

Entries reconcile the feed's monitored USD mark with mint metadata that matches across
both RPCs, an independent Pyth SOL/USD anchor, and the final Jupiter order before any
signature is created. The executor reads Pyth's pinned, sponsored shard-0 SOL/USD
account through both private RPC providers. Both views must be fully verified, no more
than three minutes old, within 2% confidence width, and within 1% of each other. Jupiter
never supplies the USD anchor used to judge its own order. Two-of-two consensus is
deliberately fail-closed: after the bounded Pyth cache expires, one unavailable provider
can force risk reduction rather than leave price protection silently disarmed.

Sizing also applies the stop requirement, estimated round-trip costs, sample/Kelly
gate, per-name risk ceiling, book-heat ceiling, rolling 24-hour deployment cap and
rolling 24-hour realized-loss
limit, available balance, and maximum-open-position rule. These are loss controls,
not evidence of an edge.

## Configuration

| Variable | Default | Purpose |
|---|---:|---|
| `CC_SECRET` | required | Read-only floor-feed credential; store only in the protected env file |
| `CC_FLOOR` | required | Floor number bound to the feed |
| `KEYPAIR` | generated `burner.json` | Dedicated local wallet; must be mode `0600` |
| `EXECUTE` | `0` | `1` requests live mode but is insufficient without every other live gate |
| `LIVE_TRADING_ACK` | unset | Must exactly match the loaded burner public key in live mode |
| `LIVE_CAPS_ACK` | unset | Required when any live money cap exceeds its canary default; must be the installer’s exact wallet-and-number-bound v2 sentence |
| `JUPITER_API_KEY` | unset | Required locally for Jupiter Swap API v2 in live mode |
| `SOLANA_RPC` | public default in dry run | A private HTTPS provider is required in live mode |
| `SOLANA_RPC_SECONDARY` | required in live mode | Independent private provider for expiry, custody, and Pyth SOL/USD consensus checks; an outage fails closed or uses only the bounded Pyth exit cache |
| `SOL_USD_CACHE_MAX_AGE_MS` | `1800000` live ceiling | Maximum age of both the local observation and retained Pyth publish time before the exit-price cache fails closed |
| `STATE_DB` | installer-managed | Durable cursor, positions, transaction journal, and wallet binding |
| `PAUSE_ENTRIES_FILE` | installer-managed | Presence blocks new entries while allowing managed exits |
| `HARD_STOP_FILE` | installer-managed | Presence blocks new submissions while reconciliation continues |
| `MAX_SOL_PER_TRADE` | live `0.005` | Absolute input ceiling for one entry; acknowledged operator hard maximum `0.05` SOL |
| `DAILY_SOL_CAP` | live `0.01` | Rolling 24-hour deployment cap; acknowledged operator hard maximum `0.5` SOL and never below the per-trade cap |
| `DAILY_LOSS_LIMIT_SOL` | live `0.01` | Rolling 24-hour realized-loss entry brake, including failed-attempt fees; acknowledged operator hard maximum `0.15` SOL, not a guaranteed loss ceiling |
| `MAX_OPEN_POSITIONS` | policy default | Concurrent recorded-position ceiling |
| `SLIPPAGE_BPS` | policy default | Maximum requested swap slippage |
| `MAX_PRICE_IMPACT_PCT` | `5` | Strict maximum impact for a new entry |
| `MAX_EXIT_PRICE_IMPACT_PCT` | `50` | Emergency impact ceiling for a managed exit; above it requires manual action |
| `MAX_NETWORK_FEE_LAMPORTS` | `2000000` live ceiling | Absolute network-fee cap, checked before signing and at finality |
| `MAX_NETWORK_FEE_PCT` | `10` live ceiling | Network-fee cap relative to exact trade basis |
| `MAX_RENT_LAMPORTS` | `4200000` live ceiling | Gross account-rent cap for at most the canonical temporary WSOL and destination ATAs; independently bound to both RPCs' classic-token rent facts. Rent is not a network fee, and an explicitly lower value remains lower on upgrade |
| `MAX_ENTRY_ROUND_TRIP_LOSS_PCT` | `12` live ceiling | Maximum measured forward/reverse entry preflight loss |
| `MAX_ENTRY_MARK_AGE_MIN` | `15` | Maximum monitored USD-mark age at entry submission |
| `MAX_ENTRY_QUOTE_DRIFT_PCT` | `5` live ceiling | Maximum preflight/final executable USD-price drift from the monitored market mark |
| `MAX_ENTRY_PREFLIGHT_AGE_MS` | `90000` live ceiling | Maximum executable-entry preflight age before signing. The same budget as the entry window: `executor/test-entry-window.mjs` measured the preflight at 12 serial hops, 68s priced at this executor's own per-request deadlines, so a shorter cap would refuse a preflight the pipeline legitimately took that long to build |
| `MAX_EXIT_TRIGGER_AGE_MS` | `60000` live ceiling | Maximum price-exit trigger age before two fresh witnesses are required |
| `TRAIL_PCT` | `0.25` | Trail distance after the shared 1.5x arm |
| `MAX_AGE_HOURS` | `12` | Time exit used by snipe-v3 |

Do not hand-edit `LIVE_TRADING_ACK` or `LIVE_CAPS_ACK`. On Linux, re-run the reviewed
installer to change modes, wallets, credentials, RPCs, or caps. On an adopted macOS
release, use the stopped-and-paused `arm-caps` ceremony above for cap-only changes;
other configuration changes require a separately reviewed migration or reinstall. An
upgrade stages and validates a versioned release before stopping the active service,
checkpoints and backs up the journal, atomically switches the `current` symlink, and
restores the previous unit, environment, journal, and release if activation fails.

## Manual development and verification

For a local dry run from this directory:

```bash
npm install
umask 077
solana-keygen new -o ./burner.json
chmod 600 ./burner.json
CC_SECRET=replace_with_feed_secret CC_FLOOR=replace_with_floor_number \
  KEYPAIR=./burner.json EXECUTE=0 npm start
```

Run the policy, sizing, simulation, tuning, and installer tests before deployment:

```bash
npm test
npm run test:sizing
npm run simulate
npm run tune
npm run test:install
```

Synthetic tests and simulations do not establish live expectancy. A supervised
canary means watching the service, journal, wallet balance, order signatures, and
actual fills—and being ready to pause entries or stop the service.
