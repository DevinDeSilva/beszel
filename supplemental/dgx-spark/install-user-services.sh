#!/usr/bin/env bash
# Install the Beszel hub + binary agent on a DGX Spark as systemd *user*
# services (no root needed). Requires lingering for the user so the services
# run without a login session:  sudo loginctl enable-linger "$USER"
#
# Usage: supplemental/dgx-spark/install-user-services.sh [build_dir]
#
# Env overrides:
#   AGENT_ONLY=1 install only the agent, for a hub running elsewhere (e.g. a
#                Mac). Add that hub's public key with HUB_KEY or by editing
#                ~/.config/beszel/authorized_keys.
#   HUB_KEY      public key ("ssh-ed25519 AAAA...") of a remote hub to allow
#   HUB_LISTEN   address:port for the hub web UI   (default 0.0.0.0:8090)
#   AGENT_LISTEN address:port for the agent        (default 127.0.0.1:45876,
#                45876 = all interfaces when AGENT_ONLY=1)
#   HUB_EMAIL    login for the initial admin user  (default admin@beszel.local)
#
# The agent accepts every key in ~/.config/beszel/authorized_keys, so local and
# remote hubs can read it at the same time.
#
# Re-running upgrades the binaries and restarts the services; existing hub
# data, keys and credentials are kept.
set -euo pipefail

BUILD_DIR="${1:-$(cd "$(dirname "$0")/../.." && pwd)/build}"
AGENT_ONLY="${AGENT_ONLY:-0}"
HUB_LISTEN="${HUB_LISTEN:-0.0.0.0:8090}"
if [ "$AGENT_ONLY" = 1 ]; then
	AGENT_LISTEN="${AGENT_LISTEN:-45876}"
else
	AGENT_LISTEN="${AGENT_LISTEN:-127.0.0.1:45876}"
fi
HUB_EMAIL="${HUB_EMAIL:-admin@beszel.local}"

BIN_DIR="$HOME/.local/opt/beszel"
CONF_DIR="$HOME/.config/beszel"
HUB_DATA="$HOME/.local/share/beszel/hub"
AGENT_DATA="$HOME/.local/share/beszel/agent"
UNIT_DIR="$HOME/.config/systemd/user"

bins="beszel-agent"
[ "$AGENT_ONLY" = 1 ] || bins="beszel beszel-agent"
for b in $bins; do
	[ -x "$BUILD_DIR/$b" ] || { echo "missing $BUILD_DIR/$b (build first)" >&2; exit 1; }
done
KEYS_FILE="$CONF_DIR/authorized_keys"

mkdir -p "$BIN_DIR" "$CONF_DIR" "$HUB_DATA" "$AGENT_DATA" "$UNIT_DIR"
chmod 700 "$CONF_DIR"

# add_key appends a public key to the agent's allow list if it isn't there yet
add_key() {
	touch "$KEYS_FILE" && chmod 600 "$KEYS_FILE"
	grep -qxF "$1" "$KEYS_FILE" || printf '%s\n' "$1" >>"$KEYS_FILE"
}

# stop before replacing binaries (ignore if not installed yet)
systemctl --user stop beszel-agent.service 2>/dev/null || true
for b in $bins; do
	install -m 755 "$BUILD_DIR/$b" "$BIN_DIR/$b"
done

if [ "$AGENT_ONLY" != 1 ]; then
systemctl --user stop beszel-hub.service 2>/dev/null || true

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
add_key "$pubkey"
fi # AGENT_ONLY

[ -n "${HUB_KEY:-}" ] && add_key "$HUB_KEY"
if ! grep -q '^ssh-' "$KEYS_FILE" 2>/dev/null; then
	echo "no hub keys in $KEYS_FILE: pass HUB_KEY='ssh-ed25519 ...' (copy it from the hub's Add System dialog)" >&2
	exit 1
fi

cat >"$CONF_DIR/agent.env" <<EOF
KEY_FILE=$KEYS_FILE
LISTEN=$AGENT_LISTEN
DATA_DIR=$AGENT_DATA
# auto-enabled on DGX Spark; set false to keep upstream acpitz_N names
#ACPI_SENSOR_NAMES=true
EOF
chmod 600 "$CONF_DIR/agent.env"

cat >"$UNIT_DIR/beszel-agent.service" <<EOF
[Unit]
Description=Beszel agent (DGX Spark thermal fork, read-only sensors)
After=network-online.target

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

[ "$AGENT_ONLY" = 1 ] || echo "Hub:    http://$HUB_LISTEN   (credentials in $CONF_DIR/hub.env)"
echo "Agent:  $AGENT_LISTEN   (allowed hub keys: $KEYS_FILE)"
echo "Logs:   journalctl --user -u beszel-agent -f"
