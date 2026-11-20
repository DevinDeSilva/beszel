//go:build linux

package agent

import (
	"context"
	"log/slog"
	"os"
	"sync"

	"github.com/henrygd/beszel/agent/utils"
	"github.com/shirou/gopsutil/v4/sensors"
)

// getSensorTemps is a variable so tests can replace the platform sensor collector.
var getSensorTemps = getLinuxSensorTemps

var linuxACPITemps acpiTempReader

// useACPISensorNames is resolved once: ACPI_SENSOR_NAMES=true|false, or
// auto-detected (DGX Spark) when unset. DMI is read from the host sysfs root,
// not the SKIP_GPU shadow tree, which only contains hwmon/thermal entries.
var useACPISensorNames = sync.OnceValue(func() bool {
	envVal, _ := utils.GetEnv("ACPI_SENSOR_NAMES")
	sysRoot := "/sys"
	if v, ok := utils.GetEnv("SYS_SENSORS"); ok && v != "" {
		sysRoot = v
	} else if v := os.Getenv("HOST_SYS"); v != "" {
		sysRoot = v
	}
	enabled := acpiSensorNamesEnabled(envVal, sysRoot)
	if enabled {
		slog.Info("ACPI sensor naming enabled for thermal zones")
	}
	return enabled
})

// getLinuxSensorTemps uses gopsutil unchanged unless ACPI sensor naming is
// enabled, in which case it reads the same sysfs inputs from a cached path
// list and names thermal-zone sensors after their ACPI objects.
func getLinuxSensorTemps(ctx context.Context) ([]sensors.TemperatureStat, error) {
	if !useACPISensorNames() {
		return sensors.TemperaturesWithContext(ctx)
	}
	return linuxACPITemps.read(effectiveSysRoot(ctx))
}
