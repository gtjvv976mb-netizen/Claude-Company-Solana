#!/usr/bin/env bash
# Install and explicitly control WALL-ST-E as a per-user macOS LaunchAgent.
# This script never sources or prints the protected environment. Only the explicit,
# interactive arm-caps command may atomically rewrite its cap fields.
set -euo pipefail
umask 077

LABEL="com.claudeco.wallste"
THROTTLE_SECONDS="15"
COMMAND="${1:-}"
if [ "$#" -gt 0 ]; then shift; fi
# `buys` takes a positional verb (on|off|status). Captured here, before the option loop,
# because that loop refuses anything that is not a --flag and would reject it as garbage.
BUYS_VERB=""
if [ "$COMMAND" = "buys" ]; then
  case "${1:-}" in
    ""|--*) ;;
    *) BUYS_VERB="$1"; shift;;
  esac
fi
EXECUTOR_DIR=""
ENV_FILE=""
MAX_SOL=""
DAILY_SOL_CAP=""
DAILY_LOSS_CAP=""

usage() {
  cat <<'HELP'
Usage: bash macos-launchagent.sh COMMAND [options]

Commands:
  install     Validate and install the plist. Does not start WALL-ST-E.
  load        Explicitly load and start the installed LaunchAgent.
  unload      Explicitly stop and unload only this LaunchAgent.
  arm-caps    While stopped and entry-paused, bind a cap tuple to the burner wallet.
  buys        on | off | status. OFF stops both lanes opening anything; open positions
              still exit on their stop, target and clock. Takes effect on the next tick.
  status      Show whether the plist is installed and the agent is loaded.
  uninstall   Remove the plist after an explicit unload. Keeps logs and all state.

Options:
  --executor-dir DIR   Directory containing poller.mjs and launchd-runner.mjs.
  --env-file FILE      Existing owner-only .cc-executor.env. Default: found in the
                       install directory (~/claudeco-executor) even when this script
                       is run from a release under it.
  --max-sol SOL        arm-caps: maximum SOL per trade (up to 0.4).
  --daily-sol-cap SOL  arm-caps: rolling 24-hour deployment cap (up to 1000 — removed in effect; the wallet binds).
  --daily-loss-cap SOL arm-caps: rolling realized-loss entry brake (up to 0.4).

This lifecycle never funds a wallet, changes trading mode, or terminates a
manually-started poller. arm-caps is the sole cap-changing command; it requires a real
terminal and retains an owner-only rollback environment. `buys` is the sole
pause-changing command, and it moves only the ENTRY pause: no command here ever touches
the hard stop, which blocks exits as well and stays a deliberate act of its own.
HELP
}

fail() {
  echo "WALL-ST-E LaunchAgent: $*" >&2
  exit 1
}

need_value() {
  if [ "$#" -lt 2 ] || [ -z "$2" ]; then fail "missing value for $1"; fi
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --executor-dir) need_value "$@"; EXECUTOR_DIR="$2"; shift 2;;
    --env-file) need_value "$@"; ENV_FILE="$2"; shift 2;;
    --max-sol) need_value "$@"; MAX_SOL="$2"; shift 2;;
    --daily-sol-cap) need_value "$@"; DAILY_SOL_CAP="$2"; shift 2;;
    --daily-loss-cap) need_value "$@"; DAILY_LOSS_CAP="$2"; shift 2;;
    --help|-h) usage; exit 0;;
    *) fail "unknown option: $1";;
  esac
done

case "$COMMAND" in
  help|--help|-h|"") usage; [ -n "$COMMAND" ] && exit 0 || exit 1;;
  install|load|unload|arm-caps|status|uninstall) ;;
  buys)
    case "$BUYS_VERB" in
      on|off|status) ;;
      "") fail "buys needs one of: on, off, status";;
      *) fail "buys takes on, off or status — received: $BUYS_VERB";;
    esac
    ;;
  *) fail "unknown command: $COMMAND";;
esac

if [ "$COMMAND" != "arm-caps" ] &&
   { [ -n "$MAX_SOL" ] || [ -n "$DAILY_SOL_CAP" ] || [ -n "$DAILY_LOSS_CAP" ]; }; then
  fail "cap options are accepted only by the explicit arm-caps command"
fi

if [ "$(uname -s)" != "Darwin" ]; then fail "this lifecycle supports macOS only"; fi

USER_HOME="${HOME:?HOME is required}"
AGENTS_DIR="$USER_HOME/Library/LaunchAgents"
LOG_DIR="$USER_HOME/Library/Logs/ClaudeCompany"
PLIST_FILE="$AGENTS_DIR/$LABEL.plist"
STDOUT_LOG="$LOG_DIR/wallste.stdout.log"
STDERR_LOG="$LOG_DIR/wallste.stderr.log"
DOMAIN="gui/$(id -u)"
SERVICE_TARGET="$DOMAIN/$LABEL"

# Emergency unload and uninstall must keep working even if the checkout or its
# protected environment has been moved or damaged. Only install/load resolve runtime.
if [ "$COMMAND" = "install" ] || [ "$COMMAND" = "load" ] || [ "$COMMAND" = "arm-caps" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
  if [ -z "$EXECUTOR_DIR" ]; then EXECUTOR_DIR="$SCRIPT_DIR"; fi
  if [ ! -d "$EXECUTOR_DIR" ]; then fail "executor directory does not exist"; fi
  EXECUTOR_DIR="$(cd "$EXECUTOR_DIR" && pwd -P)"

  # THE ENVIRONMENT FILE DOES NOT LIVE BESIDE THIS SCRIPT, and defaulting as if it
  # did cost the owner four rounds on 2026-09-17. An install puts the owner's
  # .cc-executor.env in $HOME/claudeco-executor and the CODE in a release beneath
  # it, reached through the `current` symlink — so the documented command,
  #     bash ~/claudeco-executor/current/macos-launchagent.sh install
  # resolves SCRIPT_DIR to ~/claudeco-executor/releases/<x> (cd + pwd -P follows the
  # link), and the default env path was a file that has never existed there. The
  # refusal named no path, so it read as "your environment is broken" rather than
  # "I looked in the wrong place". `buys` already knew better — it has fallen back
  # to $HOME/claudeco-executor since it shipped — and that inconsistency IS the bug.
  #
  # So: look where an install actually puts it. The candidates are few, ordered and
  # written out rather than globbed, and every one must resolve UNDER $HOME — which
  # is what stops an odd checkout from walking up into /Users and reading a file
  # belonging to somebody else. Nothing here relaxes a check: whatever is found is
  # still handed to `validate`, which refuses any env file that is not mode 0600 and
  # owned by this user. --env-file always wins and is never searched for.
  if [ -z "$ENV_FILE" ]; then
    # $HOME resolved the same way the candidates are, so a symlinked home directory
    # cannot make every search path look like it is outside itself.
    HOME_REAL="$(cd "$USER_HOME" 2>/dev/null && pwd -P || printf '%s' "$USER_HOME")"
    ENV_TRIED=""
    # 1 is exactly today's default and is NOT confined to $HOME: an install that
    # already keeps its environment beside the code, anywhere on the disk, keeps
    # working unchanged. 2-4 are new places to look, so they are the ones confined.
    ENV_CANDIDATES=(
      "$EXECUTOR_DIR/.cc-executor.env|any"                 # a flat install, and every case that already worked
      # ONE LEVEL UP is a code directory sitting directly inside the install dir — an install
      # that keeps its code in, say, ~/claudeco-executor/code/ with the environment beside it.
      # It is NOT the `current` case: `cd` + `pwd -P` above resolves that symlink through to
      # releases/<release>, so `current` is two levels down and is caught by the next line.
      # This line's comment used to attribute the `current` case to one-level-up, an off-by-one
      # that makes a reader conclude the env search is broken for symlinked installs when it is
      # not. It is not reproduced here verbatim on purpose: a wrong sentence kept in the source
      # as an example is a wrong sentence a future grep will find.
      "$EXECUTOR_DIR/../.cc-executor.env|home"
      # TWO LEVELS UP is where the real installs live: releases/<release> (which is what
      # `current` resolves to) and versioned-releases/<commit> both sit two deep.
      "$EXECUTOR_DIR/../../.cc-executor.env|home"
      "$USER_HOME/claudeco-executor/.cc-executor.env|home" # the documented install dir, wherever the code sits
    )
    for entry in "${ENV_CANDIDATES[@]}"; do
      candidate="${entry%|*}"; confine="${entry##*|}"
      candidate_dir="$(cd "$(dirname "$candidate")" 2>/dev/null && pwd -P || true)"
      [ -n "$candidate_dir" ] || continue
      if [ "$confine" = "home" ]; then
        case "$candidate_dir/" in "$HOME_REAL"/*) ;; *) continue;; esac
      fi
      resolved="$candidate_dir/$(basename "$candidate")"
      case "$ENV_TRIED" in *"[$resolved]"*) continue;; esac
      ENV_TRIED="$ENV_TRIED [$resolved]"
      if [ -f "$resolved" ] && [ ! -L "$resolved" ]; then ENV_FILE="$resolved"; break; fi
    done
    if [ -z "$ENV_FILE" ]; then
      fail "no .cc-executor.env found. Looked in:$ENV_TRIED. Pass --env-file FILE if yours is elsewhere."
    fi
  fi
  if [ ! -e "$ENV_FILE" ] || [ -L "$ENV_FILE" ] || [ ! -f "$ENV_FILE" ]; then
    fail "environment file must be an existing regular non-symlink file: $ENV_FILE"
  fi
  ENV_PARENT="$(cd "$(dirname "$ENV_FILE")" && pwd -P)"
  ENV_FILE="$ENV_PARENT/$(basename "$ENV_FILE")"

  RUNNER="$EXECUTOR_DIR/launchd-runner.mjs"
  POLLER="$EXECUTOR_DIR/poller.mjs"
  if [ ! -f "$RUNNER" ] || [ -L "$RUNNER" ]; then fail "missing regular launchd-runner.mjs"; fi
  if [ ! -f "$POLLER" ] || [ -L "$POLLER" ]; then fail "missing regular poller.mjs"; fi

  NODE_COMMAND="$(command -v node || true)"
  if [ -z "$NODE_COMMAND" ]; then fail "Node >=22.13 and <25 is required"; fi
  NODE_BIN="$("$NODE_COMMAND" -e 'const fs=require("fs");const [a,b]=process.versions.node.split(".").map(Number);if(a<22||a>=25||(a===22&&b<13))process.exit(1);process.stdout.write(fs.realpathSync(process.execPath))' 2>/dev/null || true)"
  if [ -z "$NODE_BIN" ]; then fail "Node >=22.13 and <25 is required"; fi
fi

is_loaded() {
  /bin/launchctl print "$SERVICE_TARGET" >/dev/null 2>&1
}

launch_policy() {
  local policies
  if ! policies="$(/bin/launchctl print-disabled "$DOMAIN" 2>/dev/null)"; then
    printf '%s\n' "unknown"
    return
  fi
  # Current macOS prints `=> disabled` / `=> enabled`; older releases used
  # boolean values. Accept both spellings, but never treat an unreadable or
  # absent policy as confirmation of either state.
  case "$policies" in
    *"\"$LABEL\" => disabled"*|*"\"$LABEL\" => true"*) printf '%s\n' "disabled";;
    *"\"$LABEL\" => enabled"*|*"\"$LABEL\" => false"*) printf '%s\n' "enabled";;
    *) printf '%s\n' "unknown";;
  esac
}

is_disabled() {
  [ "$(launch_policy)" = "disabled" ]
}

is_enabled() {
  [ "$(launch_policy)" = "enabled" ]
}

validate_runtime() {
  "$NODE_BIN" "$RUNNER" validate --env "$ENV_FILE" --poller "$POLLER"
}

render_plist() {
  "$NODE_BIN" "$RUNNER" render-plist \
    --label "$LABEL" \
    --node "$NODE_BIN" \
    --runner "$RUNNER" \
    --poller "$POLLER" \
    --env "$ENV_FILE" \
    --workdir "$EXECUTOR_DIR" \
    --stdout "$STDOUT_LOG" \
    --stderr "$STDERR_LOG" \
    --throttle "$THROTTLE_SECONDS"
}

service_pid() {
  local service_info
  if ! service_info="$(/bin/launchctl print "$SERVICE_TARGET" 2>/dev/null)"; then return 1; fi
  printf '%s\n' "$service_info" |
    /usr/bin/awk '$1 == "pid" && $2 == "=" { print $3; exit }'
}

wait_until_ready() {
  local attempt pid confirmed
  for attempt in {1..40}; do
    pid="$(service_pid || true)"
    if [[ "$pid" =~ ^[0-9]+$ ]] &&
       "$NODE_BIN" "$RUNNER" ready --env "$ENV_FILE" --poller "$POLLER" --pid "$pid" \
         >/dev/null 2>&1; then
      /bin/sleep 0.5
      confirmed="$(service_pid || true)"
      if [ "$confirmed" = "$pid" ] &&
         "$NODE_BIN" "$RUNNER" ready --env "$ENV_FILE" --poller "$POLLER" --pid "$pid" \
           >/dev/null 2>&1; then
        return 0
      fi
    fi
    /bin/sleep 0.25
  done
  return 1
}

rollback_load() {
  local disable_status=0
  /bin/launchctl disable "$SERVICE_TARGET" || disable_status="$?"
  if is_loaded; then /bin/launchctl bootout "$SERVICE_TARGET" >/dev/null 2>&1 || true; fi
  [ "$disable_status" -eq 0 ] && is_disabled && ! is_loaded
}

case "$COMMAND" in
  # THE BUY SWITCH (owner, 2026-09-17: "a buy off/on button — when it is off the bot
  # cannot buy but can sell what he last bought, and on for automatic").
  #
  # The MECHANISM already existed and is unchanged: the entry-pause sentinel, which
  # poller.mjs reads fresh on every tick (controlActive -> inspectOwnerControlFile) and
  # which both lanes consult before opening anything — the desk at its entry gate and the
  # sniper through its control() reader. Exits run on a different path entirely and never
  # consult it, which is exactly the asked-for shape: no new buys, and what is already held
  # still leaves on its stop, its target, the creator's exit or the clock.
  #
  # What was missing was a switch a person can actually throw. Setting it meant typing
  # `install -m 600 /dev/null` against a long absolute path, and `touch` — the obvious
  # thing to reach for instead — writes 0644 under a normal umask, which the watchdog
  # reads as an unsafe control and SIGTERMs the agent ten seconds after every load.
  #
  # IT IS A LOCAL SWITCH, AND THAT IS ARCHITECTURE RATHER THAN AN OMISSION. The hosted
  # desk cannot throw it: DESK.md's deployment rule is that authenticated polling delivers
  # research events and never commands, so a remote party able to stop this bot would also
  # be able to silence it. The site SHOWS the state — the heartbeat already carries
  # entriesPaused — and the operator's own machine sets it.
  buys)
    # WHERE THE SENTINEL LIVES. The protected env file names it (install.sh writes
    # PAUSE_ENTRIES_FILE), so that one key is read out of it by name — this script still
    # never sources the environment and never prints any other line of it. The default
    # install layout is the fallback, so an older env without the key still resolves.
    BUYS_ENV="${ENV_FILE:-$USER_HOME/claudeco-executor/.cc-executor.env}"
    PAUSE_FILE=""
    if [ -f "$BUYS_ENV" ]; then
      PAUSE_LINE="$(grep -m1 '^PAUSE_ENTRIES_FILE=' "$BUYS_ENV" 2>/dev/null || true)"
      PAUSE_FILE="${PAUSE_LINE#PAUSE_ENTRIES_FILE=}"
      PAUSE_FILE="${PAUSE_FILE#\"}"; PAUSE_FILE="${PAUSE_FILE%\"}"
    fi
    if [ -z "$PAUSE_FILE" ]; then PAUSE_FILE="$USER_HOME/claudeco-executor/PAUSE_ENTRIES"; fi
    case "$PAUSE_FILE" in
      /*) ;;
      *) fail "the entry-pause sentinel must be an absolute path; read: $PAUSE_FILE";;
    esac
    if [ -L "$PAUSE_FILE" ]; then fail "the entry-pause sentinel is a symlink; refusing to move it"; fi
    case "$BUYS_VERB" in
      status) ;;
      off)
        # `install -m 600`, never `touch` — see the note above; 0644 is not a control.
        install -m 600 /dev/null "$PAUSE_FILE" 2>/dev/null || : > "$PAUSE_FILE"
        chmod 600 "$PAUSE_FILE"
        ;;
      on) rm -f "$PAUSE_FILE";;
    esac
    if [ -e "$PAUSE_FILE" ]; then
      echo "BUYS ARE OFF. Neither WALL-ST-E nor HAWK-AI will open a new position."
      echo "What is already held is untouched, and still exits on its stop, its target,"
      echo "the creator's exit or the clock."
      echo "Sentinel: $PAUSE_FILE"
      echo "Back on:  bash macos-launchagent.sh buys on"
    else
      echo "BUYS ARE ON. WALL-ST-E takes the desk's published calls and HAWK-AI takes"
      echo "launches, each inside its own caps."
      echo "Off:      bash macos-launchagent.sh buys off"
    fi
    echo "Either way this never touches the hard stop, which blocks exits too."
    echo "No restart is needed: the running bot reads this file on its next tick."
    ;;
  install)
    if is_loaded; then fail "agent is loaded; run the explicit unload command before reinstalling"; fi
    # ~/Library/LaunchAgents is scanned at login. Persistently disable the label
    # before publishing its plist so install can never bypass the explicit load gate.
    /bin/launchctl disable "$SERVICE_TARGET"
    if ! is_disabled; then fail "could not confirm persistent disable; no plist was installed"; fi
    validate_runtime
    mkdir -p "$AGENTS_DIR" "$LOG_DIR"
    chmod 700 "$LOG_DIR"
    if [ -L "$PLIST_FILE" ] || { [ -e "$PLIST_FILE" ] && [ ! -f "$PLIST_FILE" ]; }; then
      fail "refusing to replace a non-regular LaunchAgent plist"
    fi
    PLIST_NEXT="$(mktemp "$AGENTS_DIR/.$LABEL.plist.XXXXXXXX")"
    cleanup_plist() { if [ -n "${PLIST_NEXT:-}" ] && [ -f "$PLIST_NEXT" ]; then unlink "$PLIST_NEXT"; fi; }
    trap cleanup_plist EXIT
    render_plist > "$PLIST_NEXT"
    chmod 600 "$PLIST_NEXT"
    mv -f "$PLIST_NEXT" "$PLIST_FILE"
    PLIST_NEXT=""
    trap - EXIT
    echo "Installed $PLIST_FILE (persistently disabled and not loaded)."
    echo "Next: rerun macos-launchagent.sh with the explicit load command."
    echo "Existing state, pause, and hard-stop files were not changed."
    ;;
  load)
    if [ ! -f "$PLIST_FILE" ] || [ -L "$PLIST_FILE" ]; then
      fail "LaunchAgent is not installed; run install first"
    fi
    if is_loaded; then fail "agent is already loaded"; fi
    EXPECTED_PLIST="$(mktemp "${TMPDIR:-/tmp}/$LABEL.expected.XXXXXXXX")"
    cleanup_expected() { if [ -f "${EXPECTED_PLIST:-}" ]; then unlink "$EXPECTED_PLIST"; fi; }
    trap cleanup_expected EXIT
    render_plist > "$EXPECTED_PLIST"
    if ! cmp -s "$EXPECTED_PLIST" "$PLIST_FILE"; then
      fail "installed plist does not match this runtime; run install again before loading"
    fi
    unlink "$EXPECTED_PLIST"
    EXPECTED_PLIST=""
    trap - EXIT
    # The protected lock is authoritative. A manually-started poller remains untouched;
    # the operator must stop it deliberately before this command can succeed.
    "$NODE_BIN" "$RUNNER" preflight --env "$ENV_FILE" --poller "$POLLER"
    /bin/launchctl enable "$SERVICE_TARGET"
    if ! is_enabled; then
      if rollback_load; then
        fail "could not confirm persistent enable; bootstrap was not attempted and the agent is disabled"
      fi
      fail "persistent enable was not confirmed and disable/unload could not be confirmed — run unload immediately"
    fi
    if ! /bin/launchctl bootstrap "$DOMAIN" "$PLIST_FILE"; then
      if rollback_load; then
        fail "bootstrap failed; the agent is unloaded and persistently disabled"
      fi
      fail "bootstrap failed and persistent disable/unload could not be confirmed — run unload immediately"
    fi
    if ! wait_until_ready; then
      if rollback_load; then
        fail "agent never proved runtime readiness; it was unloaded and disabled — inspect $STDERR_LOG"
      fi
      fail "agent never proved readiness and persistent disable/unload could not be confirmed — run unload immediately"
    fi
    echo "Loaded $LABEL. Its pid owns the canonical state lock; KeepAlive is enabled."
    echo "Logs: $STDOUT_LOG and $STDERR_LOG"
    ;;
  unload)
    # Disable first so a logout/login cannot race the stop and restart the service.
    /bin/launchctl disable "$SERVICE_TARGET"
    if ! is_disabled; then fail "could not confirm persistent disable; the service was not stopped"; fi
    if is_loaded; then
      /bin/launchctl bootout "$SERVICE_TARGET"
      echo "Unloaded and persistently disabled $LABEL."
    else
      echo "$LABEL was not loaded; it is now persistently disabled."
    fi
    echo "State and safety sentinels were not changed."
    ;;
  arm-caps)
    if [ -z "$MAX_SOL" ] || [ -z "$DAILY_SOL_CAP" ] || [ -z "$DAILY_LOSS_CAP" ]; then
      fail "arm-caps requires --max-sol, --daily-sol-cap, and --daily-loss-cap"
    fi
    if [ ! -t 0 ] || [ ! -t 1 ]; then
      fail "arm-caps requires an interactive terminal (TTY); piped input is refused"
    fi
    if is_loaded; then fail "agent is loaded; run the explicit unload command before arming caps"; fi
    /bin/launchctl disable "$SERVICE_TARGET"
    if ! is_disabled; then fail "could not confirm persistent disable; caps were not changed"; fi
    validate_runtime
    "$NODE_BIN" "$RUNNER" arm-caps \
      --env "$ENV_FILE" --workdir "$EXECUTOR_DIR" \
      --max-sol "$MAX_SOL" --daily-sol-cap "$DAILY_SOL_CAP" \
      --daily-loss-cap "$DAILY_LOSS_CAP"
    echo "Review the retained entry pause and run monitor before any later explicit load/unpause decision."
    ;;
  status)
    if [ -f "$PLIST_FILE" ] && [ ! -L "$PLIST_FILE" ]; then
      echo "plist: installed at $PLIST_FILE"
    else
      echo "plist: not installed"
    fi
    if is_loaded; then
      echo "agent: loaded"
      /bin/launchctl print "$SERVICE_TARGET"
    else
      echo "agent: not loaded"
    fi
    echo "login policy: $(launch_policy)"
    ;;
  uninstall)
    if is_loaded; then fail "agent is loaded; run the explicit unload command first"; fi
    /bin/launchctl disable "$SERVICE_TARGET"
    if ! is_disabled; then fail "could not confirm persistent disable; the plist was not removed"; fi
    if [ -L "$PLIST_FILE" ] || { [ -e "$PLIST_FILE" ] && [ ! -f "$PLIST_FILE" ]; }; then
      fail "refusing to remove a non-regular LaunchAgent plist"
    fi
    if [ -f "$PLIST_FILE" ]; then unlink "$PLIST_FILE"; fi
    echo "Removed the LaunchAgent plist only. Logs, environment, wallet, journal, and safety sentinels remain."
    ;;
esac
