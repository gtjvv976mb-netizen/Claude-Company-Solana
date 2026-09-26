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

**A small Linux server you own is the 24/7 option.** The same command on a VPS installs
a systemd unit that restarts the bot on its own and never sleeps, and the key is
generated on that server and stays there — you hold it, not the desk. A laptop works
too, as long as it stays awake and on power.

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

### Where it looks for `.cc-executor.env`

`--env-file` is always obeyed exactly as given. Without it, the script looks for the
owner's `.cc-executor.env` in four places, in order, and takes the first regular
non-symlink file it finds:

1. beside the executor (`--executor-dir`, or the directory this script sits in)
2. one directory above it
3. two directories above it
4. `~/claudeco-executor/`

Places 2–4 must resolve **inside `$HOME`** — the script will not walk up out of your
home directory to find someone else's file. Place 1 is not confined, so an install that
keeps its environment beside its code anywhere on the disk keeps working. Whatever is
found is still handed to `validate`, which refuses any environment file that is not
mode 0600 and owned by you.

This exists because of the layout `install.sh` actually creates. Your environment goes
in `~/claudeco-executor/` and the code goes in a release **beneath** it, reached through
the `current` symlink — so

```bash
bash ~/claudeco-executor/current/macos-launchagent.sh load
```

runs a script whose own directory is `~/claudeco-executor/releases/<release>`, where an
environment file has never existed. Before this it defaulted there, refused, and said
your environment file was missing rather than that it had looked in the wrong place. If
none of the four has it, the refusal now prints every path it tried.

#### `load` must be run from the versioned release path, never through `current`

This is worth its own heading because getting it wrong takes the bot down, and the command
above is the shape people copy.

`macos-launchagent.sh` resolves its own directory with `cd` + `pwd -P`, which follows the
`current` symlink through to `releases/<release>`. So a `load` run that way renders a plist
naming **that** path, while the plist launchd already has installed names
`versioned-releases/<commit>`. `load` then compares the two byte for byte, finds them
different, and refuses — **every time, by construction.** It is not a flaky check and
re-running cannot help.

```bash
# the form that works on a live install
bash ~/claudeco-executor/versioned-releases/<full-commit-sha>/executor/macos-launchagent.sh load
```

`readlink ~/claudeco-executor/current` and the `ProgramArguments` in
`~/Library/LaunchAgents/com.claudeco.wallste.plist` will tell you which paths your install
actually uses. On 2026-09-18 the `current` form was given to this desk's owner as a
lightweight restart; the load failed as described and the bot stayed down, with entries
unpaused, until it was loaded from the versioned path. `buys`, `status` and `unload` are
unaffected either way — only the commands that render and compare a plist care.

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

## Reclaiming rent from empty token accounts

Every SPL token this wallet has ever held opened a token account, and each one locked
about **0.002 SOL** of rent to exist. Some venues close that account as part of the sell;
plenty do not. What they leave behind is money in your wallet that your wallet cannot
spend, and the pile grows one account at a time.

How much there is depends entirely on what you have traded, so **look before you assume
it is worth doing**. Two readings of the same reference burner on 2026-09-17, hours
apart: 82 empty accounts holding ~0.13 SOL in the morning, and 6 holding 0.0091 SOL after
a run whose venue closed its own accounts on the way out. Both are real; only the first
was worth a transaction.

```bash
cd ~/claudeco-executor/current
node reclaim-rent.mjs                 # look: how many, how much. Sends nothing.
node reclaim-rent.mjs --send          # close them and take the rent back
```

Options: `--keypair FILE`, `--rpc URL`, `--state-db FILE`, `--batch N` (default 12),
`--max N`, `--json`.

**What makes this safe is not the tool.** The SPL Token program refuses to close an
account that still holds a balance, on chain, whatever this process believed when it
built the instruction. The worst case of racing a live bot is a **rejected transaction**,
never a burned token. On top of that the tool skips:

- any account with a non-zero balance — one raw unit counts as held, there is no dust
  threshold;
- any mint with an intent in flight in the journal (`signed`, `submitted`, `confirmed`
  or `ambiguous`), so it cannot close an account out from under a buy mid-signature;
- wrapped SOL, which the swap path opens and closes inside a trade of its own.

It signs `CloseAccount` and nothing else, and the rent can only go back to the wallet
that owns the accounts. Safe to run while the bot is running: batches are small, and a
batch that loses a race is retried rather than the whole run. If the journal is not
readable it says so rather than quietly proceeding as though nothing were in flight.

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

### The buy switch

One command, either lane, no restart:

```bash
bash ~/claudeco-executor/current/macos-launchagent.sh buys off      # open nothing new
bash ~/claudeco-executor/current/macos-launchagent.sh buys on       # automatic again
bash ~/claudeco-executor/current/macos-launchagent.sh buys status
```

**OFF** stops WALL-ST-E taking the desk's calls and HAWK-AI taking launches. It touches
nothing already open: those positions still exit on their stop, their target, the
creator's exit or the clock. **ON** returns both lanes to automatic. The running bot
reads the sentinel on its next tick, so neither needs a reload.

It is a LOCAL switch, and that is the architecture rather than a gap. The hosted desk
delivers research events and never commands (DESK.md), so a remote party able to stop
this bot would also be able to silence it. The site *shows* the state — the heartbeat
carries `entriesPaused` and the floor's "New buys" chip reads OFF — and the operator's
own machine *sets* it.

`buys` moves only the ENTRY pause. Nothing in that script ever touches the hard stop
below, which blocks exits too and stays a deliberate act of its own.

### The sentinels underneath

The installer records explicit paths in the protected environment file:

- If the file named by `PAUSE_ENTRIES_FILE` exists, WALL-ST-E refuses new buys but
  continues monitoring, closing recorded positions, and reconciling pending attempts.
  **Every install and upgrade creates it**, so a new release comes up not buying until
  you lift it: `buys on` above, or `rm -f ~/claudeco-executor/PAUSE_ENTRIES`, or
  pass `--resume-entries` to the installer and it lifts the pause itself the moment
  the new release is the running one (never before, so a failed activation still comes
  up paused). The floor's "New buys" chip reads OFF while the file exists.
- **The supervisor writes that same file by itself whenever the host is on battery**, and
  it keeps writing it: the sleep-assertion watcher re-publishes the pause every 15
  seconds while battery lasts, and only the first one logs a line. So `rm` on battery is
  undone within 15 seconds, silently. Its content names the cause — `automatic pause:
  host is drawing battery power` — which is how you tell it from a pause you created.
  **Restoring AC does not clear it**: the watcher logs `AC sleep assertions restored;
  entry pause remains until explicit readiness review` and leaves the file, because a
  machine that just slept has positions nobody was watching. Lift it yourself with `rm`
  on AC, or restart the agent on AC and the supervisor lifts its own automatic pause
  once at startup (`entries re-armed`). `WALLSTE_ALLOW_BATTERY_ENTRIES=1` keeps entries
  armed on battery instead — the honest trade is in the log line it prints: the machine
  can still sleep on a closed lid or a flat battery, and a position open across that has
  no stop until it wakes. Carried across upgrades like the other dials.
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

## Taking every published call

By default the bot decides for itself whether a published call is worth buying: Kelly's
verdicts, the net reward-to-risk of the bracket, the per-name risk cap and book heat may
refuse a call or shrink it, and the route ladder refuses a coin whose trading costs
already sit at or below the authored stop. `ENTRY_MODE="take-every-call"` is the owner's
instruction to buy every call the desk publishes, at one fixed size, and to treat those
edge rails as advisory: each one still runs and is written to the log as a `WARN` line,
but none of them refuses.

What still refuses in that mode, because no instruction can spend money that is not
there or hold a position with no floor: a call with no stop, the rolling 24-hour
realized-loss entry brake, the open-position count, the daily deploy cap, the spendable
balance, the minimum viable size, the call-age and mark checks, and every custody, fee,
rent and price-impact rule on the transaction itself. The route's own caps (round-trip
loss and price impact) are never advisory.

Arming it is a sentence, like every other raise of risk here. Stop the service, add
three lines to the protected env file, and load:

```bash
# in $ENV_FILE
ENTRY_MODE="take-every-call"
FIXED_SOL="0.5"
ENTRY_MODE_ACK="I take every published call on <burner public key> at 0.5 SOL"
```

`FIXED_SOL` may not exceed `MAX_SOL_PER_TRADE`. The sentence must name the wallet that
signs and the exact `FIXED_SOL` figure; the bot refuses to start otherwise and prints
the sentence it expected. The boot log then says `ENTRY MODE take-every-call`, the
heartbeat reports the mode, and the WALL-ST-E tab's health grid reads `TAKES EVERY
CALL`. An upgrade carries the three lines forward. Remove `ENTRY_MODE` (or set it to
`risk`) and load again to return to risk-sized entries.

## Running with no loss brake, until the wallet is the stop

The realized-loss entry brake is the **tighter of two numbers**, and that is the whole
reason this section exists. `DAILY_LOSS_LIMIT_SOL` is an absolute figure in SOL.
`DAILY_LOSS_PCT_OF_EQUITY` is a share of the wallet balance, `0.20` by default. Whichever
is smaller wins, so it can only ever brake sooner.

That pairing is **self-tightening on a losing wallet**, which is what surprises operators:
the percentage falls as the balance does. At a 0.55 SOL bankroll the 20% default brakes at
0.11 SOL, which a single stop-out on a 0.5 SOL position clears — and because the brake is
a *rolling 24-hour* window, it then stays shut until those losses age out on the clock, not
until the wallet recovers. Nothing about the brake resets at midnight.

**Raising `DAILY_LOSS_LIMIT_SOL` on its own usually changes nothing**, because on a small
wallet the percentage is the half that is binding. Both have to be lifted:

**Two commands, and the second one is unavoidable.** The percentage is a setting, so it
rides the install line; the absolute figure is a money cap, so it does not.

```bash
# 1 — upgrade, turn the equity brake off, keep entries armed on battery, unpause
curl -fsSL https://claudedotcompany.com/install.sh | bash -s -- \
  --floor <N> --expected-commit <SHA> \
  --no-equity-brake --allow-battery-entries --resume-entries

# 2 — raise the absolute cap; COPY the sentence it prints, do not retype it
bash "$RELEASE_DIR/executor/macos-launchagent.sh" arm-caps \
  --executor-dir "$RELEASE_DIR/executor" --env-file "$ENV_FILE" \
  --max-sol <your per-trade size> --daily-sol-cap 1000 --daily-loss-cap 1000
```

`--no-equity-brake` writes `DAILY_LOSS_PCT_OF_EQUITY=0` and wins over whatever an upgrade
would otherwise carry forward. `DAILY_LOSS_LIMIT_SOL` is one of the three money caps and
is deliberately **not** settable from the install line: **an upgrade refuses to raise any
cap**, because re-pinning code and widening a money limit are different acts. `arm-caps`
is the only way, it works only at a real local terminal against a stopped and paused
executor, and it makes you retype a sentence naming the wallet and the exact figures. An
upgrade carries both settings forward once they are set.

The boot log tells you which half is binding, and says so plainly when neither is:

```
caps: 0.5 SOL/trade, 1000 SOL/rolling 24h deploy, realized-loss entry brake = 1000 SOL
  flat (DAILY_LOSS_PCT_OF_EQUITY=0 — no equity brake), 24 open (a sentinel — book heat
  and the wallet bind first)
realized-loss brake: LIFTED on both halves — the wallet's spendable balance is the only
  stop on losses.
```

**What this does and does not remove.** It removes the discretionary stop — the one that
says "you have lost enough for now". It removes no rail that protects the transaction or
the balance. Still refusing, on every entry, with the brake fully lifted: the spendable
balance after the fee reserve, the per-trade cap (a clamp, so an oversized `FIXED_SOL` is
cut to the cap rather than honoured), the per-name risk cap, book heat, the open-position
count, the minimum viable size, a call with no stop, and every custody, fee, rent and
price-impact rule on the transaction itself. The pause file and the hard-stop file both
still work. `executor/test-unbraked.mjs` drives each of those against a bot with the brake
lifted, so the list above is asserted rather than promised.

Understand what you are choosing: with no loss brake the bot will keep taking calls
through a losing streak until the balance can no longer fund an entry. That is the
intended behaviour of this setting, and the reason it is off by default. Fund the wallet
with what you are prepared to lose entirely, and use the pause file to stop it early:

```bash
touch "$INSTALL_DIR/PAUSE_ENTRIES"     # stops new entries, lets open positions exit
```

## Arming HAWK-AI, the launch sniper, with real money

HAWK-AI is the executor's second lane. It listens to pump.fun's own program logs over the
bot's RPC WebSocket (with the listing poll as corroboration), runs every new launch through
the entry contract in `snipe-entry.mjs`, and — when armed — buys on the bonding curve with
the program's own `buy_v2` instruction and sells the whole position with `sell_v2`. It never
routes through Jupiter: a launch is seconds old and has no route. The signing path is one
file, `executor/snipe-execute.mjs`, and the decision code in `snipe-lane.mjs` cannot reach
a key; the lane's own test scans it for one on every run.

What a buy is, end to end: gates (pause, hard stop, the launchd power proof, the journal's
exposure lock), the intent written to the journal as `planned`, one transaction (compute
budget, idempotent ATA create, `buy_v2`), simulated unsigned on **both** RPC providers with
the wallet and the token account returned afterwards — the spend may not exceed the ceiling
plus the fee and rent caps, the delivery may not fall short of the instruction, and the two
providers must agree within 1% — then signed, journaled under the sniper's own protocol
marker, and sent raw to both providers with preflight skipped. The fill is read from the
confirmed transaction's own balances and handed to the lane the moment the cluster confirms
it; finality is awaited in the background. A sell is the same path with the floor set from
the curve's own quote less a 10% tolerance. The position leaves in full at the take, the
stop, the creator's exit, or the clock (ten minutes by default). A curve that has graduated
to a pool is refused: that position must be sold by hand.

The wallet is one wallet. A sniper deployment counts in the same rolling 24-hour risk the
desk reads, and an unresolved intent on either lane freezes new exposure on both until
recovery resolves it.

### Before arming

- A live install: `EXECUTE=1`, `LIVE_TRADING_ACK` and `LIVE_CAPS_ACK` already armed as
  described above, two independent private RPC providers, and a release that ships
  `snipe-execute.mjs` (every release from this change on; `install.sh` validates the file).
- A stop you chose. The default 0.20x stop was derived for the 0.005 SOL canary and the
  arming checklist refuses to carry it unexamined onto a larger ticket. `SNIPE_STOP_FRAC`
  is the fraction of entry at which the whole position leaves; the fee rail also bounds
  how tight it can be for the size (at 1 SOL anything up to 0.996 is fundable).
- The sniper's own ceilings: `SNIPE_MAX_SOL_PER_TRADE` at most `1` SOL and
  `SNIPE_DAILY_SOL_CAP` at most `1000` SOL. The daily cap is charged for real once armed;
  it cannot be configured off on a lane that spends.

### The arming lines

Stop the service first — `unload` writes the entry pause — then add these to the protected
env file. The sentence is compared byte for byte against the one the lane prints for the
wallet that will sign, so type the numbers you set:

```bash
bash "$RELEASE_DIR/executor/macos-launchagent.sh" unload \
  --executor-dir "$RELEASE_DIR/executor" --env-file "$ENV_FILE"

# in $ENV_FILE
SNIPE_LANE="execute"
SNIPE_MAX_SOL_PER_TRADE="0.05"
SNIPE_DAILY_SOL_CAP="0.5"
SNIPE_STOP_FRAC="0.7"
SNIPE_TAKE_AT_ENTRY_X="2"
SNIPE_LIVE_ACK="I arm HAWK-AI v1 for <burner public key>: 0.05 SOL per launch, 0.5 SOL per day, sold in full at the take, the stop, the creator's exit or the clock"
```

Then load the same pinned release and read its log. An armed lane prints
`HAWK-AI ... EXECUTING for <wallet> through snipe-execute.mjs`; a refused one prints the
arming checklist item that failed, or the exact sentence it expected, and the launch lane
stays down while the desk keeps running. Remove `PAUSE_ENTRIES` only when that line has
been read — the pause blocks the sniper's buys exactly as it blocks the desk's, and
`HARD_STOP` blocks its sells too.

```bash
bash "$RELEASE_DIR/executor/macos-launchagent.sh" load \
  --executor-dir "$RELEASE_DIR/executor" --env-file "$ENV_FILE"
tail -f ~/claudeco-executor/logs/executor.log | grep -i "hawk\|snipe"
rm "$PAUSE_ENTRIES_FILE"    # when, and only when, the armed line has been read
```

`SNIPE_LANE="observe"` keeps the shadow book with no key in reach; `SNIPE_LANE="off"` (the
default) constructs nothing. The legacy `SNIPE_EXECUTE` flag is refused on sight.

### What the desk can see

The lane reports itself in the same heartbeat as the desk book, once a minute: its mode,
whether it is up, the feed's health, every open snipe (a mint, a size and two levels), and
the port's own counts of buys and sells confirmed, refused and failed. The HAWK-AI tab on
your floor reads that block — from your signed-in status, and from the public house book
for anyone else — so "is my sniper running" has an answer on the site rather than only in
`wallste.stdout.log`.

The part that matters for a floor you do not sit at: **the two ways the lane stops are
named there.** A lane that could not start at boot (a bad `SNIPE_*` value, a secondary
endpoint down) reports `failed-to-start` with the bot's own reason; a lane that disabled
itself after a fault with nothing open reports `disabled`. Before this, both were one
line in a log on the operator's machine, and the desk went on reporting the floor healthy
because the desk was. A lane that faults *with a position open* reports `faulted` with
its retry count — it keeps trying rather than abandoning the bag, and now says so.

### Where to check what it made

The same heartbeat carries **HAWK-AI's book**: every closed trade with the realised SOL
beside it, plus the running total, the wins, the losses, and the count of closes it could
not price. The HAWK-AI tab renders it under the open positions — a gain in green, a loss
in red, and each row's reason (`take`, `stop`, `creator_exit`, `clock`) with the size it
was made on.

Three things about that number are deliberate:

- **It is read from the journal, not from the lane.** The lane's counters live in memory
  and a restart zeroes them. The book is a SQL read of `state='accounted' AND
  kind='snipe_exit'`, so it survives restarts, upgrades and reinstalls.
- **It is the risk ledger's own arithmetic**, joined from `risk_events` rather than
  recomputed — net of the network fee and of the basis the sale closed against, pro rata if
  the sale was partial. The board and the desk's rolling risk cannot disagree, because
  there is only one calculation.
- **It is the sniper's alone.** Both lanes share one wallet and one journal, so the read
  filters by intent kind: a desk exit never lands in HAWK-AI's book, and vice versa.

A close the bot cannot price reads as **"not read"**, never as zero — zero is a trade that
broke even. And because the read is capped, the tab says "Counting the N most recent"
whenever the window is smaller than the full count.

Everything on it is checkable on-chain: each row is one confirmed sell, and the journal
holds its signature.

### Mayhem coins, and the half of the market that was invisible

pump.fun keeps **two disjoint pools of fee recipients**, and every coin belongs to exactly
one. Which pool is the `is_mayhem_mode` byte on the coin's own bonding curve. A coin
refuses every recipient from the other pool — `NotAuthorized`, error 6000, thrown in the
program's `fee_recipient.rs`, at a different source line in each direction.

The adapter used to merge the two into a single list of sixteen and always take the first,
which is always a standard recipient. So **every mayhem launch was refused**, at
simulation, before anything was signed:

```
refused at simulation_failed: {"InstructionError":[3,{"Custom":6000}]}
AnchorError thrown in programs/pump/src/fee_recipient.rs:19. Error Code: NotAuthorized.
```

Nothing was ever at risk — the refusal happened before signing, and a refused launch costs
nothing. But it was roughly half of everything the feed produced, and the log gave no hint
that the other half was working fine.

The sets are now read separately and narrowed by the coin before a recipient is chosen,
on **both** legs. The exit matters more than the entry: a mayhem coin bought with the right
recipient and sold with the wrong one is a position that cannot be closed.

The measurement is in `PUMPFUN_FEE_RECIPIENT_POOLS` — the same buy simulated sixteen ways
against live curves, plus the 30 landed mainnet transactions in the encode fixture, where
22 paid a standard recipient, 8 paid a mayhem one, and none of the 17 mints ever paid into
both.

### Coins this lane cannot pay for

pump.fun curves may be quoted in a mint other than SOL. Measured on mainnet 2026-09-17:
live launches quoted in **USDC** and in **ORE** arrived in the feed minutes apart.

WALL-ST-E's launch lane is denominated in SOL end to end — the ticket is
`SNIPE_MAX_SOL_PER_TRADE`, the brake is `SNIPE_DAILY_SOL_CAP`, the balance gate reads
lamports, and the journal books the result in lamports. There is no path that spends USDC,
and the burner holds none.

Those launches are now refused locally, by name, at the new **`quote_not_sol`** gate,
before an instruction exists. Before it, the curve decoder reported every curve as
SOL-quoted, so the buy named wrapped SOL as `quote_mint`, derived every quote account from
it, and the chain answered:

```
{"InstructionError":[3,{"Custom":6004}]}
AnchorError caused by account: bonding_curve. Error Code: MintDoesNotMatchBondingCurve.
```

An opaque on-chain failure, on a coin that was never buyable. The gate makes the reason
readable and costs nothing.

### Only launches that name a social

`SNIPE_REQUIRE_SOCIALS` (**on by default**) refuses any launch whose metadata names no
twitter, telegram or website. A pump.fun `create` carries a metadata uri; a deployer who
filled in one of those fields spent thirty seconds more on the coin than one who did not.

It claims nothing beyond that. The link is never followed, scored, or asked about — a
link is trivially faked and may point at an account three minutes old. What it filters is
the **floor of effort**, which on a launch feed is most of the volume.

Three things about how it works are deliberate:

- **The request rides alongside the account read**, not after it, so the filter costs the
  slower of the two rather than their sum. With the filter off, no request is made at all.
- **It fails closed.** An unreadable document refuses exactly like an empty one — a filter
  that opens when it cannot see is not a filter. The two say different things in the log,
  though: `no_socials` is a fact about the coin, `fetch_timeout` is a fact about your
  gateway.
- **The uri is attacker-chosen.** Anyone can launch a coin for a fraction of a SOL, so
  anyone can choose what this bot is asked to fetch, from a machine holding a funded key.
  Only `http`/`https` are fetched — never `file://` or `data:` — there is a hard deadline,
  and the body is abandoned mid-read once it passes 64 KB rather than after.

| dial | default | what it does |
|---|---|---|
| `SNIPE_REQUIRE_SOCIALS` | `1` | `0` turns the filter off entirely |
| `SNIPE_SOCIALS_TIMEOUT_MS` | `1500` | how long to wait for the metadata host |

If your log fills with `no_socials`, that is the filter working. If it fills with
`fetch_timeout` or `fetch_failed`, that is your metadata gateway, and the bot is refusing
launches it could not check rather than guessing at them.

### What 58 real trades changed

HAWK-AI's first 58 closed round trips were read back off mainnet on 2026-09-17 — the whole
record, 290 of 290 transactions, nothing sampled. It went **10 up, 48 down, −1.58 SOL**,
with an average winner of **+75%** and an average loser of **−22%**. Two facts in that
record were strong enough to change the code.

| hold time | n | won | net SOL | average |
|---|---|---|---|---|
| 0–30s | 32 | 25% | −0.88 | −2.3% |
| 30–60s | 3 | 0% | −0.13 | −12.4% |
| 60–120s | 2 | 100% | +0.34 | +42.9% |
| 120–300s | 3 | 0% | −0.28 | −23.6% |
| 600s+ | 18 | **0%** | −0.63 | −10.2% |

**Eighteen positions ran to the old ten-minute clock and not one of them won.** Meanwhile
every large winner resolved fast: +191% at 4s, +148% at 7s, +140% at 18s, +84% at 86s.

So there is now a **stall exit**: a position that has not got above `SNIPE_STALL_AT_X` ×
entry within `SNIPE_STALL_MS` leaves, and the time-stop backstop drops from ten minutes to
three. A launch entry's thesis is that it moves *now*, and a flat position at ninety
seconds has falsified that while it is still cheap to say so.

| dial | default | what it does |
|---|---|---|
| `SNIPE_STALL_MS` | `90000` | how long a launch gets to move; `0` turns the stall off |
| `SNIPE_STALL_AT_X` | `1.0` | the multiple of entry it has to clear |
| `SNIPE_TIME_STOP_MS` | `180000` | the backstop for a position that is alive but drifting |

The second fact is **size**, and it is deliberately not code:

| entry size | n | won | net SOL |
|---|---|---|---|
| 0.05–0.15 SOL | 1 | 100% | +0.22 |
| 0.15–0.25 SOL | 8 | 25% | +0.12 |
| 0.25–0.35 SOL | 19 | 21% | −0.33 |
| 0.35 SOL+ | 30 | 10% | **−1.58** |

Every SOL of the net loss sits in the largest bucket, and the two smallest buckets are net
positive. The plausible mechanism is impact: a big clip on a thin new curve moves the
price against itself, so the position starts deeper underwater and needs a bigger move
just to break even. That is a reason to lower `SNIPE_MAX_SOL_PER_TRADE` — an operator's
money decision, and not one this repository makes for you.

**None of this claims to have found the optimum.** It is 58 trades from one bot over one
day: enough to say "18 for 18 is not noise", not enough to tune a constant to the minute.
The dials exist so the next 58 can move them.

### The first six trades after those changes

Read back the same way later the same day — the whole record again, 304 of 304
signatures, nothing sampled. Six round trips closed under the socials filter, the stall
exit and a 0.1 SOL clip:

| | before | after |
|---|---|---|
| closed | 58 | 6 |
| record | 10 up / 48 down | 1 up / 5 down |
| **win rate** | **17%** | **17%** |
| net | −1.5793 SOL | −0.0693 SOL |
| per trade | −0.0272 SOL | −0.0116 SOL |
| average loser | −21.5% | −16.7% |
| reached the 600s bucket | **18** | **0** |

**The stall exit does what it was built to do.** The bucket that was 18 trades and zero
wins is empty; nothing now holds past the 120–300s band. That is the one claim this
sample supports.

**The socials filter has not moved the win rate.** 17% before, 17% after, one win in six.

**The loss per trade more than halved, and that is arithmetic rather than edge.** The
clip went from 0.35+ to 0.1; a smaller bet loses less. The average loser improving from
−21.5% to −16.7% is the stall exit cutting losers sooner, but on five losers that is
noise, not a finding.

**Six trades says nothing about entries, which is where the problem is.** All four
post-change losers sat in the 120–300s band at −19%: cut earlier, still picked wrong.
Neither of these changes touches entry selection, and 48 losers in 58 was an entry
result. And note the size table above ages badly — the 0.05–0.15 SOL bucket was one
trade at +0.2188 and is now seven at +0.1495. Still positive, but it was never evidence
that small size wins.

### What the coins actually did, and why the entry cannot be fixed by going faster

The realised book says what the bot *captured*. It does not say what the coins *did*, and
those are different questions with different fixes: if a coin runs 3× and you exit at +5%,
the exit is wrong; if it never moves, the entry is.

So each of the 64 coins was priced off its own curve's trade events after the fill —
sampled (a median 22 of 49 trades per curve), which makes every "reached X" count a
**floor**, never a ceiling.

| how high it went after the fill | coins |
|---|---|
| 1.05× | 48/64 (75%) |
| 1.2× | 35/64 (55%) |
| **1.5×** | **28/64 (44%)** |
| 2× | 16/64 (25%) |
| 3× | 4/64 (6%) |

**Forty-four per cent of these coins went up 50%, and the bot realised +50% on five of
them.** Restricted to peaks that came strictly *after* the fill — the only ones that were
ever sellable — 12 runs reached 1.5× and the bot took it on 4, realising a mean of −19.1%
on the 8 it missed. That is what `SNIPE_TAKE_AT_ENTRY_X=1.5` is for, and on this record it
is worth about +0.24 SOL at a 0.1 SOL ticket.

#### The speed thesis does not survive our own record

The industry answer to a losing sniper is latency: Yellowstone gRPC at 5–20 ms instead of
`logsSubscribe` at 150–300 ms, Jito bundles, multi-relay submission, landing in slot 0
where the quoted prize is 20–60% of the upside. This bot is on the slow path by
construction — `web3LogsTransport` → `connection.onLogs()`, a two-endpoint account read
before deciding, and a plain `sendRawTransaction`. Measured against the curves: **median 5
seconds late, median 12 buyers already ahead.**

Being late is real. It is not what is costing the money:

| seconds late | n | won | mean realised |
|---|---|---|---|
| under 3s | 9 | **0%** | −18.5% |
| 3–6s | 25 | 20% | −2.6% |
| 6–10s | 20 | 10% | −23.4% |
| 10s+ | 10 | **40%** | **+34.0%** |

The fastest entries were the worst and the slowest were the best. The plausible mechanism
is the one the rug literature describes: the launches reachable inside three seconds are
the ones already bundled, and arriving right behind the bundle makes you its exit
liquidity.

#### Nothing observable at entry orders the outcome

Spearman rank correlation against realised return, n=64. At this sample size |ρ| under
about 0.25 is indistinguishable from noise:

| signal | ρ |
|---|---|
| buyers ahead of us | +0.109 |
| seconds late | +0.083 |
| trades on the curve | −0.126 |
| peak reached after entry (*not an entry signal*) | +0.199 |

**This bot cannot currently pick winners, and buying faster hardware would not change
that.** The coins that reach 1.5× average +6.8% realised and the ones that do not average
−15.3% — a real split, and one knowable only after the fact. It is an exit rule, never an
entry one.

#### So the exit ladder is the whole lever, and it is not enough

Modelled over the same 64 trades, taking at 1.5× whenever the coin got there:

| time stop | late runs caught | total realised |
|---|---|---|
| as it happened, no take | — | −361% = −0.361 SOL |
| 90s / 180s | 8 of 12 | −286% = −0.286 SOL |
| 300s | 9 | −231% |
| 600s | 11 | −182% |
| no clock | 12 | −122% = −0.122 SOL |

Two things have to be said about that table. The longer rows are **optimistic**: they keep
each non-runner's actual result and do not model the extra bleed of holding it longer, and
the first reading of this record found the 600s+ bucket was 18 trades and zero wins. And
the stall exit fires at 90s on anything not above entry, so it pre-empts the clock for
exactly the late runners the longer stop is meant to catch.

**Every variant in that table still loses money.** The exits stop the bleeding; they do not
create an edge. An edge has to come from entry selection, and nothing measured here
provides one.

#### The one honest lead left

`creator_profile` and `launch_share` — creator allocation and how much of the opening quote
was bought before us — are the two filters the rug literature names, they are already
implemented as gates, and both are `undefined` by default, so they measure and never kill.
That default is deliberate: *a number is not evidence until it has been run against a case
whose answer is already known.* There are now 64 known answers, and the shadow book has
been recording both measurements the whole time. **Grading those two gates against this
record is the next real experiment** — not a faster feed, and not a threshold copied from
a blog.

### The fast wire: a Yellowstone gRPC source

The lane has always had two sources — a websocket `logsSubscribe` on the pump.fun program,
and a 5-second HTTP poll of the listing as corroboration. There is now a third, off by
default: a Yellowstone Geyser stream, pushed from a validator's own plugin rather than
fanned out through an RPC node's subscription machinery. Helius calls theirs **LaserStream**
and includes it in the Business plan; any Yellowstone endpoint works, because the wire
protocol is the same.

Two environment variables arm it, and they must be set together:

```bash
SNIPE_GRPC_URL="https://laserstream-mainnet-<region>.helius-rpc.com"
SNIPE_GRPC_TOKEN="<your Helius API key>"
SNIPE_GRPC_COMMITMENT="processed"   # optional; processed is the default, and the only
                                    # level a sniper can use
```

Pick the region closest to the machine actually running the bot — the entire reason to buy
this endpoint is milliseconds, and a transatlantic hop gives back more than the feed saves.

**These are not the desk's credentials and must never be set to them.** `CC_API`,
`CC_SECRET` and `CC_FLOOR` authenticate this bot to *its own desk*. `SOLANA_RPC`,
`SOLANA_RPC_SECONDARY` and this pair authenticate it to *a data provider*. They are
separate credentials with separate blast radii, and the launchd runner passes each through
by name for exactly that reason.

The source is **added, never substituted.** The websocket and the poll stay where they are,
because the only way to learn whether the fast wire is worth its price is to let it race
the cheap ones. That answer is `firstShare` in the heartbeat's `sources` block — the share
of launches each source told us about *first* — and it does not exist if the loser is
unplugged. If gRPC takes most of the firsts by a wide margin, the endpoint is earning its
money. If the 5-second poll is still winning, the problem was never the feed.

Three things about how it is built are worth knowing before trusting it:

- **No new dependencies.** `@grpc/grpc-js` plus `@grpc/proto-loader` is roughly fifty
  transitive packages, and this repository's production deploy runs `npm ci && npm test` as
  its build command. So `grpc-wire.mjs` implements the protobuf wire format and gRPC's
  length-prefixed framing directly on `node:http2`. Both are specifications rather than
  schemas, and both are proven offline — by round-trip, and by chunk boundaries chosen to
  be hostile.
- **The field numbers are copied, not remembered.** Every constant in `snipe-grpc.mjs`'s
  `FIELDS` table came out of the published `geyser.proto` and `solana-storage.proto`, and
  each is asserted as a literal in `test-snipe-grpc.mjs` as a tripwire on the next edit.
  Memory says `account_include` is field 4. It is 3.
- **The mint parser is not new.** A Geyser transaction update carries `meta.log_messages` —
  the same lines the websocket delivers — so the venue's own `noticesFromLogs`, already
  pinned against bytes a real pump.fun create emitted, does the parsing on both routes. The
  new source adds a *transport* risk and no *parsing* risk, and a launch found here decodes
  to exactly the notice the socket would have produced, which is what makes them comparable.

What it has **not** done is run against a real endpoint from inside this repository. There
is no Geyser server in CI and no credential in the tree. So the transport carries a
self-check: if fifty updates arrive and not one of them names a oneof branch this build
knows, it fails loudly with `schema_mismatch` rather than sitting there looking healthy and
delivering nothing. Being wrong is survivable. Being wrong and silent is not — a feed that
has gone quiet is indistinguishable from a quiet market from every other angle.

And it is worth saying plainly, next to the measurements above: **a faster feed is not a
fix for this strategy.** On the burner's own 64 trades, entries under 3 seconds won 0% of
the time for −18.5% while entries 10 seconds and later won 40% for +34.0%, and no entry
signal ordered the outcome at all. What this source buys is the *ability to test* the
latency hypothesis against the cheap sources it races. It does not buy an edge, and nothing
here should be read as claiming it does.

### The fee lane — the business, as opposed to the marketing

Measured across 26 of bagworkagent.fun's agents and 362 closed trades, their best performer to
their worst:

| source | total |
|---|---:|
| Trading | **−0.077 SOL** |
| Creator fees | **+14.515 SOL** |
| Level rewards | +0.620 SOL |

21% win rate. Their #1 agent displays +15.6 SOL and is −0.105 on trading. **Not one agent in
that system makes money trading.** Every SOL of profit is the pump.fun creator fee on the coin
the agent itself launched: the trading makes the coin worth watching, the watching makes volume,
the volume makes the fee. The bot is the marketing. This lane is the business.

```bash
FEE_CLAIM=dry                  # read both vaults every 30 min, record what it WOULD claim
FEE_CLAIM_CREATOR=<wallet>     # defaults to the desk's own wallet on a live install
```

It runs on its own timer, deliberately independent of both the desk and the sniper: it earns
whether or not either is running, and it cannot take either down.

#### The number this desk refuses to produce

Their `pnlSol` **adds claimed fees to trading P&L.** That is how a bot losing every round trip
displays +15.6 SOL, and it is not a display bug — it is the mechanism by which a losing strategy
survives contact with its owner. Nobody switches off a bot showing +15.6.

So fee revenue is written to **its own file** — `<state-db>.fees.jsonl`, separate from the
journal the trading path writes. Not a flag on a shared row, not a column somebody could sum by
accident: a different file, because a rule enforced by physics survives edits that a rule
written in a comment does not. `feeSummary()` reports the two figures side by side and has no
`total`, no `pnl` and no `net` field. The test asserts their absence by name.

#### It will not claim what it cannot keep

The claim instructions carry no amount, so claiming an empty vault costs a signature and a
priority fee to move zero — and would then be booked as revenue of zero while the fee left the
wallet. Every decision is made on lamports **net of what the transaction costs**, against a
default floor of 0.002 SOL (roughly twenty times a claim's own fees), and a skip prints the whole
arithmetic: gross, the rent that cannot move, the fees, the net, and the floor.

Three distinctions the lane keeps that a simpler one would collapse:

- **Unreadable is not empty.** An unreadable vault skips with clause `unreadable` and retries;
  an empty one skips with a measured zero. A lane that confused them would stop claiming at the
  first RPC hiccup and never say why.
- **Rent is not revenue.** The curve's creator vault is a data-less system account, so its last
  650,240 lamports cannot move. That number was **measured on mainnet**
  (`getMinimumBalanceForRentExemption(0)`), not remembered — it was written as 890,880 from
  memory first, and the chain was asked before it shipped. The pump-amm side gets no such
  deduction, because the claim closes that token account and its rent comes back in the same
  transaction. (One operational consequence: the wallet must be able to cover ~0.0015 SOL of
  token-account rent for the length of one transaction, even though it returns.)
- **What landed is not what was estimated.** The submitter reports the lamports the wallet
  actually gained; the estimate is kept beside it, never in place of it. A claim whose amount
  cannot be reported is booked as unknown and **counted**, so `feeSol` can never quietly be a
  subset of what arrived while looking like all of it.

`HARD STOP` refuses a claim — a claim is a signature, and the owner's instruction has no
exception for the profitable path. `PAUSE ENTRIES` does not: it stops new exposure, and a claim
takes money in.

#### Why `FEE_CLAIM=live` is refused, permanently

It is refused by name, and this is a settled design rather than a gap.

A coin's creator fee is paid to the wallet that **created the coin** — for `$CLAUDECO` that is
`3J57tqAJqRmSBn1ZYDu9JpMMyTfBHdcGGwECiPQeiji3`, not the burner this installer generates. The
burner's entire security story is that the only key on that disk is one generated there and funded
deliberately; a real creator wallet sitting beside it would widen the blast radius of everything
else on the machine for the sake of a claim that happens a few times a month.

bagworkagent.fun's server holds its agents' keys and signs for them. This desk does not, and
neither does the bot. The split is:

| who | does what |
|---|---|
| the bot | **reads** both vaults on a timer and reports what is claimable |
| the desk | **builds** the unsigned claim, from the layout proved against three landed transactions |
| the owner | **signs** once, in their own wallet, at `/fees.html` |

So `FEE_CLAIM=dry` is not a rehearsal mode — it is the mode this lane runs in for good. Set
`FEE_CLAIM_CREATOR` to the creator wallet you want watched (it need not be this machine's wallet,
and for the house coin it is not), and the claimable figure rides the heartbeat to the desk and onto
the agent page.

```bash
FEE_CLAIM=dry
FEE_CLAIM_CREATOR=3J57tqAJqRmSBn1ZYDu9JpMMyTfBHdcGGwECiPQeiji3
```

All three are **validated at startup** and refused by name: a creator that is not a Solana
address, an interval that is not a whole number of milliseconds of at least 60000, or a floor
that is not a whole number of lamports. (`FEE_CLAIM_INTERVAL_MS=30m` used to parse as NaN, which
`setInterval` treats as ~1 ms — an RPC flood on the connection the trading path shares.) A read
where one vault answered and the other did not is `unreadable`, never "the half that answered
is all there is".

What the agent page shows is two separate things: **claimed** — what landed, which is a dash on
this desk because the owner signs and the desk does not record it — and **waiting**, what the
last read found in the vaults. Waiting is not revenue and is never summed into anything.

The claim itself is two clicks at `solana.claudedotcompany.com/fees.html`: connect the creator
wallet, sign. The page refuses to offer a claim from any other wallet, because only the creator's
signature can send it and finding that out on chain is a worse way to learn it.

### The market floor — the biggest change to what this bot buys

bagworkagent.fun's agents will not touch a token under an hour old, under $30,000 of
liquidity, under $50,000 of 24-hour volume, or under a $50,000 market cap. Those four numbers
are theirs, read out of their own running configuration, and they are worth copying for one
reason: **they refuse almost exactly the population HAWK-AI currently buys.**

This desk's own record says that population loses money. 64 real trades, −0.361 SOL, 5
winners. Entries under three seconds won 0% of the time for −18.5%; entries at ten seconds and
later won 40% for +34.0%. No entry signal ordered the outcome, and fees were about 45% of the
average loss. Every one of those numbers says the same thing: a coin nobody has traded yet has
no demand to measure, so there is nothing to be right about. A floor is the opposite bet — it
refuses to be first and insists on evidence.

```bash
SNIPE_MARKET_FLOOR=curve      # the two of their four a bonding curve can meet — RUN THIS ONE
```

| Variable | Their value | `curve` | Purpose |
|---|---:|---:|---|
| `SNIPE_MIN_AGE_HOURS` | 1 | 1 | The coin must have existed this long |
| `SNIPE_MIN_LIQUIDITY_USD` | 30000 | — | Real SOL in the curve — what a seller can actually get out |
| `SNIPE_MIN_VOLUME_24H_USD` | 50000 | 50000 | Traded volume over the last day |
| `SNIPE_MIN_MCAP_USD` | 50000 | — | Market capitalisation |

#### Why not `bagwork`: two of their numbers are out of reach on a curve

`SNIPE_MARKET_FLOOR=bagwork` loads their four numbers literally, and **on this desk it admits
nothing.** Their floor was written for coins that bonded long ago; this desk can only buy on a
bonding curve, and a standard curve graduates at **85.005 SOL** of real reserve — about **$10,300**
at the SOL price measured on 2026-09-26 ($121.69). Their $30,000 liquidity bar needs SOL above
~$353 for *any* curve to meet it. Their $50,000 cap is reached only by the last buy before a coin
leaves the curve for good (~410.9 SOL of cap at graduation).

Measured the same day over the 70 most recently traded coins: 25 were on a curve, the deepest
held 68 SOL, the richest was a $36k cap, and none of the five over an hour old cleared $50k of cap.
Volume is different — on-curve coins did $110,756 (2.4 h old), $97,857 (10.2 h) and $69,878 of
24-hour volume — so the two thresholds a curve *can* meet carry the bet, and that is the `curve`
preset. `bagwork` stays, literal, for the day this desk can trade a bonded pool, and the lane
prints a startup WARNING naming every threshold no curve can reach and the SOL price it would need.

Each dial overrides one threshold of the preset. **A dial set on its own arms a floor of
exactly that dial** and nothing else — inheriting three thresholds you never typed is how a
bot ends up refusing on a number nobody chose.

#### Where each fact honestly comes from

Nothing here adds a request to the path that buys.

- **age** — the venue's own `created_timestamp`, off the listing row.
- **liquidity** — the curve's real quote reserve × SOL/USD. For a bonding curve this is not a
  proxy for depth, it *is* the depth. The lane already read the curve. It also counts as a pool
  for `SNIPE_MIN_TOP_POOL_LIQUIDITY_USD`: DexScreener lists on-curve pumpfun pairs with no
  liquidity field at all, so a top-pool figure from pairs alone was unknown for every coin this
  desk can buy.
- **market cap** — the venue's own `usd_market_cap`, off the same row; DexScreener's when the row
  carries none (a launch notice has no row). When the two disagree by more than 3x the **smaller**
  is judged and the disagreement is stamped on the facts.
- **SOL/USD** — derived from the same DexScreener response, WSOL-quoted pools only, as the
  median of `priceUsd / priceNative`. No oracle call, no cache. Wire `solUsdReader` to use the
  desk's verified Pyth price instead; a supplied price always wins, and which one was used is
  reported on the facts, because a depth figure is only as good as its denominator.
- **24h volume** — DexScreener, the only source for it, and the one request this costs. Paid
  only for candidates that already cleared the three free facts — and never for a coin whose
  age alone already fails the floor, which with an age floor armed is every launch notice
  (~29 a minute that used to be fetched for nothing; the lane counts them as `marketReadsSkipped`).

**Unknown is never zero.** `Number(null)` is `0`, and this desk has shipped that bug once
already — a creator-fee vault read that failed came back as a confident "empty". Here it would
be worse in both directions: an unreadable liquidity reading as $0 refuses everything, and an
unreadable 24h volume reading as $0 does too, so the floor would *look* like it was working
while measuring nothing. So every fact is `null` when unknown, a threshold judging a null
**refuses**, and the refusal names the missing fact rather than the threshold. An armed floor
with no reader wired is refused at construction, because a lane that refuses every candidate
for want of a measurement reads in a log exactly like a market with nothing in it.

#### Five this desk adds

Their floor is four thresholds on four numbers, and **every one of those numbers can be
manufactured by whoever launched the coin.** A deployer can wash a coin between two wallets all
day and volume, market cap and price all move. These refuse the *shape* of a manufactured
market rather than its size, and all five read off facts the four above already fetched. All
off by default — they are hypotheses, where BAGWORK's four are evidence.

| Variable | Refuses | Why |
|---|---|---|
| `SNIPE_MAX_VOLUME_TO_LIQUIDITY` | $5m of volume on $30k of depth | That is a treadmill, not a market |
| `SNIPE_MIN_TXNS_24H` | Big volume, few trades | A dollar figure is one wallet's decision; a trade count is many people's |
| `SNIPE_MAX_SELL_SHARE` | Three of four trades being sells | The demand is somebody else's exit, and you are the liquidity |
| `SNIPE_MAX_PRICE_CHANGE_24H_PCT` | A coin already up 5x today | Their own `maxSpike5m: 0.2` at the timeframe a floor cares about |
| `SNIPE_MIN_TOP_POOL_LIQUIDITY_USD` | $30k spread over twenty dust pools | You trade in one pool, not in the sum. Their floor sums |

#### The momentum source

A floor alone would refuse everything, because all three existing sources answer one question:
*what launched just now.* So a fourth source asks the opposite — **what is being traded right
now, whatever its age** — by polling pump.fun's activity-sorted listing
(`sort=last_trade_timestamp`, verified against the live endpoint rather than assumed). It is
**added, never substituted**: the launch sources stay exactly as they are and the source race
still prices one against the other, so turning the floor on and off changes what is bought
without changing what is heard.

Its rows are pre-filtered on the facts they already carry before anything is fetched for them,
and what it drops is counted by clause — a source quietly returning two rows out of seventy
looks identical to a dead market and to a broken filter, and those need opposite responses.
Age and market cap are treated differently on purpose: unknown age is dropped, because the
floor exists so this bot stops buying coins whose age it does not know, while unknown market
cap is kept, because the gate can still measure it from DexScreener.

The drop tally rides the heartbeat as `snipe.momentum` (arrived, survived, and the count per
clause), and a poll that **answers** counts as proof the source is alive even when the
pre-filter keeps nothing — before that, a correctly-working source under an armed floor was
reported `DEAD` after five minutes of keeping 0 of 70 rows.

Its candidates are listing rows, which carry their metadata link as `metadata_uri`; the socials
filter reads that field too. It used to read only a create event's `uri`, so with the filter on
(the default) every momentum candidate was refused at `no_socials` before the floor ever saw it.

#### One interaction worth knowing about

The momentum source reports coins the launch sources **already saw at t=0**, so whether one of
its candidates is emitted at all depends on whether the feed has forgotten it yet — and that is
the dedupe window, 30 minutes, chosen years ago for an unrelated reason (it must outlive any
position the lane can hold, or a mint re-enters as a fresh launch while it is still open).

The shipped pairing works: a one-hour age floor against a thirty-minute window means every
candidate has aged out. But it works **by coincidence** — two constants chosen for unrelated
reasons that happen to sit the right way round. With `SNIPE_MIN_AGE_HOURS=0.25`, a candidate aged
between 15 and 30 minutes that a launch source already heard is still held in the ledger from
its own launch and dropped as a duplicate *before any gate runs*. Older candidates arrive
normally, so what is lost is a band, not the source. With no age floor at all (a volume-only
floor, or the spike dial on its own) the band is the whole first half hour.

So the lane prints a **startup WARNING** naming the band and the value to raise the age floor to.
It is a warning rather than a refusal because the source still delivers everything older — an
earlier version refused the whole lane over it, claiming the source "would deliver nothing",
which overstated it.

#### The honest limit

BAGWORK trade coins that bonded long ago, on AMM pools. **This desk cannot.** The only buy and
sell layouts proved against mainnet here are pump.fun's bonding curve v2, and a bonded coin
trades somewhere this repo cannot yet encode — so the momentum source drops `complete: true`
rows rather than paying for a market read to refuse them at `curve_already_complete`.

The floor is therefore applied where it can be honoured: coins **still on their curve**, which
is the overlap between "has proven demand" and "this bot can actually buy it". That overlap is
real — the venue's own listing showed a coin 247 hours old still on its curve — but it is
narrower than theirs, and closing the gap means proving a pump-amm buy layout against landed
transactions the way `pumpfun-fees.mjs` proved the fee claim. That is the next piece of
execution work, not a config change.

### Changing the filters from the agent page

Like a bagworkagent.fun agent, the bot can be retuned from its page while it runs. Opt in once,
on the Mac, and restart:

```bash
SNIPE_REMOTE_FILTERS="1"
```

From then on, the floor owner signed in at `claudedotcompany.com/agent.html?floor=<N>` sees a filter
panel. Saving it sends the **live** filters to the bot with its next heartbeat (about a minute), and
the bot applies them to the running lane **without a restart**. The page's status line reads the
bot's own report — "Running on your bot since 18:42" appears only once the bot says it is running
that saved version, and anything it refused is named with the reason.

**What the page can change** — only *what to buy*: the market-floor preset and its nine thresholds,
the volume spike, the socials requirement, and the creator/launch share caps (`LIVE_FILTER_ENV` in
`snipe-lane.mjs` is the list, and the bot enforces it; the desk cannot widen it).

**What it can never change** — trade size, daily cap, stop, take-profit, hold, price impact, fees,
the lane mode, or this opt-in itself. Those stay in the env file, and the size and daily cap still
need the typed sentence. The page shows them as env lines to copy. So the most a stolen website
session can do is make the bot more or less picky, inside the money caps you typed on the Mac.

The env file stays the base: a filter cleared on the page falls back to the env value, never to
"no filter". Every value the desk sends is re-validated on the bot exactly as the env file is, and
a bad one is refused on its own while the rest apply.

### The volume spike

> *"When volume spikes on a token, that's a sign to get in and ride the wave."* — the owner,
> 2026-09-26.

It is a real signal, and this desk can measure it without a single new data source. A
pump.fun bonding curve holds its SOL in `realQuoteRaw`; the **change** in that number over
time is money moving. `snipe-volume.mjs` keeps a bounded per-mint tape of those readings and
measures net inflow over the last 30 seconds against the five minutes before it, as a ratio.

Where the samples come from matters, because the lane's own curve reads cannot supply them:
it reads a curve once per notice, so at the moment the gate runs there is exactly one point
and no ratio. The stream already has the answer. The Geyser subscription filters on the
pump.fun **program**, not on creates, so every buy and sell on every curve is already
arriving — `snipe-feed.mjs` was counting them as `unparsed` and dropping them. Each carries a
`TradeEvent` whose decoder is already pinned against real mainnet bytes. So the tape is fed
from traffic this process was already receiving and throwing away: no new subscription, no
new request, no new key, and nothing added to the path that buys. Without `SNIPE_GRPC_*` the
tape still exists but has too few points to form a ratio, and says so.

One sample on that tape is a two-second **bucket**, not a trade, and that detail is load
bearing: a coin doing five trades a second would otherwise fill a bounded tape with 48
seconds of history, evict its own baseline, and be refused for being unmeasurable — a
volume gate blind in proportion to volume. Within a bucket the newest reading replaces the
previous one, which loses nothing, because every number here is a difference between two
reserve levels.

| Variable | Default | Purpose |
|---|---:|---|
| `SNIPE_MIN_VOLUME_SPIKE` | unset | Net inflow must be at least this multiple of the coin's own baseline. Unset means **measure only** |

**A launch can never be measured, by construction.** A spike is 30 seconds of flow against the 5
minutes before it, and a launch notice is judged within 30 seconds of the coin's birth — there is
no before. So the spike is judged on coins that are **already trading**: setting
`SNIPE_MIN_VOLUME_SPIKE` mounts the momentum source (the same one the market floor uses) whether or
not a floor is armed, and every launch notice is then refused at `volume_spike` for want of a
baseline, which is exactly the "stop sniping, ride the wave" the owner asked for. Their history
comes only from the gRPC trade tap, so the dial **refuses to start without `SNIPE_GRPC_*`** rather
than refusing every candidate in a log that reads like a market where nothing moved. The tap's
and the tape's own counters ride the heartbeat as `snipe.flow`.

The rate is inflow over the **window**, not over the gap between two readings: a coin that trades
in bursts has readings far apart, and dividing by the gap called a slowing coin a 2.7x spike and
read a 90x wave as 7.9x. Pair it with `SNIPE_MARKET_FLOOR=curve` so the candidates are an hour old
and every one of them has a full baseline on the tape.

**A brand-new curve has no baseline, and that is the whole trap.** Divide by it and every
fresh launch reads as an infinite spike — so a naive version of this gate fires on every new
launch while calling itself a volume signal. On this burner's own 64 trades that is the
losing book: entries under 3 seconds won 0% of the time for −18.5%, entries at 10 seconds and
later won 40% for +34.0%. So an absent or flat baseline reports `null`, never Infinity and
never a large stand-in, and with a threshold configured an unmeasurable spike **refuses** —
unverified is not safe, the same rule the other two proxy gates follow.

Two more things it is honest about rather than papering over. It measures **net** inflow, not
gross volume: a coin churned a thousand SOL each way has enormous volume and near-zero net
flow, and reads quiet here. And a falling reserve reports a **negative** number rather than
being clamped to zero, because "everyone is leaving" and "nothing is happening" are the two
facts a holder most needs to tell apart.

Like `creator_profile` and `launch_share`, it ships **unset**: measured on every candidate,
recorded in the shadow book, scored by `grade-entry-gates.mjs` against candidates whose outcome
is already known. On a book of launches it measures nothing, so the grader leaves it out of the
verdict by name (`NOT IN THE VERDICT: volume_spike`) instead of holding the "no edge" reading open
forever. Arm it only once a scorecard has justified a number:

```bash
SNIPE_MIN_VOLUME_SPIKE=2     # demand twice the coin's own baseline
```

Worth knowing while choosing that number: bagworkagent.fun's agents encode the *opposite*
half of the same idea — `maxChange5m: 0.12`, `maxSpike5m: 0.2`. They require some momentum
and then refuse anything already extended, because buying after the wave has broken is how
you become the exit liquidity for whoever caught it. `SNIPE_MAX_LAUNCH_SHARE_PCT` is this
desk's cap of that shape and it sits beside this floor.

### What has and has not been proved

The instruction encoders are re-encoded byte for byte against 30 mainnet transactions on
every test run, and the signing path is driven through every outcome the chain can hand
back (confirmed, failed, expired, silent, a lying provider, a drain) against a scripted
chain in `test-snipe-execute.mjs`. What no test can prove is the first real fill: start
at a size you can watch — the 0.005 SOL canary, or a few hundredths — read the first buy
and the first sell in the journal and on an explorer, and only then raise the ceiling.

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
| `JUPITER_EXCLUDE_DEXES` | `HumidiFi` | Jupiter route-plan labels left out of every order, comma-separated. The default is the venue measured on 2026-09-13 to make the taker fund a 0.013 SOL program account nobody quoted, which the custody rule refuses; the rule is unchanged, the venue is not asked for. Empty excludes nothing; carried across upgrades |
| `SOLANA_RPC` | public default in dry run | A private HTTPS provider is required in live mode |
| `SOLANA_RPC_SECONDARY` | required in live mode | Independent private provider for expiry, custody, and Pyth SOL/USD consensus checks; an outage fails closed or uses only the bounded Pyth exit cache |
| `SOL_USD_CACHE_MAX_AGE_MS` | `1800000` live ceiling | Maximum age of both the local observation and retained Pyth publish time before the exit-price cache fails closed |
| `STATE_DB` | installer-managed | Durable cursor, positions, transaction journal, and wallet binding |
| `PAUSE_ENTRIES_FILE` | installer-managed | Presence blocks new entries while allowing managed exits |
| `HARD_STOP_FILE` | installer-managed | Presence blocks new submissions while reconciliation continues |
| `MAX_SOL_PER_TRADE` | live `0.005` | Absolute input ceiling for one entry; acknowledged operator hard maximum `1` SOL |
| `DAILY_SOL_CAP` | live `0.01` | Rolling 24-hour deployment cap; acknowledged operator hard maximum `1000` SOL and never below the per-trade cap |
| `DAILY_LOSS_LIMIT_SOL` | live `0.01` | Rolling 24-hour realized-loss entry brake, including failed-attempt fees; acknowledged operator hard maximum `1000` SOL, not a guaranteed loss ceiling. Applied as the **tighter** of this and `DAILY_LOSS_PCT_OF_EQUITY` — raising this alone often changes nothing |
| `DAILY_LOSS_PCT_OF_EQUITY` | `0.20` | The same brake as a share of the wallet balance. `0` turns it off. Applied as the tighter of this and `DAILY_LOSS_LIMIT_SOL`, so it can only ever brake sooner |
| `MAX_OPEN_POSITIONS` | policy default | Concurrent recorded-position ceiling |
| `SLIPPAGE_BPS` | policy default | Maximum requested swap slippage |
| `MAX_PRICE_IMPACT_PCT` | `5` | Strict maximum impact for a new entry |
| `MAX_EXIT_PRICE_IMPACT_PCT` | `50` | Emergency impact ceiling for a managed exit; above it requires manual action |
| `MAX_NETWORK_FEE_LAMPORTS` | `2000000` live ceiling | Absolute network-fee cap, checked before signing and at finality |
| `MAX_NETWORK_FEE_PCT` | `10` live ceiling | Network-fee cap relative to exact trade basis |
| `MAX_RENT_LAMPORTS` | `4200000` live ceiling | Gross account-rent cap for at most the canonical temporary WSOL and destination ATAs; independently bound to both RPCs' classic-token rent facts. Rent is not a network fee, and an explicitly lower value remains lower on upgrade |
| `MAX_ENTRY_ROUND_TRIP_LOSS_PCT` | `5` default · `12` live ceiling | Maximum measured forward/reverse entry preflight loss. The route ladder halves a clip that cannot clear it rather than refusing the call. Default lowered from the ceiling on 2026-09-16: the house floor's first twenty live trades lost 3.2% a trade more than the desk's paper marks, up to 11% on bonding-curve coins, against a measured edge of +3.6% on the desk's best calls |
| `MAX_ENTRY_MARK_AGE_MIN` | `15` | Maximum monitored USD-mark age at entry submission |
| `MARK_MS` | `15000` (live `5000`–`300000`) | How often the valuation pass prices every open position through a chain-simulated Jupiter exit. **This dial decides your RPC bill.** Measured 2026-09-13: that pass is 20 RPC calls per position per sweep across the two providers, 85% of 270,660 calls a day on a two-position book — and the `valuationMark` it produces is written and read nowhere, because desk-led-v4 deleted every exit it used to arm. Raising it to `60000` cuts the day's total by about 70% and delays no exit: the desk's determined exits run in `consumeFeed()` on every `POLL_MS` tick strictly before this gate, and a latched exit bypasses the gate entirely. What it does slow is the custody leg in the same pass, which arms the entry-blocking `balanceReconciliationRequired` — so an out-of-band move on a position's token account is noticed in a minute rather than 15 seconds. That only delays new exposure, and every sell re-verifies custody itself before it runs. A minute is the sensible floor to stop at, for that reason and not for the mark |
| `MAX_ENTRY_QUOTE_DRIFT_PCT` | `5` live ceiling | Maximum preflight/final executable USD-price drift from the monitored market mark |
| `MAX_ENTRY_PREFLIGHT_AGE_MS` | `90000` live ceiling | Maximum executable-entry preflight age before signing. The same budget as the entry window: `executor/test-entry-window.mjs` measured the preflight at 12 serial hops, 68s priced at this executor's own per-request deadlines, so a shorter cap would refuse a preflight the pipeline legitimately took that long to build |
| `MAX_EXIT_TRIGGER_AGE_MS` | `60000` live ceiling | Maximum price-exit trigger age before two fresh witnesses are required |
| `TRAIL_PCT` | `0.25` | Trail distance after the shared 1.5x arm |
| `MAX_AGE_HOURS` | `12` | Time exit used by snipe-v3 |
| `SNIPE_LANE` | `off` | `observe` runs the launch shadow book; `execute` arms HAWK-AI on a live install (see above) |
| `SNIPE_MAX_SOL_PER_TRADE` | `0.005` | The sniper's per-launch ceiling; operator hard maximum `1` SOL |
| `SNIPE_DAILY_SOL_CAP` | `0.01` | The sniper's rolling 24-hour deployment cap, charged for real once armed; operator hard maximum `1000` SOL |
| `SNIPE_STOP_FRAC` | policy `0.20` | Fraction of entry at which the whole position leaves; must be set explicitly above the 0.005 SOL canary |
| `SNIPE_TAKE_AT_ENTRY_X` | policy `2` | Multiple of entry at which the whole position leaves |
| `SNIPE_LIVE_ACK` | unset | The owner's typed arming sentence; must equal the one the lane prints for the signing wallet and these caps |

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
