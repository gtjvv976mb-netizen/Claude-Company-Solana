#!/usr/bin/env bash
# Install WALL-ST-E's outbound-only polling executor on Debian/Ubuntu + systemd.
# Dry run is the default. --live is an explicit, locally acknowledged mode.
set -euo pipefail
umask 077

MODE="paper"
SECRET=""
SECRET_FILE=""
JUPITER_KEY=""
JUPITER_KEY_FILE=""
FLOOR=""
MAX_SOL=""
DAILY_CAP=""
DAILY_LOSS_CAP=""
MAX_SOL_SET=0
DAILY_CAP_SET=0
DAILY_LOSS_CAP_SET=0
RPC=""
SECONDARY_RPC=""
RPC_FILE=""
SECONDARY_RPC_FILE=""
SOURCE_DIR=""
SOURCE_COMMIT="remote-paper"
EXPECTED_COMMIT=""
API="https://claude-company-api.onrender.com"
STATIC="https://claudedotcompany.com"

# BEGIN SYSTEMD_ENV_WRITER
# EnvironmentFile is not a shell script. Quote every value using systemd's
# double-quoted syntax so URLs and credentials containing shell metacharacters are
# stored literally. Newlines cannot exist in a process environment and would also
# turn one assignment into several, so reject them explicitly.
systemd_env_value() {
  local value="$1"
  case "$value" in
    *$'\n'*|*$'\r'*) echo "environment values cannot contain newlines" >&2; return 1;;
  esac
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//\$/\\\$}"
  value="${value//\`/\\\`}"
  printf '"%s"' "$value"
}

write_env_line() {
  local name="$1" value="$2"
  if ! [[ "$name" =~ ^[A-Z_][A-Z0-9_]*$ ]]; then
    echo "invalid environment variable name: $name" >&2
    return 1
  fi
  printf '%s=' "$name"
  systemd_env_value "$value"
  printf '\n'
}
# END SYSTEMD_ENV_WRITER

need_value() {
  if [ "$#" -lt 2 ] || [ -z "$2" ]; then
    echo "missing value for $1" >&2
    exit 1
  fi
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --live) MODE="live"; shift;;
    --secret-file) need_value "$@"; SECRET_FILE="$2"; shift 2;;
    --jupiter-key-file) need_value "$@"; JUPITER_KEY_FILE="$2"; shift 2;;
    --floor) need_value "$@"; FLOOR="$2"; shift 2;;
    --max-sol) need_value "$@"; MAX_SOL="$2"; MAX_SOL_SET=1; shift 2;;
    --daily-cap) need_value "$@"; DAILY_CAP="$2"; DAILY_CAP_SET=1; shift 2;;
    --daily-loss-cap) need_value "$@"; DAILY_LOSS_CAP="$2"; DAILY_LOSS_CAP_SET=1; shift 2;;
    --rpc) need_value "$@"; RPC="$2"; shift 2;;
    --rpc-file) need_value "$@"; RPC_FILE="$2"; shift 2;;
    --secondary-rpc) need_value "$@"; SECONDARY_RPC="$2"; shift 2;;
    --secondary-rpc-file) need_value "$@"; SECONDARY_RPC_FILE="$2"; shift 2;;
    --source-dir) need_value "$@"; SOURCE_DIR="$2"; shift 2;;
    --expected-commit) need_value "$@"; EXPECTED_COMMIT="${2,,}"; shift 2;;
    --api) need_value "$@"; API="$2"; shift 2;;
    --static) need_value "$@"; STATIC="$2"; shift 2;;
    *) echo "unknown flag: $1" >&2; exit 1;;
  esac
done

if [ "$(uname -s)" != "Linux" ] || ! command -v systemctl >/dev/null 2>&1; then
  echo "install.sh provisions Linux hosts using systemd only" >&2
  echo "macos-launchagent.sh can supervise an existing configured macOS executor; it is not a fresh-wallet installer" >&2
  exit 1
fi
case "$FLOOR" in
  ""|*[!0-9]*) echo "--floor must be a positive integer" >&2; exit 1;;
esac
if [ "$FLOOR" -le 0 ]; then echo "--floor must be a positive integer" >&2; exit 1; fi

read_private_file() {
  local label="$1" file="$2" mode
  if [ ! -f "$file" ] || [ ! -r "$file" ] || [ -L "$file" ]; then
    echo "$label file is not a readable regular non-symlink file: $file" >&2
    exit 1
  fi
  mode="$(stat -c '%a' "$file")"
  if (( (8#$mode & 8#077) != 0 )); then
    echo "$label file must not be accessible by group/other (chmod 600 $file)" >&2
    exit 1
  fi
  IFS= read -r REPLY < "$file" || true
}

if [ -n "$RPC_FILE" ]; then
  if [ -n "$RPC" ]; then echo "use either --rpc or --rpc-file, not both" >&2; exit 1; fi
  read_private_file "primary RPC" "$RPC_FILE"
  RPC="$REPLY"
fi
if [ -n "$SECONDARY_RPC_FILE" ]; then
  if [ -n "$SECONDARY_RPC" ]; then
    echo "use either --secondary-rpc or --secondary-rpc-file, not both" >&2
    exit 1
  fi
  read_private_file "secondary RPC" "$SECONDARY_RPC_FILE"
  SECONDARY_RPC="$REPLY"
fi

# A file-based invocation from a checked-out release automatically stages the five
# sibling runtime modules. Piped execution has no trusted sibling directory and is
# therefore never accepted for live signing.
if [ -z "$SOURCE_DIR" ] && [ -f "${BASH_SOURCE[0]:-}" ]; then
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
  if [ -f "$script_dir/poller.mjs" ] && [ -f "$script_dir/package-lock.json" ]; then
    SOURCE_DIR="$script_dir"
  fi
fi
if [ -n "$SOURCE_DIR" ]; then
  SOURCE_DIR="$(cd "$SOURCE_DIR" && pwd -P)"
fi
if [ "$MODE" = "live" ] && [ -z "$SOURCE_DIR" ]; then
  echo "live mode requires --source-dir from a locally pinned Claude Company checkout" >&2
  exit 1
fi
if [ "$MODE" = "live" ]; then
  if ! command -v git >/dev/null 2>&1 ||
     ! source_root="$(git -C "$SOURCE_DIR" rev-parse --show-toplevel 2>/dev/null)"; then
    echo "live source must be inside a Git checkout" >&2
    exit 1
  fi
  source_root="$(cd "$source_root" && pwd -P)"
  if [ "$SOURCE_DIR" != "$source_root/executor" ]; then
    echo "live --source-dir must be the checkout's executor directory" >&2
    exit 1
  fi
  if git -C "$source_root" symbolic-ref -q HEAD >/dev/null 2>&1; then
    echo "live source must be detached at the published commit, not a moving branch" >&2
    exit 1
  fi
  SOURCE_COMMIT="$(git -C "$source_root" rev-parse HEAD)"
  if ! [[ "$SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
    echo "live source commit is invalid" >&2
    exit 1
  fi
  if ! [[ "$EXPECTED_COMMIT" =~ ^[0-9a-f]{40}$ ]] || [ "$EXPECTED_COMMIT" != "$SOURCE_COMMIT" ]; then
    echo "live --expected-commit must exactly match the published commit $SOURCE_COMMIT" >&2
    exit 1
  fi
  for source_file in poller.mjs journal.mjs jupiter.mjs token2022.mjs balance-verification.mjs entry-quote-guard.mjs exit-trigger.mjs feed-drain.mjs sol-usd-oracle.mjs heartbeat-health.mjs sleep-assertion.mjs monitor.mjs strategy.mjs trade-policy.mjs dexscreener-consensus.mjs desk-mirror.mjs package.json package-lock.json; do
    if [ -n "$(git -C "$source_root" status --porcelain -- "executor/$source_file")" ]; then
      echo "live source file executor/$source_file differs from commit $SOURCE_COMMIT" >&2
      exit 1
    fi
  done
elif [ -n "$SOURCE_DIR" ] && command -v git >/dev/null 2>&1; then
  SOURCE_COMMIT="$(git -C "$SOURCE_DIR" rev-parse HEAD 2>/dev/null || echo local-paper)"
fi

if [ -n "$SECRET_FILE" ]; then
  read_private_file "floor secret" "$SECRET_FILE"
  SECRET="$REPLY"
else
  if [ ! -r /dev/tty ]; then
    echo "no terminal available; pass --secret-file with a mode-0600 file" >&2
    exit 1
  fi
  printf "Claude Company executor feed secret: " > /dev/tty
  IFS= read -r -s SECRET < /dev/tty
  printf "\n" > /dev/tty
fi
case "$SECRET" in
  ""|*[!0-9A-Fa-f]*) echo "floor secret must be the hex value shown by the executor panel" >&2; exit 1;;
esac
if [ "${#SECRET}" -lt 32 ]; then echo "floor secret is unexpectedly short" >&2; exit 1; fi

if [ "$MODE" = "live" ]; then
  if [ -n "$JUPITER_KEY_FILE" ]; then
    read_private_file "Jupiter API key" "$JUPITER_KEY_FILE"
    JUPITER_KEY="$REPLY"
  else
    if [ ! -r /dev/tty ]; then
      echo "live mode needs --jupiter-key-file when no terminal is available" >&2
      exit 1
    fi
    printf "Jupiter API key (hidden): " > /dev/tty
    IFS= read -r -s JUPITER_KEY < /dev/tty
    printf "\n" > /dev/tty
  fi
  if [ -z "$JUPITER_KEY" ]; then echo "Jupiter API key is empty" >&2; exit 1; fi
  if [ -z "$RPC_FILE" ] || [ -z "$SECONDARY_RPC_FILE" ]; then
    echo "--live requires --rpc-file and --secondary-rpc-file so credentials stay out of argv/history" >&2
    exit 1
  fi
  if [ -z "$RPC" ] || [ -z "$SECONDARY_RPC" ]; then
    echo "both live RPC credential files must contain a private HTTPS endpoint" >&2
    exit 1
  fi
  if [ "$SECONDARY_RPC" = "$RPC" ]; then
    echo "--secondary-rpc must be independent from --rpc" >&2
    exit 1
  fi
fi

# BEGIN LIVE_CAPS_VALIDATOR
LIVE_CANARY_MAX_SOL="0.005"
LIVE_CANARY_DAILY_CAP="0.01"
LIVE_CANARY_DAILY_LOSS_CAP="0.01"
LIVE_MIN_MONEY_CAP="0.000001"
LIVE_OPERATOR_MAX_SOL="0.05"
LIVE_OPERATOR_MAX_DAILY_CAP="0.5"
LIVE_OPERATOR_MAX_DAILY_LOSS_CAP="0.15"

if [ -z "$MAX_SOL" ]; then [ "$MODE" = "live" ] && MAX_SOL="$LIVE_CANARY_MAX_SOL" || MAX_SOL="0.05"; fi
if [ -z "$DAILY_CAP" ]; then [ "$MODE" = "live" ] && DAILY_CAP="$LIVE_CANARY_DAILY_CAP" || DAILY_CAP="0.5"; fi
if [ -z "$DAILY_LOSS_CAP" ]; then
  [ "$MODE" = "live" ] && DAILY_LOSS_CAP="$LIVE_CANARY_DAILY_LOSS_CAP" || DAILY_LOSS_CAP="0.15"
fi
# One SOL has exactly 1e9 lamports. Limiting cap literals to that precision keeps
# the comparison exact enough for the declared unit and prevents awk's binary
# floating-point conversion from rounding a mathematically out-of-range literal
# onto an accepted boundary.
number_re='^(0|[1-9][0-9]*)([.][0-9]{1,9})?$'
if ! [[ "$MAX_SOL" =~ $number_re ]] || ! [[ "$DAILY_CAP" =~ $number_re ]] ||
   ! [[ "$DAILY_LOSS_CAP" =~ $number_re ]] ||
   ! awk -v m="$MAX_SOL" -v d="$DAILY_CAP" -v l="$DAILY_LOSS_CAP" \
     -v minimum="$LIVE_MIN_MONEY_CAP" \
     'BEGIN { exit !(m >= minimum && d >= minimum && l >= minimum) }'; then
  echo "--max-sol, --daily-cap, and --daily-loss-cap must be plain decimals at least 0.000001 with at most 9 fractional digits" >&2
  exit 1
fi
CAPS_RAISED=0
if [ "$MODE" = "live" ]; then
  if ! awk -v m="$MAX_SOL" -v d="$DAILY_CAP" -v l="$DAILY_LOSS_CAP" \
      -v mm="$LIVE_OPERATOR_MAX_SOL" -v dm="$LIVE_OPERATOR_MAX_DAILY_CAP" \
      -v lm="$LIVE_OPERATOR_MAX_DAILY_LOSS_CAP" \
      'BEGIN { exit !(m <= mm && d <= dm && l <= lm) }'; then
    echo "live caps cannot exceed 0.05 SOL per trade, 0.5 SOL daily deploy, or a 0.15 SOL daily realized-loss entry brake" >&2
    exit 1
  fi
  if awk -v m="$MAX_SOL" -v d="$DAILY_CAP" -v l="$DAILY_LOSS_CAP" \
      -v cm="$LIVE_CANARY_MAX_SOL" -v cd="$LIVE_CANARY_DAILY_CAP" \
      -v cl="$LIVE_CANARY_DAILY_LOSS_CAP" \
      'BEGIN { exit !(m > cm || d > cd || l > cl) }'; then
    CAPS_RAISED=1
    if [ "$MAX_SOL_SET" -ne 1 ] || [ "$DAILY_CAP_SET" -ne 1 ] || [ "$DAILY_LOSS_CAP_SET" -ne 1 ]; then
      echo "raising any live cap requires --max-sol, --daily-cap, and --daily-loss-cap together" >&2
      exit 1
    fi
  fi
fi
if ! awk -v m="$MAX_SOL" -v d="$DAILY_CAP" 'BEGIN { exit !(m <= d) }'; then
  echo "--daily-cap must be greater than or equal to --max-sol" >&2
  exit 1
fi
# END LIVE_CAPS_VALIDATOR

validate_https_endpoint() {
  local label="$1" endpoint="$2"
  case "$endpoint" in https://*) ;; *) echo "$label must use https" >&2; exit 1;; esac
  case "$endpoint" in *$'\n'*|*$'\r'*) echo "$label cannot contain newlines" >&2; exit 1;; esac
}

validate_https_endpoint "API endpoint" "$API"
validate_https_endpoint "static endpoint" "$STATIC"
if [ -n "$RPC" ]; then validate_https_endpoint "primary RPC" "$RPC"; fi
if [ -n "$SECONDARY_RPC" ]; then validate_https_endpoint "secondary RPC" "$SECONDARY_RPC"; fi

if [ "$MODE" = "live" ]; then
  rpc_lower="${RPC,,}"
  secondary_lower="${SECONDARY_RPC,,}"
  if [[ "$rpc_lower" =~ api\.mainnet-beta\.solana\.com ]] ||
     [[ "$secondary_lower" =~ api\.mainnet-beta\.solana\.com ]]; then
    echo "public Solana RPC is not accepted for either live endpoint; use two private providers" >&2
    exit 1
  fi
fi

INSTALL_DIR="$HOME/claudeco-executor"
ENV_FILE="$INSTALL_DIR/.cc-executor.env"
STATE_DB="$INSTALL_DIR/.cc-executor.sqlite"
LOCK_FILE="${STATE_DB}.lock"
PAUSE_FILE="$INSTALL_DIR/PAUSE_ENTRIES"
HARD_STOP_FILE="$INSTALL_DIR/HARD_STOP"
RELEASES_DIR="$INSTALL_DIR/releases"
CURRENT_LINK="$INSTALL_DIR/current"
SERVICE_FILE="/etc/systemd/system/cc-executor.service"
echo "▶ installing WALL-ST-E ($MODE mode) into $INSTALL_DIR"

node_ok=0
if command -v node >/dev/null 2>&1; then
  node_ok="$(node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.stdout.write(String(a<25&&(a>22||(a===22&&b>=13))?1:0))')"
fi
if [ "$node_ok" != "1" ]; then
  echo "Node >=22.13 and <25 is required; install it from a package source you trust, then rerun" >&2
  exit 1
fi
node_ok="$(node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.stdout.write(String(a<25&&(a>22||(a===22&&b>=13))?1:0))')"
if [ "$node_ok" != "1" ]; then echo "Node >=22.13 and <25 is required for the durable SQLite journal" >&2; exit 1; fi

if [ "$MODE" = "live" ]; then
  PRIMARY_RPC="$RPC" SECONDARY_RPC_VALUE="$SECONDARY_RPC" node - <<'NODE'
const primary = new URL(process.env.PRIMARY_RPC);
const secondary = new URL(process.env.SECONDARY_RPC_VALUE);
const host = (url) => url.hostname.toLowerCase().replace(/[.]$/, "");
if (primary.protocol !== "https:" || secondary.protocol !== "https:") {
  console.error("both live RPC endpoints must use HTTPS");
  process.exit(1);
}
if (host(primary) === host(secondary)) {
  console.error("--secondary-rpc must use an independent provider hostname from --rpc");
  process.exit(1);
}
NODE
fi

mkdir -p "$INSTALL_DIR" "$RELEASES_DIR"
chmod 700 "$INSTALL_DIR"
chmod 700 "$RELEASES_DIR"
if [ -e "$CURRENT_LINK" ] && [ ! -L "$CURRENT_LINK" ]; then
  echo "$CURRENT_LINK exists but is not a symlink; refusing an unsafe in-place upgrade" >&2
  exit 1
fi

STAGE_DIR="$(mktemp -d "$RELEASES_DIR/.staging.XXXXXXXX")"
RELEASE_DIR=""
ENV_NEXT="$INSTALL_DIR/.cc-executor.env.next.$$"
UNIT_NEXT="$INSTALL_DIR/.cc-executor.service.next.$$"
ENV_BACKUP="$INSTALL_DIR/.cc-executor.env.previous.$$"
UNIT_BACKUP="$INSTALL_DIR/.cc-executor.service.previous.$$"
STATE_BACKUP="$INSTALL_DIR/.cc-executor.sqlite.previous.$$"
LINK_NEXT="$INSTALL_DIR/.current.next.$$"
LINK_RESTORE="$INSTALL_DIR/.current.restore.$$"
SERVICE_WAS_ACTIVE=0
SERVICE_WAS_ENABLED=0
SERVICE_STOPPED=0
ENV_ACTIVATED=0
CURRENT_ACTIVATED=0
SERVICE_UPDATED=0
SERVICE_ENABLE_CHANGED=0
ACTIVATION_COMMITTED=0
STATE_HAD_FILE=0
STATE_PREPARED=0
ENV_HAD_FILE=0
UNIT_HAD_FILE=0
CURRENT_HAD_LINK=0
OLD_CURRENT_TARGET=""

rollback_install() {
  local status="$?"
  trap - EXIT
  if [ "$status" -ne 0 ] && [ "$ACTIVATION_COMMITTED" -eq 0 ]; then
    echo "installation failed; restoring the previous executor release" >&2
    set +e
    if [ "$SERVICE_UPDATED" -eq 1 ] || [ "$CURRENT_ACTIVATED" -eq 1 ]; then
      sudo systemctl stop cc-executor >/dev/null 2>&1
    fi
    if [ "$SERVICE_UPDATED" -eq 1 ]; then
      if [ "$UNIT_HAD_FILE" -eq 1 ]; then
        sudo install -m 0644 "$UNIT_BACKUP" "$SERVICE_FILE"
      else
        sudo rm -f "$SERVICE_FILE"
      fi
    fi
    if [ "$CURRENT_ACTIVATED" -eq 1 ]; then
      if [ "$CURRENT_HAD_LINK" -eq 1 ]; then
        ln -s "$OLD_CURRENT_TARGET" "$LINK_RESTORE"
        mv -Tf "$LINK_RESTORE" "$CURRENT_LINK"
      else
        rm -f "$CURRENT_LINK"
      fi
    fi
    if [ "$ENV_ACTIVATED" -eq 1 ]; then
      if [ "$ENV_HAD_FILE" -eq 1 ]; then
        mv -f "$ENV_BACKUP" "$ENV_FILE"
      else
        rm -f "$ENV_FILE"
      fi
    fi
    if [ "$STATE_PREPARED" -eq 1 ]; then
      if [ "$STATE_HAD_FILE" -eq 1 ] && [ -f "$STATE_BACKUP" ]; then
        rm -f "$STATE_DB-wal" "$STATE_DB-shm"
        cp -p "$STATE_BACKUP" "$STATE_DB"
      elif [ "$STATE_HAD_FILE" -eq 0 ]; then
        rm -f "$STATE_DB" "$STATE_DB-wal" "$STATE_DB-shm"
      fi
    fi
    sudo systemctl daemon-reload >/dev/null 2>&1
    if [ "$SERVICE_ENABLE_CHANGED" -eq 1 ] && [ "$SERVICE_WAS_ENABLED" -eq 0 ]; then
      sudo systemctl disable cc-executor >/dev/null 2>&1
    fi
    if [ "$SERVICE_WAS_ACTIVE" -eq 1 ]; then
      sudo systemctl restart cc-executor >/dev/null 2>&1
    fi
    set -e
  elif [ "$status" -ne 0 ]; then
    echo "installation ended after the new service start boundary; durable state was not rolled back" >&2
  fi
  rm -f "$ENV_NEXT" "$UNIT_NEXT" "$LINK_NEXT" "$LINK_RESTORE"
  rm -f "$ENV_BACKUP" "$STATE_BACKUP"
  if [ -n "$STAGE_DIR" ] && [ -d "$STAGE_DIR" ]; then rm -rf "$STAGE_DIR"; fi
  if [ "$status" -ne 0 ] && [ "$ACTIVATION_COMMITTED" -eq 0 ] &&
     [ -n "$RELEASE_DIR" ] && [ -d "$RELEASE_DIR" ]; then
    rm -rf "$RELEASE_DIR"
  fi
  if [ -f "$UNIT_BACKUP" ]; then sudo rm -f "$UNIT_BACKUP"; fi
  exit "$status"
}
trap rollback_install EXIT

echo "▶ fetching the executor and shared policy…"
RUNTIME_FILES=(poller.mjs journal.mjs jupiter.mjs token2022.mjs balance-verification.mjs entry-quote-guard.mjs exit-trigger.mjs feed-drain.mjs sol-usd-oracle.mjs heartbeat-health.mjs sleep-assertion.mjs monitor.mjs strategy.mjs trade-policy.mjs dexscreener-consensus.mjs desk-mirror.mjs)
SOURCE_FILES=("${RUNTIME_FILES[@]}" package.json package-lock.json)
if [ "$MODE" = "live" ]; then
  echo "▶ staging immutable runtime blobs from commit $SOURCE_COMMIT"
  for file in "${SOURCE_FILES[@]}"; do
    git -C "$source_root" cat-file blob "$SOURCE_COMMIT:executor/$file" > "$STAGE_DIR/$file" || {
      echo "published commit is missing executor/$file" >&2
      exit 1
    }
  done
elif [ -n "$SOURCE_DIR" ]; then
  echo "▶ staging pinned runtime from $SOURCE_DIR"
  for file in "${SOURCE_FILES[@]}"; do
    if [ ! -f "$SOURCE_DIR/$file" ] || [ -L "$SOURCE_DIR/$file" ]; then
      echo "pinned source is missing a regular non-symlink $file" >&2
      exit 1
    fi
    cp "$SOURCE_DIR/$file" "$STAGE_DIR/$file"
  done
else
  echo "WARNING: remote runtime fallback is paper-mode only; use a pinned checkout for live signing" >&2
  for file in "${SOURCE_FILES[@]}"; do
    curl -fsSL "$STATIC/executor/$file" -o "$STAGE_DIR/$file" || {
      echo "could not download $file" >&2
      exit 1
    }
  done
fi
for file in "${RUNTIME_FILES[@]}"; do
  node --check "$STAGE_DIR/$file" >/dev/null 2>&1 || { echo "staged $file is not valid JS" >&2; exit 1; }
done
(cd "$STAGE_DIR" && npm ci --ignore-scripts --silent >/dev/null 2>&1)
RELEASE_DIR="$RELEASES_DIR/$(date -u +%Y%m%dT%H%M%SZ)-${SOURCE_COMMIT:0:12}-$$"
mv "$STAGE_DIR" "$RELEASE_DIR"
STAGE_DIR=""

if [ ! -f "$INSTALL_DIR/burner.json" ]; then
  echo "▶ generating a dedicated, unfunded burner wallet locally…"
  (cd "$RELEASE_DIR" && BURNER_FILE="$INSTALL_DIR/burner.json" node -e 'const{Keypair}=require("@solana/web3.js");const fs=require("fs");const k=Keypair.generate();fs.writeFileSync(process.env.BURNER_FILE,JSON.stringify(Array.from(k.secretKey)),{mode:0o600})')
fi
chmod 600 "$INSTALL_DIR/burner.json"
PUBKEY="$(cd "$RELEASE_DIR" && BURNER_FILE="$INSTALL_DIR/burner.json" node -e 'const{Keypair}=require("@solana/web3.js");const fs=require("fs");console.log(Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(process.env.BURNER_FILE)))).publicKey.toBase58())')"

LIVE_ACK=""
LIVE_CAPS_ACK=""
EXECUTE_VALUE="0"
if [ "$MODE" = "live" ]; then
  if [ ! -r /dev/tty ]; then echo "live mode requires a terminal acknowledgement" >&2; exit 1; fi
  cat > /dev/tty <<NOTICE

WALL-ST-E LIVE CANARY
  Wallet:       $PUBKEY
  Max/trade:    $MAX_SOL SOL
  Rolling deploy: $DAILY_CAP SOL / 24h
  Realized-loss entry brake: $DAILY_LOSS_CAP SOL / rolling 24h

This is real mainnet trading from a dedicated wallet. The site cannot stop it.
Retype the public wallet above to arm this local service:
NOTICE
  IFS= read -r LIVE_ACK < /dev/tty
  if [ "$LIVE_ACK" != "$PUBKEY" ]; then echo "public-key acknowledgement did not match; live mode not armed" >&2; exit 1; fi
  if [ "$CAPS_RAISED" -eq 1 ]; then
    CAPS_ACK_EXPECTED="I acknowledge WALL-ST-E caps v2 for $PUBKEY: $MAX_SOL SOL per trade, $DAILY_CAP SOL per day, $DAILY_LOSS_CAP SOL rolling realized-loss entry brake"
    cat > /dev/tty <<NOTICE

RAISED LIVE CAPS
The canary defaults are 0.005 SOL/trade, 0.01 SOL/day deploy, and a 0.01 SOL rolling realized-loss entry brake.
To accept the higher limits above, type this entire sentence exactly:

$CAPS_ACK_EXPECTED
NOTICE
    IFS= read -r LIVE_CAPS_ACK < /dev/tty
    if [ "$LIVE_CAPS_ACK" != "$CAPS_ACK_EXPECTED" ]; then
      echo "wallet-and-cap acknowledgement did not match; raised live caps not armed" >&2
      exit 1
    fi
  fi
  EXECUTE_VALUE="1"
fi

{
  write_env_line CC_SECRET "$SECRET"
  write_env_line CC_FLOOR "$FLOOR"
  write_env_line CC_API "$API"
  write_env_line KEYPAIR "$INSTALL_DIR/burner.json"
  write_env_line STATE_DB "$STATE_DB"
  write_env_line LOCK_FILE "$LOCK_FILE"
  write_env_line PAUSE_ENTRIES_FILE "$PAUSE_FILE"
  write_env_line HARD_STOP_FILE "$HARD_STOP_FILE"
  write_env_line MAX_SOL_PER_TRADE "$MAX_SOL"
  write_env_line DAILY_SOL_CAP "$DAILY_CAP"
  write_env_line DAILY_LOSS_LIMIT_SOL "$DAILY_LOSS_CAP"
  write_env_line EXECUTE "$EXECUTE_VALUE"
  write_env_line EXECUTOR_SOURCE_COMMIT "$SOURCE_COMMIT"
  if [ "$MODE" = "live" ]; then
    write_env_line LIVE_TRADING_ACK "$LIVE_ACK"
    write_env_line LIVE_CAPS_ACK "$LIVE_CAPS_ACK"
    write_env_line JUPITER_API_KEY "$JUPITER_KEY"
    write_env_line SOLANA_RPC "$RPC"
    write_env_line SOLANA_RPC_SECONDARY "$SECONDARY_RPC"
  elif [ -n "$RPC" ]; then
    write_env_line SOLANA_RPC "$RPC"
    if [ -n "$SECONDARY_RPC" ]; then write_env_line SOLANA_RPC_SECONDARY "$SECONDARY_RPC"; fi
  fi
} > "$ENV_NEXT"
chmod 600 "$ENV_NEXT"

# Validate the complete staged release before stopping an existing executor. From
# this point onward every mutation has a rollback copy and the old process is kept
# stopped until journal initialization, symlink activation and service restart all
# succeed.
if systemctl is-active --quiet cc-executor; then
  SERVICE_WAS_ACTIVE=1
  sudo systemctl stop cc-executor
  SERVICE_STOPPED=1
fi
if systemctl is-enabled --quiet cc-executor 2>/dev/null; then SERVICE_WAS_ENABLED=1; fi
if [ -L "$CURRENT_LINK" ]; then
  CURRENT_HAD_LINK=1
  OLD_CURRENT_TARGET="$(readlink "$CURRENT_LINK")"
fi
if [ -f "$ENV_FILE" ]; then
  ENV_HAD_FILE=1
  cp -p "$ENV_FILE" "$ENV_BACKUP"
fi
if sudo test -f "$SERVICE_FILE"; then
  UNIT_HAD_FILE=1
  sudo cp -p "$SERVICE_FILE" "$UNIT_BACKUP"
fi
if [ -f "$STATE_DB" ]; then
  STATE_HAD_FILE=1
  STATE_DB_PATH="$STATE_DB" node - <<'NODE'
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.STATE_DB_PATH);
db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
db.close();
NODE
  cp -p "$STATE_DB" "$STATE_BACKUP"
fi
STATE_PREPARED=1

# Create and bind the durable journal before systemd starts. The one-time public-key
# acknowledgement is supplied only to this command and is not a persistent bypass.
# These quoted assignment prefixes pass literal values directly to Node; the
# generated EnvironmentFile is never sourced or evaluated as shell code.
CC_SECRET="$SECRET" \
CC_FLOOR="$FLOOR" \
CC_API="$API" \
KEYPAIR="$INSTALL_DIR/burner.json" \
STATE_DB="$STATE_DB" \
LOCK_FILE="$LOCK_FILE" \
PAUSE_ENTRIES_FILE="$PAUSE_FILE" \
HARD_STOP_FILE="$HARD_STOP_FILE" \
MAX_SOL_PER_TRADE="$MAX_SOL" \
DAILY_SOL_CAP="$DAILY_CAP" \
DAILY_LOSS_LIMIT_SOL="$DAILY_LOSS_CAP" \
EXECUTE="$EXECUTE_VALUE" \
LIVE_TRADING_ACK="$LIVE_ACK" \
LIVE_CAPS_ACK="$LIVE_CAPS_ACK" \
JUPITER_API_KEY="$JUPITER_KEY" \
SOLANA_RPC="$RPC" \
SOLANA_RPC_SECONDARY="$SECONDARY_RPC" \
LIVE_STATE_INIT_ACK="$PUBKEY" \
INIT_ONLY=1 \
node "$RELEASE_DIR/poller.mjs"
chmod 600 "$STATE_DB"

ln -s "$RELEASE_DIR" "$LINK_NEXT"
mv -f "$ENV_NEXT" "$ENV_FILE"
ENV_ACTIVATED=1
mv -Tf "$LINK_NEXT" "$CURRENT_LINK"
CURRENT_ACTIVATED=1

NODE_BIN="$(command -v node)"
SERVICE_USER="$(id -un)"
echo "▶ writing hardened systemd service…"
cat > "$UNIT_NEXT" <<UNIT
[Unit]
Description=WALL-ST-E Claude Company polling executor (floor $FLOOR, $MODE)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$CURRENT_LINK
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN $CURRENT_LINK/poller.mjs
Restart=always
RestartSec=5
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ReadWritePaths=$INSTALL_DIR
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
ProtectClock=true
RestrictSUIDSGID=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
LockPersonality=true
SystemCallArchitectures=native

[Install]
WantedBy=multi-user.target
UNIT
chmod 600 "$UNIT_NEXT"
sudo install -m 0644 "$UNIT_NEXT" "$SERVICE_FILE"
SERVICE_UPDATED=1

sudo systemctl daemon-reload
sudo systemctl enable cc-executor >/dev/null 2>&1
SERVICE_ENABLE_CHANGED=1
# From this exact line forward the new process may reconcile or submit durable chain
# state. No later shell/terminal failure is allowed to restore an older SQLite snapshot,
# unit, environment, or runtime. A failed start is repaired in place under operator
# supervision; it is never made to forget what may already have happened on chain.
ACTIVATION_COMMITTED=1
sudo systemctl restart cc-executor
SECRET=""; JUPITER_KEY=""; LIVE_ACK=""; LIVE_CAPS_ACK=""; CAPS_ACK_EXPECTED=""; REPLY=""
unset SECRET JUPITER_KEY LIVE_ACK LIVE_CAPS_ACK CAPS_ACK_EXPECTED REPLY

cat <<DONE

════════════════════════════════════════════════════════════════
  ✓ WALL-ST-E installed for floor $FLOOR in ${MODE^^} mode.

  DEDICATED WALLET (PUBLIC ADDRESS):
      $PUBKEY

  Runtime commit: $SOURCE_COMMIT
  Max $MAX_SOL SOL/trade · $DAILY_CAP SOL/rolling 24h deploy
  Realized-loss entry brake $DAILY_LOSS_CAP SOL/rolling 24h
  Watch:          sudo journalctl -u cc-executor -f
  Pause entries:  touch $PAUSE_FILE
  Hard stop:      touch $HARD_STOP_FILE
  Stop process:   sudo systemctl stop cc-executor
  Protected env:  $ENV_FILE
  Durable state:  $STATE_DB

  No wallet was funded by this installer. The private key stays at
  $INSTALL_DIR/burner.json and must never be uploaded or pasted.
  First feed connection skips historic calls and waits for the next one.
════════════════════════════════════════════════════════════════
DONE
