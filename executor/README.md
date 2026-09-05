# WALL-ST-E — Claude Company’s self-hosted executor

WALL-ST-E is the autotrading representative for your floor. The central Claude
Company site publishes authenticated research calls; it does not custody funds,
receive wallet keys, sign transactions, or know whether your executor is running.

The polling executor runs on a machine you control. It starts in **dry run** unless
you deliberately install it with `--live`. Browser signing and webhook execution
remain disabled; the only live-capable path is the local `poller.mjs` service.

Trading is risky, and these controls do not make the calls profitable. Use a new,
dedicated burner wallet and fund it with no more than you can lose.

## The first-start rule

On its first successful feed read, WALL-ST-E records the newest delivery ID and
skips everything older. It does **not** replay calls that were published before the
poller started. This is true in dry-run and live mode.

After that cursor is established, only later deliveries are eligible. Do not delete
the state database to force a replay; reconcile the journal and wallet first.

## Default installation: dry run

Install from the exact 40-character release commit shown by the floor UI. Review the
checkout before running it; live mode refuses piped/mutable runtime downloads. Node
>=22.13 and <25 must already be installed from a package source you trust. The installer asks for
the floor’s executor feed secret through `/dev/tty`, creates a dedicated unfunded burner
locally, stores secrets at mode `0600`, and installs a systemd service.

```bash
git clone https://github.com/gtjvv976mb-netizen/Claude-Company.git
cd Claude-Company
git checkout --detach <PUBLISHED_COMMIT_SHA>
bash executor/install.sh --floor <YOUR_FLOOR_NUMBER>
```

Dry run downloads the same calls and applies the same local policy without signing
or submitting a transaction. Check its decisions before considering live mode:

```bash
sudo journalctl -u cc-executor -f
```

For unattended feed authentication, create a mode-`0600` secret file and add
`--secret-file`:

```bash
umask 077
install -m 600 /dev/null ./claudeco-secret
${EDITOR:-vi} ./claudeco-secret
bash executor/install.sh --floor <YOUR_FLOOR_NUMBER> \
  --secret-file ./claudeco-secret
```

`CC_SECRET` authenticates the read-only floor feed. It is not a wallet key and
cannot move funds.

### macOS LaunchAgent lifecycle

This is a supervisor-adoption path for an **already configured macOS executor**, not
a fresh-wallet installer. Installation does not create an environment, wallet,
journal, or live acknowledgement, and never funds anything. From the stable executor
directory, install the locked dependencies and per-user supervisor. It consumes the
existing owner-only `.cc-executor.env`; it never sources that file through a shell:

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
  its own mode-`0600` file;
- a Jupiter API key supplied from a mode-`0600` file;
- `--live` on the installer command;
- per-trade, rolling deployment, and rolling-loss caps for a supervised canary; and
- a terminal acknowledgement made by retyping the displayed burner public key.

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
| `MAX_ENTRY_PREFLIGHT_AGE_MS` | `60000` live ceiling | Maximum executable-entry preflight age before signing |
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
