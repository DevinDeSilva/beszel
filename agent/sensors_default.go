//go:build !windows && !freebsd && !linux

package agent

import (
	"github.com/shirou/gopsutil/v4/sensors"
)

var getSensorTemps = sensors.TemperaturesWithContext
