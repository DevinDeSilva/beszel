# DGX Spark thermal monitoring (fork notes)

Branch `feature/dgx-spark-thermal`, based on upstream commit
`82a8fe6013eb7091d383b4eb5a565fc87d94a050` (Beszel 0.21.2).

The goal is continuous, low-overhead monitoring of a DGX Spark (GB10) that
keeps the ACPI thermal-zone, fan RPM and NVIDIA GPU telemetry accurate. All
collection is read-only. Nothing writes fan state, trip points or firmware.

## Phase 0: what unmodified Beszel reported on this host

Kernel 7.0.0-1025-nvidia, EC firmware 0x03000d07:

| Series | Unmodified agent | Ground truth (sysfs) |
|---|---|---|
| Fans | `acpi_fan_fan1: 2078` (**one fan**) | hwmon0 2027 RPM, hwmon1 2084 RPM |
| Thermal zones | `acpitz_0` … `acpitz_6` | `\_TZ_.TSOC, TS0E, TS0P, TS1E, TS1P, TGPU, TUNC` |
| GPU | `GB10` temp in `t`, usage, power via `nvidia-smi -l` | `nvidia-smi` matches |

* Both fans are unlabeled `acpi_fan` hwmon chips, so both produced the key
  `acpi_fan_fan1` and one silently overwrote the other.
* This kernel names the zone hwmon chips `acpitz_N`. That keeps them distinct,
  but N is a registration index with no meaning. Older kernels name every chip
  `acpitz`, which gopsutil collapses into `acpitz`, `acpitz_3`, ….
* NVML is only built for amd64. On arm64 the GPU collector is a single
  long-running `nvidia-smi -l <interval>` process, not one process per sample,
  so it is kept unchanged. GPU clock is not collected and was not added.

## Changes

### Agent (`agent/acpi_sensors.go`, `agent/sensors_linux.go`, `agent/fans.go`)

* **Fan key disambiguation (generic).** When fan keys collide, each colliding
  fan is renamed after its backing device's ACPI object (`firmware_node/path`),
  for example `acpi_fan_FAN0` and `acpi_fan_FAN1`. If there is no ACPI object
  it falls back to the device node name, and only then to the hwmon dir. Fans
  whose keys are already unique keep their names, so other hosts are unaffected.
* **ACPI thermal-zone names (`ACPI_SENSOR_NAMES`).** Each hwmon chip backed by a
  thermal zone is named `<zone type>_<ACPI id>`: `acpitz_TSOC`, `acpitz_TGPU`,
  etc. It reads the same `temp*_input` files gopsutil does, in the same order
  and with the same key format, from a path list cached at discovery. A
  vanished path triggers a rescan on the next sample. Sensors that are not
  ACPI-backed (nvme, wifi, coretemp, …) keep exactly gopsutil's names (there is
  a test for this).
  * unset/`auto`: enabled only when DMI says `NVIDIA` + `DGX Spark`
  * `true`: force on (other ACPI hosts); `false`: upstream gopsutil behavior
* A sensor read failure is logged once when it starts and once when it
  recovers. A transient 0 RPM reading is kept as data.

### Hub (`internal/records/records.go`)

Longer records (10m/20m/120m/480m) now also store `tm` (max °C per sensor)
and `fmn` (min RPM per fan) next to the averaged `t`/`f`. A 96.8 °C spike or
a 0 RPM dip therefore stays visible on 12h/24h/1w ranges. These fields are
JSON-only (agents never send them). No new tables or database were added.

### UI (`internal/site/src/lib/thermal.ts`, `.../charts/thermal-charts.tsx`)

A **Platform thermal diagnostics** section (and a *Thermal* tab in tabbed
layout). It appears for systems that report `acpitz*` temperatures and fans:

* Summary: current and peak hottest zone with the sensor that produced it;
  rise rate (°C/min, least squares over a configurable window); each fan and
  the minimum; GPU temp/util/power and peak power; time above warn/crit.
  Badges: high/critical temperature, high temp + low fan, rapid heating under
  GPU load, missing fan telemetry, transient 0 RPM samples.
* Thermal timeline: hottest platform zone vs GPU temperature.
* Fan response: each fan's RPM (left axis) vs hottest temperature (right).
* GPU workload: power (W) and utilization (%).
* **Fan curve scatter:** hottest temperature on X, RPM on Y, one series per
  fan, one point per record. Longer ranges use per-window peaks.

Thresholds are browser-side and editable. Defaults: warn 85 °C, critical
90 °C, low-fan check above 80 °C with every fan below 2500 RPM, rapid heating
above 3 °C/min. They are monitoring heuristics, not NVIDIA limits. The EC owns
fan control, and current firmware ignores `cur_state` writes.

## Serialized name changes (historical continuity)

On DGX Spark the following series are renamed compared with upstream:

| Upstream | This fork |
|---|---|
| `acpi_fan_fan1` (one fan only) | `acpi_fan_FAN0`, `acpi_fan_FAN1` |
| `acpitz_0` … `acpitz_6` | `acpitz_TSOC`, `acpitz_TS0E`, `acpitz_TS0P`, `acpitz_TS1E`, `acpitz_TS1P`, `acpitz_TGPU`, `acpitz_TUNC` |

History recorded under the old names stays in the database under those names.
To keep the upstream thermal names, set `ACPI_SENSOR_NAMES=false`.

## Status and compatibility

This is a **preview** maintained outside the Beszel project.

* Verified on one DGX Spark: DGX OS, kernel 7.0.0-1025-nvidia, EC firmware
  0x03000d07. The older-kernel `acpitz` naming path is covered by fixture
  tests only. Reports from other units, kernels and firmware are welcome.
* The agent is a drop-in replacement for upstream's and speaks the same
  protocol. Upstream hubs can read it. The diagnostics section and peak-keeping
  long ranges need this fork's hub.
* The fork's hub works with upstream agents on other machines.

## Install

Prebuilt binaries are on the
[Releases](https://github.com/DevinDeSilva/beszel/releases) page. Every archive
contains a single binary. Pick one of the layouts below.

### A. Hub and agent both on the Spark

```bash
mkdir -p ~/beszel-dl && cd ~/beszel-dl
base=https://github.com/DevinDeSilva/beszel/releases/latest/download
curl -fsSL --remote-name-all $base/beszel-agent_linux_arm64.tar.gz $base/beszel_linux_arm64.tar.gz $base/install-user-services.sh $base/SHA256SUMS
sha256sum --ignore-missing -c SHA256SUMS
tar xzf beszel-agent_linux_arm64.tar.gz && tar xzf beszel_linux_arm64.tar.gz
sudo loginctl enable-linger "$USER"          # once: run user services without a login
bash install-user-services.sh "$PWD"
```

The script installs both as systemd user services (no root). The hub listens on
`0.0.0.0:8090`; the first admin login is in `~/.config/beszel/hub.env`. The
agent listens on `127.0.0.1:45876` and already trusts the local hub's key. In
the hub, click *Add System* and use host `127.0.0.1`, port `45876`.

### B. Agent on the Spark, hub on another machine

1. Start the hub (section C for a Mac, or A on another Linux box).
2. In the hub, click *Add System* and copy the **public key**.
3. On the Spark:

   ```bash
   mkdir -p ~/beszel-dl && cd ~/beszel-dl
   base=https://github.com/DevinDeSilva/beszel/releases/latest/download
   curl -fsSL --remote-name-all $base/beszel-agent_linux_arm64.tar.gz $base/install-user-services.sh $base/SHA256SUMS
   sha256sum --ignore-missing -c SHA256SUMS && tar xzf beszel-agent_linux_arm64.tar.gz
   sudo loginctl enable-linger "$USER"
   AGENT_ONLY=1 HUB_KEY='ssh-ed25519 AAAA...' bash install-user-services.sh "$PWD"
   ```

4. Allow the hub to reach port 45876 on the Spark (see *Firewall* below).
5. Finish *Add System* in the hub with the Spark's address (LAN or Tailscale
   IP) and port `45876`.

Allowed hub keys live in `~/.config/beszel/authorized_keys`, one per line. Add
a line to let another hub read the same agent. The agent stays in SSH mode
(the hub connects to it). Don't switch it to WebSocket mode if more than one
hub needs it.

### C. Hub on a Mac (launchd)

```bash
arch=$(uname -m); [ "$arch" = x86_64 ] && arch=amd64
mkdir -p ~/beszel-dl && cd ~/beszel-dl
base=https://github.com/DevinDeSilva/beszel/releases/latest/download
curl -fsSL --remote-name-all $base/beszel_darwin_$arch.tar.gz $base/install-macos-hub.sh
tar xzf beszel_darwin_$arch.tar.gz
bash install-macos-hub.sh ./beszel
```

The script installs into `~/Library/Application Support/Beszel` and runs the
hub as a launchd agent that starts at login and restarts if it stops. If an
upstream hub already lives there, its data is used as is (backed up first) and
the old binary is kept as `beszel.prev`. Logs are in
`~/Library/Logs/beszel-hub.log`.

* Restart: `launchctl kickstart -k gui/$(id -u)/com.beszel.hub`
* Stop: `launchctl bootout gui/$(id -u)/com.beszel.hub`
* Roll back: `mv beszel.prev beszel` in that folder, then restart.

Don't keep the hub's data folder in a synced folder (iCloud Drive, Google
Drive, Dropbox). Syncing a live SQLite database can corrupt it.

### Firewall

The hub connects **to** the agent on TCP 45876. Allow only the hub's address.

firewalld (DGX OS default). Interfaces such as `tailscale0` that aren't
assigned to a zone fall into `public`:

```bash
sudo firewall-cmd --permanent --zone=public --add-rich-rule='rule family="ipv4" source address="HUB_IP/32" port port="45876" protocol="tcp" accept'
sudo firewall-cmd --reload
```

ufw:

```bash
sudo ufw allow from HUB_IP to any port 45876 proto tcp
```

### Upgrading

Download the new release and re-run the same installer. Keys, settings and
history are kept. **Don't run `beszel update` or `beszel-agent update`:** fork
builds refuse, and an upstream binary would replace the fork.

### Coming from an upstream install

* Fans and thermal zones are recorded under new names (see the table above).
  Older history stays under the old names.
* Hub data is compatible: point the fork's hub at the existing `beszel_data`
  folder (the Mac installer does this).
* An upstream agent on the Spark (Docker or binary) must be stopped first, or
  it will hold port 45876.

### Uninstall

```bash
# Spark
systemctl --user disable --now beszel-agent beszel-hub 2>/dev/null
rm -f ~/.config/systemd/user/beszel-{agent,hub}.service && systemctl --user daemon-reload
rm -rf ~/.local/opt/beszel          # data: ~/.local/share/beszel, config: ~/.config/beszel
# Mac
launchctl bootout gui/$(id -u)/com.beszel.hub; rm ~/Library/LaunchAgents/com.beszel.hub.plist
```

## Build from source

```bash
make build-web-ui            # or: npm --prefix internal/site ci && npm --prefix internal/site run build
CGO_ENABLED=0 go build -tags no_self_update -ldflags "-w -s" -o build/beszel-agent ./internal/cmd/agent
CGO_ENABLED=0 go build -tags no_self_update -ldflags "-w -s" -o build/beszel ./internal/cmd/hub
CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -tags no_self_update -ldflags "-w -s" -o build/beszel_darwin_arm64 ./internal/cmd/hub
supplemental/dgx-spark/install-user-services.sh build   # layout A; or AGENT_ONLY=1 HUB_KEY=... for B
```

Tests:

```bash
go test -tags testing ./agent/ ./internal/records/
cd internal/site && bun test src/lib/thermal.test.ts
```

Releases: push a tag like `dgx-v0.21.2-1`. The workflow
`.github/workflows/dgx-spark-release.yml` runs the tests, builds the agent
(Linux arm64/amd64) and the hub (Linux and macOS, arm64/amd64), and attaches
them with the install scripts and `SHA256SUMS`. Upstream's release, Docker,
Helm and issue-bot workflows are skipped outside `henrygd/beszel`.

## Validate (read-only)

Compare the dashboard with sysfs and `nvidia-smi`:

```bash
for h in /sys/class/hwmon/hwmon*; do [ "$(cat $h/name)" = acpi_fan ] && echo "$(cat $h/device/firmware_node/path): $(cat $h/fan1_input) RPM"; done
for z in /sys/class/thermal/thermal_zone*; do echo "$(cat $z/device/path 2>/dev/null) $(awk '{printf "%.1f", $1/1000}' $z/temp)"; done
nvidia-smi --query-gpu=temperature.gpu,power.draw,utilization.gpu,clocks.sm --format=csv,noheader,nounits
```

## Known limitations

* Verified on a single unit (see *Status*). GPU load acceptance runs have not
  been recorded yet.
* Zone names are the raw ACPI ids (`TSOC`, `TS0E`, …). NVIDIA doesn't document
  what each zone measures, so no friendly names are guessed.
* High-temp/low-fan, telemetry loss and rapid heating are UI badges only. The
  standard *Temperature* alert works on the hottest sensor.
* The diagnostics section appears on any system that reports `acpitz*`
  temperatures and fans, not only on a Spark.
* New UI text is English-only.
* No Docker image; binary install only.
* `smartctl failed … no serial number` in the agent log is harmless. Disk
  S.M.A.R.T. needs root, and a user service doesn't have it.
* NVML is not used on arm64 (upstream builds it for amd64 only). GPU data comes
  from one long-running `nvidia-smi` process. GPU clock, unified-memory
  details and an opt-in burst sampling mode are not implemented.
