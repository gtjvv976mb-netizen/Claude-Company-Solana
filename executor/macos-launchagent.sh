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
  status      Show whether the plist is installed and the agent is loaded.
  uninstall   Remove the plist after an explicit unload. Keeps logs and all state.

Options:
  --executor-dir DIR   Directory containing poller.mjs and launchd-runner.mjs.
  --env-file FILE      Existing owner-only .cc-executor.env (default: executor dir).
  --max-sol SOL        arm-caps: maximum SOL per trade (up to 0.05).
  --daily-sol-cap SOL  arm-caps: rolling 24-hour deployment cap (up to 0.5).
  --daily-loss-cap SOL arm-caps: rolling realized-loss entry brake (up to 0.15).

This lifecycle never funds a wallet, changes trading mode, removes pause or hard-stop
sentinels, or terminates a manually-started poller. arm-caps is the sole cap-changing
command; it requires a real terminal and retains an owner-only rollback environment.
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

  if [ -z "$ENV_FILE" ]; then ENV_FILE="$EXECUTOR_DIR/.cc-executor.env"; fi
  if [ ! -e "$ENV_FILE" ] || [ -L "$ENV_FILE" ] || [ ! -f "$ENV_FILE" ]; then
    fail "environment file must be an existing regular non-symlink file"
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
