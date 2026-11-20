package agent

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	"github.com/henrygd/beszel/agent/utils"
	"github.com/shirou/gopsutil/v4/sensors"
)

// ACPI-aware sensor naming.
//
// Some platforms (notably NVIDIA DGX Spark / GB10) expose every platform
// thermal zone through the generic "acpitz" driver and every fan through the
// generic "acpi_fan" driver. The hwmon chip names are then either identical
// ("acpitz", "acpi_fan") or carry only a transient index ("acpitz_0"), so
// series names collide or change meaning across boots and kernel versions.
//
// The firmware already gives each of these devices a stable identity: its
// ACPI namespace path (for example \_TZ_.TSOC or \_SB_.FAN0). The helpers in
// this file derive sensor names from that identity. They only read static
// sysfs metadata, never write anything, and are used lazily: fan naming only
// kicks in when hwmon keys collide, and thermal-zone naming is gated by
// ACPI_SENSOR_NAMES (auto-enabled on DGX Spark).

// acpiPathSuffix returns the final segment of an ACPI namespace path with the
// underscore padding removed: `\_TZ_.TSOC` -> "TSOC", `\_SB_.FAN0` -> "FAN0".
func acpiPathSuffix(acpiPath string) string {
	acpiPath = strings.TrimSpace(acpiPath)
	if i := strings.LastIndexAny(acpiPath, `.\^`); i >= 0 {
		acpiPath = acpiPath[i+1:]
	}
	return strings.TrimRight(acpiPath, "_")
}

// acpiIdentity returns the short ACPI identity ("TSOC", "FAN0") of the device
// at devicePath, or "" if it has no ACPI companion. Thermal zones expose the
// ACPI node directly as device/ (with a path file); platform devices such as
// PNP0C0B fans expose it through firmware_node/.
func acpiIdentity(devicePath string) string {
	for _, p := range [...]string{
		filepath.Join(devicePath, "path"),
		filepath.Join(devicePath, "firmware_node", "path"),
	} {
		if id := acpiPathSuffix(utils.ReadStringFile(p)); id != "" {
			return id
		}
	}
	return ""
}

// hwmonDeviceIdentity returns a stable identity for the device behind a hwmon
// chip directory: its ACPI identity when available, otherwise the name of the
// backing device node (e.g. "PNP0C0B:00"). Returns "" if neither exists.
func hwmonDeviceIdentity(chipDir string) string {
	deviceDir := filepath.Join(chipDir, "device")
	if id := acpiIdentity(deviceDir); id != "" {
		return id
	}
	if target, err := filepath.EvalSymlinks(deviceDir); err == nil {
		return filepath.Base(target)
	}
	return ""
}

// acpiThermalZoneName returns "<zone type>_<ACPI id>" (e.g. "acpitz_TSOC") for
// a thermal zone directory backed by an ACPI thermal object, or "".
func acpiThermalZoneName(zoneDir string) string {
	zoneType := utils.ReadStringFile(filepath.Join(zoneDir, "type"))
	if zoneType == "" {
		return ""
	}
	id := acpiIdentity(filepath.Join(zoneDir, "device"))
	if id == "" {
		return ""
	}
	return zoneType + "_" + id
}

// hwmonThermalZoneName returns the ACPI-derived name for a hwmon chip that is
// registered by a thermal zone (hwmonN/device -> thermal_zoneM), or "".
func hwmonThermalZoneName(chipDir string) string {
	zoneDir, err := filepath.EvalSymlinks(filepath.Join(chipDir, "device"))
	if err != nil || !strings.HasPrefix(filepath.Base(zoneDir), "thermal_zone") {
		return ""
	}
	return acpiThermalZoneName(zoneDir)
}

// tempSensor is a cached temperature input discovered under sysfs.
type tempSensor struct {
	key  string
	path string
}

// discoverTempSensors mirrors gopsutil's Linux sensor discovery (same file
// order, same key format) so non-ACPI sensors keep their existing names. The
// only difference is that chips backed by an ACPI thermal zone are named after
// their ACPI object instead of the generic/indexed hwmon chip name.
func discoverTempSensors(sysRoot string) []tempSensor {
	files, _ := filepath.Glob(filepath.Join(sysRoot, "class", "hwmon", "hwmon*", "temp*_input"))
	if len(files) == 0 {
		files, _ = filepath.Glob(filepath.Join(sysRoot, "class", "hwmon", "hwmon*", "device", "temp*_input"))
	}
	if len(files) == 0 {
		return discoverThermalZoneSensors(sysRoot)
	}

	sensorsOut := make([]tempSensor, 0, len(files))
	zoneNames := make(map[string]string)
	for _, file := range files {
		dir := filepath.Dir(file)
		base := strings.Split(filepath.Base(file), "_")[0]

		name, ok := utils.ReadStringFileOK(filepath.Join(dir, "name"))
		if !ok {
			continue
		}
		// Thermal zones register one hwmon chip per zone; the chip dir is the
		// parent of temp*_input (or of device/temp*_input in the CentOS layout).
		chipDir := dir
		if filepath.Base(dir) == "device" {
			chipDir = filepath.Dir(dir)
		}
		zoneName, seen := zoneNames[chipDir]
		if !seen {
			zoneName = hwmonThermalZoneName(chipDir)
			zoneNames[chipDir] = zoneName
		}
		if zoneName != "" {
			name = zoneName
		}
		if raw := utils.ReadStringFile(filepath.Join(dir, base+"_label")); raw != "" {
			name = name + "_" + strings.Join(strings.Split(strings.ToLower(raw), " "), "_")
		}
		sensorsOut = append(sensorsOut, tempSensor{key: name, path: file})
	}
	return sensorsOut
}

// discoverThermalZoneSensors handles hosts without hwmon temperature inputs,
// matching gopsutil's thermal_zone fallback but with ACPI-derived names.
func discoverThermalZoneSensors(sysRoot string) []tempSensor {
	zones, _ := filepath.Glob(filepath.Join(sysRoot, "class", "thermal", "thermal_zone*"))
	sensorsOut := make([]tempSensor, 0, len(zones))
	for _, zone := range zones {
		name := acpiThermalZoneName(zone)
		if name == "" {
			name = utils.ReadStringFile(filepath.Join(zone, "type"))
		}
		if name == "" {
			continue
		}
		sensorsOut = append(sensorsOut, tempSensor{key: name, path: filepath.Join(zone, "temp")})
	}
	return sensorsOut
}

// readMilliCelsius reads a sysfs millidegree value and converts it to °C.
func readMilliCelsius(path string) (float64, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return 0, err
	}
	v, err := strconv.ParseFloat(strings.TrimSpace(string(raw)), 64)
	if err != nil {
		return 0, err
	}
	return v / 1000, nil
}

// acpiTempReader reads temperatures from a cached list of sysfs paths and
// rediscovers when the sysfs root changes or a cached path stops working.
type acpiTempReader struct {
	mu       sync.Mutex
	root     string
	sensors  []tempSensor
	rescan   bool
	failures sensorFailureLog
}

func (r *acpiTempReader) read(sysRoot string) ([]sensors.TemperatureStat, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.sensors == nil || r.rescan || r.root != sysRoot {
		r.root = sysRoot
		r.rescan = false
		r.sensors = discoverTempSensors(sysRoot)
		slog.Debug("Discovered temperature sensors", "count", len(r.sensors), "root", sysRoot)
	}

	temps := make([]sensors.TemperatureStat, 0, len(r.sensors))
	for _, s := range r.sensors {
		temp, err := readMilliCelsius(s.path)
		if err != nil {
			r.failures.failed("temperature", s.key, s.path, err)
			// a vanished path may have been re-registered elsewhere
			if os.IsNotExist(err) {
				r.rescan = true
			}
			continue
		}
		r.failures.recovered("temperature", s.key)
		temps = append(temps, sensors.TemperatureStat{SensorKey: s.key, Temperature: temp})
	}
	return temps, nil
}

// sensorFailureLog logs a sensor read failure once when it starts failing and
// once when it recovers, so a flapping or missing sysfs path is diagnosable
// without flooding the log every collection cycle.
type sensorFailureLog struct {
	mu      sync.Mutex
	failing map[string]struct{}
	// quiet logs at Info instead of Warn, for collectors where intermittent
	// failures are routine on some hosts (e.g. fans on a runtime-suspended GPU).
	quiet bool
}

func (l *sensorFailureLog) failed(kind, key, path string, err error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.failing == nil {
		l.failing = make(map[string]struct{})
	}
	if _, ok := l.failing[key]; ok {
		return
	}
	l.failing[key] = struct{}{}
	level := slog.LevelWarn
	if l.quiet {
		level = slog.LevelInfo
	}
	attrs := []any{"kind", kind, "sensor", key, "path", path}
	if err != nil {
		attrs = append(attrs, "err", err)
	}
	slog.Log(context.Background(), level, "Sensor read failed", attrs...)
}

func (l *sensorFailureLog) recovered(kind, key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if _, ok := l.failing[key]; !ok {
		return
	}
	delete(l.failing, key)
	slog.Info("Sensor read recovered", "kind", kind, "sensor", key)
}

// isDGXSparkPlatform reports whether DMI identifies the host as an NVIDIA DGX
// Spark (GB10). Used only to pick the default for ACPI_SENSOR_NAMES.
func isDGXSparkPlatform(sysRoot string) bool {
	dmi := filepath.Join(sysRoot, "class", "dmi", "id")
	if !strings.EqualFold(utils.ReadStringFile(filepath.Join(dmi, "sys_vendor")), "NVIDIA") {
		return false
	}
	for _, f := range [...]string{"product_family", "product_name"} {
		v := strings.ToLower(strings.ReplaceAll(utils.ReadStringFile(filepath.Join(dmi, f)), "_", " "))
		if strings.Contains(v, "dgx spark") {
			return true
		}
	}
	return false
}

// acpiSensorNamesEnabled resolves ACPI_SENSOR_NAMES: "true"/"false" force the
// behavior; anything else (including unset) enables it only on DGX Spark.
func acpiSensorNamesEnabled(envVal, sysRoot string) bool {
	switch strings.ToLower(strings.TrimSpace(envVal)) {
	case "true", "1", "yes":
		return true
	case "false", "0", "no":
		return false
	}
	return isDGXSparkPlatform(sysRoot)
}
