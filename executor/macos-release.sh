#!/usr/bin/env bash
# Stage and adopt an exact, versioned WALL-ST-E release on an already configured Mac.
# This script never starts, stops, funds, signs for, or unpauses the executor.
set -euo pipefail
umask 077

COMMAND="${1:-}"
if [ "$#" -gt 0 ]; then shift; fi
EXPECTED_COMMIT=""
ENV_FILE=""
LEGACY_WORKDIR=""
RELEASES_DIR=""
RELEASE_DIR=""
LABEL="com.claudeco.wallste"

usage() {
  cat <<'HELP'
Usage: bash macos-release.sh COMMAND --expected-commit SHA --env-file FILE [options]

Commands:
  stage      Build and test a complete versioned release. Does not touch the process.
  install    Bind the stopped, entry-paused executor to a staged release. Does not load it.

Required options:
  --expected-commit SHA   Exact reviewed 40-character Git commit.
  --env-file FILE         Existing owner-only executor environment; never sourced or printed.
  --legacy-workdir DIR    Working directory used by the existing executor. Relative data paths
                          are canonicalized against this explicit directory.

Additional options:
  --releases-dir DIR      Versioned release parent for stage.
  --release-dir DIR       Exact staged repository root for install.

The install command refuses a loaded LaunchAgent or any active old/canonical process
lock. It requires the existing entry-pause sentinel, preserves every secret, lowers
values above the reviewed ceilings, applies reviewed defaults where a cap is missing,
atomically normalizes data paths and EXECUTOR_SOURCE_COMMIT, then installs a
persistently disabled plist. Starting remains a separate explicit load command.
HELP
}

fail() {
  echo "WALL-ST-E macOS release: $*" >&2
  exit 1
}

need_value() {
  if [ "$#" -lt 2 ] || [ -z "$2" ]; then fail "missing value for $1"; fi
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --expected-commit) need_value "$@"; EXPECTED_COMMIT="$2"; shift 2;;
    --env-file) need_value "$@"; ENV_FILE="$2"; shift 2;;
    --legacy-workdir) need_value "$@"; LEGACY_WORKDIR="$2"; shift 2;;
    --releases-dir) need_value "$@"; RELEASES_DIR="$2"; shift 2;;
    --release-dir) need_value "$@"; RELEASE_DIR="$2"; shift 2;;
    --help|-h) usage; exit 0;;
    *) fail "unknown option: $1";;
  esac
done

case "$COMMAND" in
  help|--help|-h|"") usage; [ -n "$COMMAND" ] && exit 0 || exit 1;;
  stage|install) ;;
  *) fail "unknown command: $COMMAND";;
esac

if [ "$(uname -s)" != "Darwin" ]; then fail "this release workflow supports macOS only"; fi
if ! [[ "$EXPECTED_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
  fail "--expected-commit must be an exact 40-character Git commit"
fi
if [ -z "$ENV_FILE" ]; then fail "--env-file is required; the release workflow never guesses a secret path"; fi
if [ -z "$LEGACY_WORKDIR" ]; then fail "--legacy-workdir is required"; fi
if [[ "$ENV_FILE" != /* ]] || [[ "$LEGACY_WORKDIR" != /* ]]; then
  fail "--env-file and --legacy-workdir must be absolute"
fi
if [ ! -e "$ENV_FILE" ] || [ -L "$ENV_FILE" ] || [ ! -f "$ENV_FILE" ]; then
  fail "--env-file must name an existing regular non-symlink file"
fi
ENV_PARENT="$(cd "$(dirname "$ENV_FILE")" && pwd -P)"
ENV_FILE="$ENV_PARENT/$(basename "$ENV_FILE")"
if [ ! -d "$LEGACY_WORKDIR" ] || [ -L "$LEGACY_WORKDIR" ]; then
  fail "--legacy-workdir must be an existing non-symlink directory"
fi
LEGACY_WORKDIR="$(cd "$LEGACY_WORKDIR" && pwd -P)"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
SOURCE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
NODE_COMMAND="$(command -v node || true)"
if [ -z "$NODE_COMMAND" ]; then fail "Node >=22.13 and <25 is required"; fi
NODE_BIN="$("$NODE_COMMAND" -e 'const fs=require("fs");const[a,b]=process.versions.node.split(".").map(Number);if(a<22||a>=25||(a===22&&b<13))process.exit(1);process.stdout.write(fs.realpathSync(process.execPath))' 2>/dev/null || true)"
if [ -z "$NODE_BIN" ]; then fail "Node >=22.13 and <25 is required"; fi
GIT_BIN="/usr/bin/git"
if [ ! -x "$GIT_BIN" ]; then fail "the system Git client is required"; fi

RUNTIME_PATHS=(
  executor/poller.mjs executor/journal.mjs executor/jupiter.mjs executor/token2022.mjs
  executor/balance-verification.mjs executor/entry-quote-guard.mjs
  executor/exit-trigger.mjs executor/feed-drain.mjs executor/sol-usd-oracle.mjs
  executor/heartbeat-health.mjs executor/sleep-assertion.mjs
  executor/strategy.mjs executor/trade-policy.mjs
  executor/dexscreener-consensus.mjs executor/desk-mirror.mjs
  executor/monitor.mjs executor/launchd-runner.mjs executor/macos-launchagent.sh
  executor/macos-release.sh executor/package.json executor/package-lock.json
)

verify_git_release() {
  local root="$1" top head dirty file expected_blob actual_blob
  top="$("$GIT_BIN" -C "$root" rev-parse --show-toplevel 2>/dev/null || true)"
  if [ -z "$top" ]; then fail "release source is not a Git checkout"; fi
  top="$(cd "$top" && pwd -P)"
  if [ "$top" != "$root" ]; then fail "release source is not rooted at $root"; fi
  head="$("$GIT_BIN" -C "$root" rev-parse HEAD 2>/dev/null || true)"
  if [ "$head" != "$EXPECTED_COMMIT" ]; then fail "release HEAD does not equal --expected-commit"; fi
  dirty="$("$GIT_BIN" -C "$root" status --porcelain --untracked-files=no -- "${RUNTIME_PATHS[@]}")"
  if [ -n "$dirty" ]; then fail "release runtime differs from commit $EXPECTED_COMMIT"; fi
  for file in "${RUNTIME_PATHS[@]}"; do
    if [ ! -f "$root/$file" ] || [ -L "$root/$file" ]; then
      fail "release runtime is not a regular non-symlink file: $file"
    fi
    "$GIT_BIN" -C "$root" cat-file -e "$EXPECTED_COMMIT:$file" 2>/dev/null ||
      fail "commit $EXPECTED_COMMIT is missing $file"
    expected_blob="$("$GIT_BIN" -C "$root" rev-parse "$EXPECTED_COMMIT:$file")"
    actual_blob="$("$GIT_BIN" -C "$root" hash-object --no-filters "$root/$file")"
    if [ "$actual_blob" != "$expected_blob" ]; then
      fail "release runtime bytes do not equal commit $EXPECTED_COMMIT: $file"
    fi
  done
}

case "$COMMAND" in
  stage)
    if [ -n "$RELEASE_DIR" ]; then fail "stage accepts --releases-dir, not --release-dir"; fi
    if [ -z "$RELEASES_DIR" ]; then
      RELEASES_DIR="${HOME:?HOME is required}/Library/Application Support/ClaudeCompany/releases"
    fi
    if [[ "$RELEASES_DIR" != /* ]]; then fail "--releases-dir must be absolute"; fi
    verify_git_release "$SOURCE_ROOT"
    "$NODE_BIN" "$SCRIPT_DIR/launchd-runner.mjs" validate-upgrade-env \
      --env "$ENV_FILE" --legacy-workdir "$LEGACY_WORKDIR" --commit "$EXPECTED_COMMIT"

    mkdir -p "$RELEASES_DIR"
    if [ -L "$RELEASES_DIR" ] || [ ! -d "$RELEASES_DIR" ]; then
      fail "release parent must be a regular non-symlink directory"
    fi
    chmod 700 "$RELEASES_DIR"
    FINAL_RELEASE="$RELEASES_DIR/$EXPECTED_COMMIT"
    if [ -e "$FINAL_RELEASE" ] || [ -L "$FINAL_RELEASE" ]; then
      fail "release already exists: $FINAL_RELEASE"
    fi
    STAGE_PARENT="$(mktemp -d "$RELEASES_DIR/.staging.XXXXXXXX")"
    STAGED_REPO="$STAGE_PARENT/source"
    cleanup_stage() {
      if [ -d "${STAGE_PARENT:-}" ]; then
        echo "incomplete stage retained for inspection: $STAGE_PARENT" >&2
      fi
    }
    trap cleanup_stage EXIT
    "$GIT_BIN" clone --quiet --no-hardlinks --no-checkout "$SOURCE_ROOT" "$STAGED_REPO"
    "$GIT_BIN" -C "$STAGED_REPO" checkout --quiet --detach "$EXPECTED_COMMIT"
    verify_git_release "$STAGED_REPO"
    NPM_BIN="$(command -v npm || true)"
    if [ -z "$NPM_BIN" ]; then fail "npm is required to install the locked executor dependencies"; fi
    "$NPM_BIN" ci --prefix "$STAGED_REPO/executor" --ignore-scripts
    for file in "${RUNTIME_PATHS[@]}"; do
      case "$file" in executor/*.mjs) "$NODE_BIN" --check "$STAGED_REPO/$file" >/dev/null;; esac
    done
    "$NODE_BIN" "$STAGED_REPO/executor/test-install.mjs" "$STAGED_REPO"
    "$NODE_BIN" "$STAGED_REPO/executor/test-launchd.mjs"
    "$NODE_BIN" "$STAGED_REPO/executor/test-sleep-assertion.mjs"
    "$NODE_BIN" "$STAGED_REPO/executor/test-monitor.mjs"
    "$NODE_BIN" "$STAGED_REPO/executor/test-heartbeat-health.mjs"
    "$NODE_BIN" "$STAGED_REPO/executor/test-live-gates.mjs"
    "$NODE_BIN" "$STAGED_REPO/executor/test-journal.mjs"
    "$NODE_BIN" "$STAGED_REPO/executor/test-live-execution.mjs"
    verify_git_release "$STAGED_REPO"
    mv "$STAGED_REPO" "$FINAL_RELEASE"
    rmdir "$STAGE_PARENT"
    STAGE_PARENT=""
    trap - EXIT
    echo "Staged complete immutable release: $FINAL_RELEASE"
    echo "No process, environment, wallet, journal, cap, or sentinel was changed."
    ;;
  install)
    if [ -n "$RELEASES_DIR" ]; then fail "install accepts --release-dir, not --releases-dir"; fi
    if [ -z "$RELEASE_DIR" ] || [[ "$RELEASE_DIR" != /* ]]; then
      fail "install requires an absolute --release-dir"
    fi
    if [ ! -d "$RELEASE_DIR" ] || [ -L "$RELEASE_DIR" ]; then
      fail "--release-dir must be an existing regular non-symlink directory"
    fi
    RELEASE_DIR="$(cd "$RELEASE_DIR" && pwd -P)"
    verify_git_release "$RELEASE_DIR"
    RELEASE_EXECUTOR="$RELEASE_DIR/executor"
    RELEASE_RUNNER="$RELEASE_EXECUTOR/launchd-runner.mjs"
    RELEASE_CONTROLLER="$RELEASE_EXECUTOR/macos-launchagent.sh"
    "$NODE_BIN" "$RELEASE_RUNNER" validate-upgrade-env \
      --env "$ENV_FILE" --legacy-workdir "$LEGACY_WORKDIR" --commit "$EXPECTED_COMMIT"
    SERVICE_TARGET="gui/$(id -u)/$LABEL"
    if /bin/launchctl print "$SERVICE_TARGET" >/dev/null 2>&1; then
      fail "LaunchAgent is loaded; unload it explicitly before install"
    fi

    ENV_BACKUP="${ENV_FILE}.previous-${EXPECTED_COMMIT:0:12}-$$"
    ENV_UPDATED=0
    rollback_environment() {
      local status="$?"
      trap - EXIT
      if [ "$status" -ne 0 ] && [ "$ENV_UPDATED" -eq 1 ]; then
        if ! "$NODE_BIN" "$RELEASE_RUNNER" restore-upgrade-env \
          --env "$ENV_FILE" --backup "$ENV_BACKUP" --commit "$EXPECTED_COMMIT"; then
          echo "automatic environment rollback failed; keep the LaunchAgent disabled and inspect $ENV_BACKUP" >&2
        fi
      fi
      exit "$status"
    }
    trap rollback_environment EXIT
    "$NODE_BIN" "$RELEASE_RUNNER" update-upgrade-env \
      --env "$ENV_FILE" --legacy-workdir "$LEGACY_WORKDIR" \
      --commit "$EXPECTED_COMMIT" --backup "$ENV_BACKUP"
    ENV_UPDATED=1
    bash "$RELEASE_CONTROLLER" install \
      --executor-dir "$RELEASE_EXECUTOR" --env-file "$ENV_FILE"
    ENV_UPDATED=0
    trap - EXIT
    echo "Installed disabled versioned release $EXPECTED_COMMIT."
    echo "Entry pause, hard stop, wallet, journal, and secrets were preserved; core exposure caps were never raised."
    echo "This release defaults gross ATA rent to 4,200,000 lamports while retaining any explicit lower value."
    echo "Owner-only rollback environment: $ENV_BACKUP"
    echo "Next, explicitly load only after reviewing the pause and monitor plan:"
    printf '  bash %q load --executor-dir %q --env-file %q\n' \
      "$RELEASE_CONTROLLER" "$RELEASE_EXECUTOR" "$ENV_FILE"
    ;;
esac
