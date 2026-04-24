#!/bin/zsh
set -euo pipefail
echo "1"

SCRIPT_DIR=${0:A:h}
PLIST_SOURCE="$SCRIPT_DIR/launchd/in.nandakrishnan.gemini-remote.host.plist"
PLIST_DEST="/Library/LaunchDaemons/in.nandakrishnan.gemini-remote.host.plist"
LABEL="in.nandakrishnan.gemini-remote.host"

echo "2"
if [[ ! -f "$PLIST_SOURCE" ]]; then
  echo "Missing plist: $PLIST_SOURCE" >&2
  exit 1
fi

echo "3"
plutil -lint "$PLIST_SOURCE" >/dev/null

echo "4"
if launchctl print "system/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "system/$LABEL" || true
fi

echo "5"
install -o root -g wheel -m 644 "$PLIST_SOURCE" "$PLIST_DEST"
echo "6"
launchctl enable "system/$LABEL" || true
echo "7"
launchctl bootstrap system "$PLIST_DEST"
echo "8"
launchctl kickstart -k "system/$LABEL"

echo "9. Installed $PLIST_DEST"
launchctl print "system/$LABEL"
echo "done"
