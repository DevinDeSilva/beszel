#!/usr/bin/env bash
# Install the Beszel hub + binary agent on a DGX Spark as systemd *user*
# services (no root needed). Requires lingering for the user so the services
# run without a login session:  sudo loginctl enable-linger "$USER"
#
# Usage: supplemental/dgx-spark/install-user-services.sh [build_dir]
#
# Env overrides:
#   HUB_LISTEN   address:port for the hub web UI   (default 0.0.0.0:8090)
#   AGENT_LISTEN address:port for the agent        (default 127.0.0.1:45876)
#   HUB_EMAIL    login for the initial admin user  (default admin@beszel.local)
#
# Re-running upgrades the binaries and restarts the services; existing hub
# data, keys and credentials are kept.
set -euo pipefail

BUILD_DIR="${1:-$(cd "$(dirname "$0")/../.." && pwd)/build}"
HUB_LISTEN="${HUB_LISTEN:-0.0.0.0:8090}"
AGENT_LISTEN="${AGENT_LISTEN:-127.0.0.1:45876}"
HUB_EMAIL="${HUB_EMAIL:-admin@beszel.local}"

BIN_DIR="$HOME/.local/opt/beszel"
CONF_DIR="$HOME/.config/beszel"
HUB_DATA="$HOME/.local/share/beszel/hub"
AGENT_DATA="$HOME/.local/share/beszel/agent"
UNIT_DIR="$HOME/.config/systemd/user"

for b in beszel beszel-agent; do
	[ -x "$BUILD_DIR/$b" ] || { echo "missing $BUILD_DIR/$b (build first)" >&2; exit 1; }
done

mkdir -p "$BIN_DIR" "$CONF_DIR" "$HUB_DATA" "$AGENT_DATA" "$UNIT_DIR"
chmod 700 "$CONF_DIR"

# stop before replacing binaries (ignore if not installed yet)
systemctl --user stop beszel-agent.service beszel-hub.service 2>/dev/null || true
install -m 755 "$BUILD_DIR/beszel" "$BIN_DIR/beszel"
install -m 755 "$BUILD_DIR/beszel-agent" "$BIN_DIR/beszel-agent"

# Initial admin credentials (only consumed by the hub's first-run migration).
if [ ! -f "$CONF_DIR/hub.env" ]; then
	pass="$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20)"
	umask 077
	printf 'USER_EMAIL=%s\nUSER_PASSWORD=%s\n' "$HUB_EMAIL" "$pass" >"$CONF_DIR/hub.env"
	umask 022
fi

cat >"$UNIT_DIR/beszel-hub.service" <<EOF
[Unit]
Description=Beszel hub (DGX Spark thermal fork)
After=network-online.target

[Service]
WorkingDirectory=$HUB_DATA
EnvironmentFile=$CONF_DIR/hub.env
ExecStart=$BIN_DIR/beszel serve --http $HUB_LISTEN --dir $HUB_DATA/beszel_data
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now beszel-hub.service

# Wait for the hub to generate its SSH key pair.
for _ in $(seq 1 30); do
	[ -f "$HUB_DATA/beszel_data/id_ed25519.pub" ] && break
	sleep 1
done
pubkey="$(cat "$HUB_DATA/beszel_data/id_ed25519.pub" 2>/dev/null || true)"
if [ -z "$pubkey" ]; then
	# older layouts derive the public key from the private key
	pubkey="$(ssh-keygen -y -f "$HUB_DATA/beszel_data/id_ed25519")"
fi

cat >"$CONF_DIR/agent.env" <<EOF
KEY=$pubkey
LISTEN=$AGENT_LISTEN
DATA_DIR=$AGENT_DATA
# auto-enabled on DGX Spark; set false to keep upstream acpitz_N names
#ACPI_SENSOR_NAMES=true
EOF
chmod 600 "$CONF_DIR/agent.env"

cat >"$UNIT_DIR/beszel-agent.service" <<EOF
[Unit]
Description=Beszel agent (DGX Spark thermal fork, read-only sensors)
After=network-online.target beszel-hub.service

[Service]
EnvironmentFile=$CONF_DIR/agent.env
ExecStart=$BIN_DIR/beszel-agent
Restart=on-failure
RestartSec=5
# read-only telemetry: no fan/thermal writes are ever made
NoNewPrivileges=true

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now beszel-agent.service

echo "Hub:    http://$HUB_LISTEN   (credentials in $CONF_DIR/hub.env)"
echo "Agent:  $AGENT_LISTEN"
echo "Logs:   journalctl --user -u beszel-hub -u beszel-agent -f"
