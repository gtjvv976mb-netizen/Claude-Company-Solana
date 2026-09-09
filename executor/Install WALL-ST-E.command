#!/bin/bash
# Double-clickable macOS launcher for the WALL-ST-E installer.
#
# It runs the SAME one-liner the site prints; it is not a second installer and it
# holds no policy of its own. Its whole job is to get a person who will not open a
# terminal to the point where install.sh is running, and to tell them in plain words
# what is about to happen BEFORE it happens — because the thing on the other end of
# this file can, later and deliberately, trade real money.
#
# Deliberately NOT here: any credential, any wallet, any cap, any acknowledgement.
# This launcher passes a floor number and nothing else. Since 2026-09-09 install.sh
# arms by default, so this reaches a live executor — but every value that makes that
# real is still asked for by install.sh itself, on the terminal, one at a time: the
# published commit, two RPCs, a Jupiter key, and the burner's own public key retyped.
# None of them is ever a flag this file could set on someone's behalf.
set -u

STATIC="${STATIC:-https://claudedotcompany.com}"

printf '\n'
printf '════════════════════════════════════════════════════════════════\n'
printf '  WALL-ST-E — install for your Claude Company floor\n'
printf '════════════════════════════════════════════════════════════════\n\n'
cat <<'ABOUT'
  What this does, in order:

    1. Downloads the installer from claudedotcompany.com and shows you its
       SHA-256 so you can compare it with the value the site displays.
    2. Runs it. It creates a brand-new, EMPTY wallet on this machine, saves the
       key locally at ~/claudeco-executor/burner.json, and installs WALL-ST-E
       as a background LaunchAgent that starts again whenever you log in.
    3. Asks you, on this screen, for what real trading needs: the published
       release commit shown next to the install button, two Solana RPC
       endpoints from different providers, and a Jupiter API key. Then it
       makes you retype the new wallet's own public address before it arms.

  This installs a bot that trades REAL MONEY. There is no rehearsal step to
  do first and no second command later — this is the one install.

  What it does NOT do:

    · It does not fund anything. The wallet it makes starts empty, and an
      empty wallet cannot trade, so nothing moves until you send it SOL
      yourself from your own wallet. That transfer is the on switch.
    · It does not ask for a wallet you already own, a seed phrase, or a
      private key, and it sends no key anywhere. The key it makes stays on
      this disk. Back it up before you fund it.
    · It cannot be steered from the website. Nothing can start, stop, fund or
      sign for this bot except you, on this machine.

ABOUT

if [ "$(uname -s)" = "Darwin" ]; then
  # Until 2026-09-06 this said the installer targets Linux and would stop here.
  # It no longer does: install.sh supervises a Mac through launchd, using the same
  # macos-launchagent.sh this project already runs its own executor with.
  cat <<'MAC'
  On a Mac, WALL-ST-E is installed as a per-user LaunchAgent called
  com.claudeco.wallste. No administrator password is asked for, nothing is
  installed outside your home folder, and you can stop it at any time with the
  command the installer prints when it finishes.

  Two things worth knowing before you fund anything:

    · A laptop that is asleep is not trading. For a wallet you intend to fund,
      a machine that stays awake is the safer host.
    · If a WALL-ST-E agent is already running on this Mac, the installer stops
      and says so rather than installing over it.

MAC
else
  cat <<'OTHER'
  ⚠  This launcher is written for macOS. On Linux, run the same one-liner in a
     terminal instead; on Windows, install Ubuntu under WSL2 and run it there.
     The installer will print the exact commands if you continue.

OTHER
fi

printf '  Press Return to continue, or close this window to stop.\n'
IFS= read -r _ < /dev/tty || exit 1

FLOOR=""
while [ -z "$FLOOR" ]; do
  printf '\n  Your floor number (the number shown on your floor page): '
  IFS= read -r FLOOR < /dev/tty || exit 1
  case "$FLOOR" in
    ''|*[!0-9]*) printf '  That is not a number. Digits only, e.g. 14\n'; FLOOR="";;
    0) printf '  Floor numbers start at 1.\n'; FLOOR="";;
  esac
done

printf '\n  ▶ downloading %s/install.sh …\n' "$STATIC"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/wallste-install.XXXXXXXX")" || exit 1
trap 'rm -rf "$TMP"' EXIT
# The short /install.sh path and the long /executor/install.sh path are published as
# identical bytes. Try the short one, fall back to the long one: a launcher already
# sitting in someone's Downloads folder must not break the day the short path moves.
if ! curl -fsSL "$STATIC/install.sh" -o "$TMP/install.sh" &&
   ! curl -fsSL "$STATIC/executor/install.sh" -o "$TMP/install.sh"; then
  printf '\n  ✗ could not download the installer from %s\n' "$STATIC"
  printf '    Check this Mac is online, then run this file again.\n\n'
  printf '  Press Return to close.\n'; IFS= read -r _ < /dev/tty || true
  exit 1
fi
# Downloading to a file first, rather than piping curl straight into bash, exists for
# exactly one reason: it lets the person see the checksum of the bytes that are about
# to run and compare it with the site. A pipe gives them nothing to compare.
printf '  SHA-256 of the downloaded installer:\n    %s\n' \
  "$(shasum -a 256 "$TMP/install.sh" | awk '{print $1}')"
printf '  Compare that with the value shown next to the install button on %s\n' "$STATIC"
printf '\n  Have the published release commit ready — it is the 40-character\n'
printf '  value shown next to the install button on %s\n' "$STATIC"
printf '\n  Press Return to run the installer, or close this window.\n'
IFS= read -r _ < /dev/tty || exit 1
printf '\n'

bash "$TMP/install.sh" --floor "$FLOOR"
status="$?"

printf '\n  installer finished with exit code %s\n' "$status"
printf '  Press Return to close this window.\n'
IFS= read -r _ < /dev/tty || true
exit "$status"
