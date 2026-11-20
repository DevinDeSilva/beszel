import { expect, test } from "bun:test"
import type { SystemStats, SystemStatsRecord } from "@/types"
import {
	defaultThermalThresholds as th,
	gpuTemp,
	hasPlatformThermal,
	hottestPlatform,
	isHighTempLowFan,
	minFan,
	missingFans,
	riseRate,
	thermalState,
	timeAbove,
	timedRecords,
	transientZeroFanSamples,
} from "./thermal"

// Shape of a DGX Spark record as reported by the agent with ACPI sensor naming.
const dgx = (hot: number, fans: [number, number] | null, extra: Partial<SystemStats> = {}) =>
	({
		t: { acpitz_TSOC: hot, acpitz_TGPU: hot - 1, acpitz_TUNC: hot - 3, GB10: hot - 15, nvme_composite: 99 },
		...(fans ? { f: { acpi_fan_FAN0: fans[0], acpi_fan_FAN1: fans[1] } } : {}),
		g: { "0": { n: "GB10", u: 94, p: 51.5 } },
		...extra,
	}) as SystemStats

const series = (stats: SystemStats[], stepMs = 60_000) =>
	stats.map((s, i) => ({ created: i * stepMs, stats: s })) as unknown as SystemStatsRecord[]

test("hottest platform ignores non-ACPI sensors and reports the source", () => {
	// nvme at 99 °C must not be treated as the platform hottest
	expect(hottestPlatform(dgx(65.9, [2040, 2100]))).toEqual({ value: 65.9, key: "acpitz_TSOC" })
	expect(gpuTemp(dgx(65.9, [2040, 2100]))).toBeCloseTo(50.9)
	expect(hottestPlatform({ t: { coretemp: 50 } } as unknown as SystemStats)).toBeUndefined()
})

test("peak mode uses per-window maxima so averaging doesn't hide spikes", () => {
	const s = dgx(62, [2040, 2100], { tm: { acpitz_TSOC: 96.8, GB10: 81 } })
	expect(hottestPlatform(s)?.value).toBe(62)
	expect(hottestPlatform(s, true)).toEqual({ value: 96.8, key: "acpitz_TSOC" })
	expect(gpuTemp(s, true)).toBe(81)
})

test("min fan and transient zero handling", () => {
	expect(minFan(dgx(40, [2035, 2090]))).toBe(2035)
	const recs = timedRecords(series([dgx(40, [2035, 2090]), dgx(40, [0, 2090]), dgx(40, [2030, 2088])]))
	expect(transientZeroFanSamples(recs)).toBe(1)
	// a zero at the edge of the window isn't classified as a transient
	expect(transientZeroFanSamples(recs.slice(1))).toBe(0)
})

test("missing fan telemetry is detected", () => {
	const recs = timedRecords(series([dgx(40, [2035, 2090]), { ...dgx(40, null), f: { acpi_fan_FAN1: 2090 } }]))
	expect(missingFans(recs)).toEqual(["acpi_fan_FAN0"])
})

test("rise rate is a least-squares slope in °C/min", () => {
	const recs = timedRecords(series([60, 62, 64, 66, 68, 70].map((v) => dgx(v, [2040, 2100]))))
	expect(riseRate(recs, 5)).toBeCloseTo(2)
	expect(riseRate(recs.slice(0, 2), 5)).toBeUndefined()
})

test("time above threshold counts sample intervals, capped at gaps", () => {
	const recs = timedRecords(series([80, 86, 91, 92, 70].map((v) => dgx(v, [2040, 2100]))))
	expect(timeAbove(recs, 85, 120_000)).toBe(3 * 60_000)
	expect(timeAbove(recs, 90, 120_000)).toBe(2 * 60_000)
	expect(timeAbove(recs, 85, 30_000)).toBe(3 * 30_000)
})

test("thermal state and high-temp/low-fan diagnostics", () => {
	expect(thermalState(80, th)).toBe("normal")
	expect(thermalState(86, th)).toBe("warning")
	expect(thermalState(96.8, th)).toBe("critical")
	expect(isHighTempLowFan(dgx(85, [2040, 2100]), th)).toBe(true)
	expect(isHighTempLowFan(dgx(85, [2040, 3200]), th)).toBe(false)
	expect(isHighTempLowFan(dgx(65.9, [2040, 2100]), th)).toBe(false)
})

test("section is shown only for hosts with ACPI zones and fans", () => {
	expect(hasPlatformThermal(dgx(40, [2035, 2090]))).toBe(true)
	expect(hasPlatformThermal(dgx(40, null))).toBe(false)
	expect(hasPlatformThermal({ t: { coretemp: 40 }, f: { nct_fan1: 900 } } as unknown as SystemStats)).toBe(false)
})
