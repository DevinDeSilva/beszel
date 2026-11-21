#!/usr/bin/env bash
# Install (or upgrade) the fork's Beszel hub on macOS as a launchd user agent,
# so it starts at login and restarts if it exits.
#
# Usage: install-macos-hub.sh [path/to/beszel]   (default: ./beszel)
#
# Env overrides:
#   BESZEL_DIR   install dir    (default ~/Library/Application Support/Beszel)
#   HUB_LISTEN   address:port   (default 0.0.0.0:8090)
#
# Existing data in $BESZEL_DIR/beszel_data is kept and backed up first; the
# previous binary is kept as beszel.prev. To roll back:
#   mv "$BESZEL_DIR/beszel.prev" "$BESZEL_DIR/beszel" && launchctl kickstart -k gui/$(id -u)/com.beszel.hub
set -euo pipefail

SRC="${1:-./beszel}"
BESZEL_DIR="${BESZEL_DIR:-$HOME/Library/Application Support/Beszel}"
HUB_LISTEN="${HUB_LISTEN:-0.0.0.0:8090}"
LABEL=com.beszel.hub
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/beszel-hub.log"
DOMAIN="gui/$(id -u)"

[ "$(uname -s)" = Darwin ] || { echo "this script is for macOS" >&2; exit 1; }
[ -f "$SRC" ] || { echo "hub binary not found: $SRC" >&2; exit 1; }

mkdir -p "$BESZEL_DIR" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"

# stop the launchd job and any hub started by hand from this directory
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
pkill -f "$BESZEL_DIR/beszel " 2>/dev/null || true
pkill -f "beszel --dir ./beszel_data serve" 2>/dev/null || true
sleep 1

if [ -d "$BESZEL_DIR/beszel_data" ]; then
	backup="$BESZEL_DIR/beszel_data.bak-$(date +%Y%m%d-%H%M%S)"
	cp -Rp "$BESZEL_DIR/beszel_data" "$backup"
	echo "Backed up data to $backup"
fi

if [ -f "$BESZEL_DIR/beszel" ] && ! cmp -s "$SRC" "$BESZEL_DIR/beszel"; then
	mv "$BESZEL_DIR/beszel" "$BESZEL_DIR/beszel.prev"
fi
if ! cmp -s "$SRC" "$BESZEL_DIR/beszel" 2>/dev/null; then
	cp "$SRC" "$BESZEL_DIR/beszel"
fi
chmod +x "$BESZEL_DIR/beszel"
xattr -d com.apple.quarantine "$BESZEL_DIR/beszel" 2>/dev/null || true

cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>$LABEL</string>
	<key>WorkingDirectory</key><string>$BESZEL_DIR</string>
	<key>ProgramArguments</key>
	<array>
		<string>$BESZEL_DIR/beszel</string>
		<string>serve</string>
		<string>--dir</string><string>$BESZEL_DIR/beszel_data</string>
		<string>--http</string><string>$HUB_LISTEN</string>
	</array>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
	<key>StandardOutPath</key><string>$LOG</string>
	<key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF

launchctl bootstrap "$DOMAIN" "$PLIST"
port="${HUB_LISTEN##*:}"
for _ in $(seq 1 15); do
	curl -fsS "http://127.0.0.1:$port/api/health" >/dev/null 2>&1 && break
	sleep 1
done

if curl -fsS "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; then
	echo "Hub running: http://127.0.0.1:$port   ($("$BESZEL_DIR/beszel" --version))"
else
	echo "Hub did not answer on port $port; check $LOG" >&2
	tail -20 "$LOG" >&2 || true
	exit 1
fi
echo "Logs:    tail -f \"$LOG\""
echo "Restart: launchctl kickstart -k $DOMAIN/$LABEL"
echo "Stop:    launchctl bootout $DOMAIN/$LABEL"
