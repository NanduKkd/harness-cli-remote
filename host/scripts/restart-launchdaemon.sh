#!/bin/zsh
set -euo pipefail

SCRIPT_DIR=${0:A:h}
HOST_DIR=${SCRIPT_DIR:h}
LABEL="in.nandakrishnan.gemini-remote.host"
PLIST_DEST="/Library/LaunchDaemons/${LABEL}.plist"

cd "$HOST_DIR"

echo "Building host..."
npm run build

if [[ ! -f "$PLIST_DEST" ]]; then
  echo "LaunchDaemon is not installed: $PLIST_DEST" >&2
  echo "Run sudo ./scripts/install-launchdaemon.sh first." >&2
  exit 1
fi

echo "Restarting $LABEL..."
launchctl kickstart -k "system/$LABEL"

echo "Status:"
launchctl print "system/$LABEL"
