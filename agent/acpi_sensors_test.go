//go:build testing && linux

package agent

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/henrygd/beszel/internal/entities/system"
	"github.com/shirou/gopsutil/v4/common"
	"github.com/shirou/gopsutil/v4/sensors"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// dgxSparkZones is the ACPI thermal-zone layout observed on a DGX Spark (GB10)
// running EC firmware 0x03000d07, in thermal_zoneN order.
var dgxSparkZones = []struct {
	acpiPath string
	milliC   string
}{
	{`\_TZ_.TSOC`, "38800"},
	{`\_TZ_.TS0E`, "36900"},
	{`\_TZ_.TS0P`, "36900"},
	{`\_TZ_.TS1E`, "36900"},
	{`\_TZ_.TS1P`, "36500"},
	{`\_TZ_.TGPU`, "38800"},
	{`\_TZ_.TUNC`, "37700"},
}

func symlink(t *testing.T, target, link string) {
	t.Helper()
	require.NoError(t, os.MkdirAll(filepath.Dir(link), 0o755))
	require.NoError(t, os.Symlink(target, link))
}

// buildDGXSparkSysfs writes a fake /sys tree matching a DGX Spark:
//   - two PNP0C0B ACPI fans, each its own unlabeled "acpi_fan" hwmon chip
//   - seven acpitz thermal zones with distinct ACPI paths, each registering a
//     hwmon chip named hwmonName(i) ("acpitz" on older kernels, "acpitz_N" on
//     newer ones)
//   - an NVMe drive with labeled sensors (must keep upstream names)
//
// Returns the sysfs root.
func buildDGXSparkSysfs(t *testing.T, hwmonName func(zone int) string) string {
	t.Helper()
	root := t.TempDir()
	hwmon := filepath.Join(root, "class", "hwmon")

	writeFile(t, filepath.Join(root, "class", "dmi", "id", "sys_vendor"), "NVIDIA\n")
	writeFile(t, filepath.Join(root, "class", "dmi", "id", "product_name"), "NVIDIA_DGX_Spark\n")
	writeFile(t, filepath.Join(root, "class", "dmi", "id", "product_family"), "DGX Spark\n")

	for i, rpm := range []string{"2035", "2090"} {
		uid := []string{"0", "1"}[i]
		platDev := filepath.Join(root, "devices", "platform", "PNP0C0B:0"+uid)
		acpiNode := filepath.Join(root, "devices", "LNXSYSTM:00", "PNP0C0B:0"+uid)
		writeFile(t, filepath.Join(acpiNode, "path"), `\_SB_.FAN`+uid+"\n")
		symlink(t, acpiNode, filepath.Join(platDev, "firmware_node"))
		chip := filepath.Join(hwmon, "hwmon"+uid)
		writeFile(t, filepath.Join(chip, "name"), "acpi_fan\n")
		writeFile(t, filepath.Join(chip, "fan1_input"), rpm+"\n")
		symlink(t, platDev, filepath.Join(chip, "device"))
	}

	for i, z := range dgxSparkZones {
		n := string(rune('0' + i))
		acpiNode := filepath.Join(root, "devices", "LNXSYBUS:01", "LNXTHERM:0"+n)
		writeFile(t, filepath.Join(acpiNode, "path"), z.acpiPath+"\n")
		zone := filepath.Join(root, "devices", "virtual", "thermal", "thermal_zone"+n)
		writeFile(t, filepath.Join(zone, "type"), "acpitz\n")
		writeFile(t, filepath.Join(zone, "temp"), z.milliC+"\n")
		symlink(t, acpiNode, filepath.Join(zone, "device"))
		symlink(t, zone, filepath.Join(root, "class", "thermal", "thermal_zone"+n))

		// fan hwmon chips are hwmon0/1; zones start at hwmon2
		chip := filepath.Join(hwmon, "hwmon"+string(rune('2'+i)))
		writeFile(t, filepath.Join(chip, "name"), hwmonName(i)+"\n")
		writeFile(t, filepath.Join(chip, "temp1_input"), z.milliC+"\n")
		symlink(t, zone, filepath.Join(chip, "device"))
	}

	nvme := filepath.Join(hwmon, "hwmon9")
	writeFile(t, filepath.Join(nvme, "name"), "nvme\n")
	writeFile(t, filepath.Join(nvme, "temp1_input"), "35850\n")
	writeFile(t, filepath.Join(nvme, "temp1_label"), "Composite\n")
	writeFile(t, filepath.Join(nvme, "temp2_input"), "36850\n")
	writeFile(t, filepath.Join(nvme, "temp2_label"), "Sensor 1\n")
	return root
}

var dgxSparkExpectedTemps = map[string]float64{
	"acpitz_TSOC":    38.8,
	"acpitz_TS0E":    36.9,
	"acpitz_TS0P":    36.9,
	"acpitz_TS1E":    36.9,
	"acpitz_TS1P":    36.5,
	"acpitz_TGPU":    38.8,
	"acpitz_TUNC":    37.7,
	"nvme_composite": 35.85,
	"nvme_sensor_1":  36.85,
}

func tempsByKey(t *testing.T, temps []sensors.TemperatureStat) map[string]float64 {
	t.Helper()
	out := make(map[string]float64, len(temps))
	for _, s := range temps {
		_, dup := out[s.SensorKey]
		require.False(t, dup, "duplicate sensor key %q", s.SensorKey)
		out[s.SensorKey] = s.Temperature
	}
	return out
}

func TestACPIPathSuffix(t *testing.T) {
	for in, want := range map[string]string{
		`\_TZ_.TSOC`:             "TSOC",
		`\_SB_.FAN0`:             "FAN0",
		`\_SB_.PCI0.FAN_` + "\n": "FAN",
		`\_TZ_`:                  "_TZ",
		`TZ01`:                   "TZ01",
		"":                       "",
		`\___.____`:              "",
	} {
		assert.Equal(t, want, acpiPathSuffix(in), in)
	}
}

// TestDGXSparkFans verifies both DGX Spark fans survive as separate series
// named after their ACPI objects instead of collapsing into "acpi_fan_fan1".
func TestDGXSparkFans(t *testing.T) {
	root := buildDGXSparkSysfs(t, func(int) string { return "acpitz" })

	fans, err := readHwmonFans(filepath.Join(root, "class", "hwmon"))
	require.NoError(t, err)
	assert.Equal(t, map[string]uint16{"acpi_fan_FAN0": 2035, "acpi_fan_FAN1": 2090}, fans)

	// A transient 0 RPM sample is telemetry, not something to drop.
	writeFile(t, filepath.Join(root, "class", "hwmon", "hwmon1", "fan1_input"), "0\n")
	fans, err = readHwmonFans(filepath.Join(root, "class", "hwmon"))
	require.NoError(t, err)
	assert.Equal(t, map[string]uint16{"acpi_fan_FAN0": 2035, "acpi_fan_FAN1": 0}, fans)

	// One fan path disappearing must not take down the other.
	sensorsList, err := discoverHwmonFans(filepath.Join(root, "class", "hwmon"))
	require.NoError(t, err)
	require.NoError(t, os.Remove(filepath.Join(root, "class", "hwmon", "hwmon0", "fan1_input")))
	assert.Equal(t, map[string]uint16{"acpi_fan_FAN1": 0}, readFanSensors(sensorsList))
}

// TestFanKeyDisambiguationFallbacks covers colliding fans without ACPI
// companions: the device node name is used, then the hwmon dir as last resort.
func TestFanKeyDisambiguationFallbacks(t *testing.T) {
	root := t.TempDir()
	hwmon := filepath.Join(root, "hwmon")
	for i, dev := range []string{"fan-a", "fan-b"} {
		chip := filepath.Join(hwmon, "hwmon"+string(rune('0'+i)))
		writeFile(t, filepath.Join(chip, "name"), "gpio_fan\n")
		writeFile(t, filepath.Join(chip, "fan1_input"), "1000\n")
		require.NoError(t, os.MkdirAll(filepath.Join(root, "devices", dev), 0o755))
		symlink(t, filepath.Join(root, "devices", dev), filepath.Join(chip, "device"))
	}
	for i := range 2 {
		chip := filepath.Join(hwmon, "hwmon"+string(rune('2'+i)))
		writeFile(t, filepath.Join(chip, "name"), "pwmfan\n")
		writeFile(t, filepath.Join(chip, "fan1_input"), "500\n")
	}
	// unique keys are untouched
	writeFile(t, filepath.Join(hwmon, "hwmon4", "name"), "nct6798\n")
	writeFile(t, filepath.Join(hwmon, "hwmon4", "fan1_input"), "800\n")

	fans, err := readHwmonFans(hwmon)
	require.NoError(t, err)
	assert.Equal(t, map[string]uint16{
		"gpio_fan_fan-a": 1000,
		"gpio_fan_fan-b": 1000,
		"pwmfan_hwmon2":  500,
		"pwmfan_hwmon3":  500,
		"nct6798_fan1":   800,
	}, fans)
}

// TestDGXSparkTemps covers both kernel naming schemes for the thermal-zone
// hwmon chips: all identical "acpitz", and indexed "acpitz_N".
func TestDGXSparkTemps(t *testing.T) {
	for name, hwmonName := range map[string]func(int) string{
		"collapsed": func(int) string { return "acpitz" },
		"indexed":   func(i int) string { return "acpitz_" + string(rune('0'+i)) },
	} {
		t.Run(name, func(t *testing.T) {
			root := buildDGXSparkSysfs(t, hwmonName)
			var r acpiTempReader
			temps, err := r.read(root)
			require.NoError(t, err)
			got := tempsByKey(t, temps)
			require.Len(t, got, len(dgxSparkExpectedTemps))
			for k, want := range dgxSparkExpectedTemps {
				assert.InDelta(t, want, got[k], 0.001, k)
			}
		})
	}
}

// TestDGXSparkTempsZoneFallback covers hosts with no hwmon temperature
// inputs, where zones are read from /sys/class/thermal directly.
func TestDGXSparkTempsZoneFallback(t *testing.T) {
	root := buildDGXSparkSysfs(t, func(int) string { return "acpitz" })
	require.NoError(t, os.RemoveAll(filepath.Join(root, "class", "hwmon")))

	got := tempsByKey(t, mustRead(t, root))
	assert.Len(t, got, len(dgxSparkZones))
	assert.InDelta(t, 38.8, got["acpitz_TSOC"], 0.001)
	assert.InDelta(t, 37.7, got["acpitz_TUNC"], 0.001)
}

func mustRead(t *testing.T, root string) []sensors.TemperatureStat {
	t.Helper()
	var r acpiTempReader
	temps, err := r.read(root)
	require.NoError(t, err)
	return temps
}

// TestACPITempReaderMissingZone verifies a vanished zone is skipped (others
// still reported), triggers a rescan, and is picked up again when it returns.
func TestACPITempReaderMissingZone(t *testing.T) {
	root := buildDGXSparkSysfs(t, func(i int) string { return "acpitz_" + string(rune('0'+i)) })
	var r acpiTempReader
	_, err := r.read(root)
	require.NoError(t, err)

	tgpu := filepath.Join(root, "class", "hwmon", "hwmon7", "temp1_input")
	require.NoError(t, os.Remove(tgpu))
	temps, err := r.read(root)
	require.NoError(t, err)
	got := tempsByKey(t, temps)
	assert.NotContains(t, got, "acpitz_TGPU")
	assert.Len(t, got, len(dgxSparkExpectedTemps)-1)
	assert.True(t, r.rescan)

	writeFile(t, tgpu, "81000\n")
	temps, err = r.read(root)
	require.NoError(t, err)
	assert.InDelta(t, 81.0, tempsByKey(t, temps)["acpitz_TGPU"], 0.001)
	assert.False(t, r.rescan)
}

// TestDiscoverTempSensorsMatchesGopsutil ensures that on a host without ACPI
// thermal zones the reader produces exactly gopsutil's keys, values and order,
// so enabling ACPI_SENSOR_NAMES never renames unrelated sensors.
func TestDiscoverTempSensorsMatchesGopsutil(t *testing.T) {
	root := t.TempDir()
	hwmon := filepath.Join(root, "class", "hwmon")
	writeFile(t, filepath.Join(hwmon, "hwmon0", "name"), "coretemp\n")
	writeFile(t, filepath.Join(hwmon, "hwmon0", "temp1_input"), "45000\n")
	writeFile(t, filepath.Join(hwmon, "hwmon0", "temp1_label"), "Package id 0\n")
	writeFile(t, filepath.Join(hwmon, "hwmon0", "temp2_input"), "44000\n")
	writeFile(t, filepath.Join(hwmon, "hwmon0", "temp2_label"), "Core 0\n")
	writeFile(t, filepath.Join(hwmon, "hwmon1", "name"), "acpitz\n")
	writeFile(t, filepath.Join(hwmon, "hwmon1", "temp1_input"), "27800\n")
	writeFile(t, filepath.Join(hwmon, "hwmon10", "name"), "acpitz\n")
	writeFile(t, filepath.Join(hwmon, "hwmon10", "temp1_input"), "29800\n")
	writeFile(t, filepath.Join(hwmon, "hwmon2", "name"), "nvme\n")
	writeFile(t, filepath.Join(hwmon, "hwmon2", "temp1_input"), "35850\n")
	writeFile(t, filepath.Join(hwmon, "hwmon2", "temp1_label"), "Composite\n")

	ctx := context.WithValue(context.Background(), common.EnvKey, common.EnvMap{common.HostSysEnvKey: root})
	want, _ := sensors.TemperaturesWithContext(ctx)
	require.Len(t, want, 5)

	got := mustRead(t, root)
	require.Len(t, got, len(want))
	for i := range want {
		assert.Equal(t, want[i].SensorKey, got[i].SensorKey)
		assert.InDelta(t, want[i].Temperature, got[i].Temperature, 1e-9)
	}
}

func TestACPISensorNamesEnabled(t *testing.T) {
	dgx := buildDGXSparkSysfs(t, func(int) string { return "acpitz" })
	other := t.TempDir()
	writeFile(t, filepath.Join(other, "class", "dmi", "id", "sys_vendor"), "LENOVO\n")
	writeFile(t, filepath.Join(other, "class", "dmi", "id", "product_name"), "ThinkPad\n")

	assert.True(t, acpiSensorNamesEnabled("", dgx), "auto on DGX Spark")
	assert.False(t, acpiSensorNamesEnabled("", other), "auto elsewhere")
	assert.False(t, acpiSensorNamesEnabled("", t.TempDir()), "no DMI")
	assert.True(t, acpiSensorNamesEnabled("true", other))
	assert.False(t, acpiSensorNamesEnabled("false", dgx))
}

// TestUpdateTemperaturesDGXSpark runs the fixture through the agent's normal
// temperature pipeline (validation, filtering, dashboard max).
func TestUpdateTemperaturesDGXSpark(t *testing.T) {
	root := buildDGXSparkSysfs(t, func(i int) string { return "acpitz_" + string(rune('0'+i)) })
	var r acpiTempReader
	original := getSensorTemps
	t.Cleanup(func() { getSensorTemps = original })
	getSensorTemps = func(context.Context) ([]sensors.TemperatureStat, error) { return r.read(root) }

	agent := &Agent{sensorConfig: (&Agent{}).newSensorConfigWithEnv("", "", "", "", false, false)}
	stats := &system.Stats{}
	agent.updateTemperatures(stats)

	assert.Equal(t, dgxSparkExpectedTemps, stats.Temperatures)
	assert.Equal(t, 38.8, agent.systemInfo.DashboardTemp)
}
