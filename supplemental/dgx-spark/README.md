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

## Build, install, validate

```bash
make build-web-ui            # or: npm --prefix internal/site ci && npm --prefix internal/site run build
CGO_ENABLED=0 go build -ldflags "-w -s" -o build/beszel-agent ./internal/cmd/agent
CGO_ENABLED=0 go build -ldflags "-w -s" -o build/beszel ./internal/cmd/hub
supplemental/dgx-spark/install-user-services.sh   # systemd --user hub + agent
```

The install script runs both as user services (lingering must be enabled). The
agent listens on `127.0.0.1:45876` and is authorized only for the local hub's
key. Re-run the script to upgrade.

Tests:

```bash
go test -tags testing ./agent/ ./internal/records/
cd internal/site && bun test src/lib/thermal.test.ts
```

Ground truth (read-only):

```bash
for h in /sys/class/hwmon/hwmon*; do [ "$(cat $h/name)" = acpi_fan ] && echo "$(cat $h/device/firmware_node/path): $(cat $h/fan1_input) RPM"; done
for z in /sys/class/thermal/thermal_zone*; do echo "$(cat $z/device/path 2>/dev/null) $(awk '{printf "%.1f", $1/1000}' $z/temp)"; done
nvidia-smi --query-gpu=temperature.gpu,power.draw,utilization.gpu,clocks.sm --format=csv,noheader,nounits
```

## Not done yet / follow-ups

* **Hub-side alerts (phase 5).** The existing *Temperature* alert already works
  on the hottest sensor (the agent's dashboard temp is the max of all sensors),
  with a sustained duration. Dedicated high-temp/low-fan, fan-telemetry-loss
  and rapid-heating alerts are only UI badges so far.
* Load validation: the small and medium GPU workload acceptance runs still
  need to be recorded with this build.
* Optional NVML on arm64, GPU SM clock, and an opt-in burst sampling mode.
