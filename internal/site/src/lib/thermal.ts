import { atom } from "nanostores"
import type { SystemStats, SystemStatsRecord } from "@/types"

/**
 * Platform thermal diagnostics derived from raw sensor series.
 *
 * Everything here is computed in the browser from the temperature (`t`), fan
 * (`f`) and GPU (`g`) maps the agent already reports, plus the hub's
 * per-window maxima/minima (`tm`, `fmn`) on longer records. Nothing extra is
 * collected or stored for these diagnostics.
 */

/** Temperature keys from ACPI thermal zones (e.g. "acpitz_TSOC" on DGX Spark). */
export const isPlatformTempKey = (key: string) => key.startsWith("acpitz")

export interface ThermalThresholds {
	/** warning when hottest platform temp exceeds this (°C) */
	warn: number
	/** critical when hottest platform temp exceeds this (°C) */
	crit: number
	/** "high temp / low fan" applies above this hottest temp (°C) */
	lowFanTemp: number
	/** ...while every fan is below this speed (RPM) */
	lowFanRpm: number
	/** recent window used for the rise-rate slope (minutes) */
	riseWindowMin: number
	/** flag rapid heating above this rise rate (°C/min) */
	riseRate: number
}

/**
 * Initial UI defaults. These are monitoring heuristics based on observed DGX
 * Spark behavior, not NVIDIA-defined shutdown limits.
 */
export const defaultThermalThresholds: ThermalThresholds = {
	warn: 85,
	crit: 90,
	lowFanTemp: 80,
	lowFanRpm: 2500,
	riseWindowMin: 5,
	riseRate: 3,
}

const thresholdsKey = "thermalThresholds"

function loadThresholds(): ThermalThresholds {
	try {
		const saved = JSON.parse(globalThis.localStorage?.getItem(thresholdsKey) ?? "null")
		if (saved && typeof saved === "object") {
			return { ...defaultThermalThresholds, ...saved }
		}
	} catch {}
	return { ...defaultThermalThresholds }
}

export const $thermalThresholds = atom<ThermalThresholds>(loadThresholds())

export function setThermalThresholds(next: ThermalThresholds) {
	$thermalThresholds.set(next)
	try {
		globalThis.localStorage?.setItem(thresholdsKey, JSON.stringify(next))
	} catch {}
}

export interface HottestReading {
	value: number
	key: string
}

/**
 * Hottest platform sensor in a record. With `peak`, uses the hub's
 * per-window maxima when present so averaging doesn't hide short spikes.
 */
export function hottestPlatform(stats: SystemStats | null | undefined, peak = false): HottestReading | undefined {
	if (!stats) return undefined
	const source = peak && stats.tm ? stats.tm : stats.t
	if (!source) return undefined
	let best: HottestReading | undefined
	for (const key in source) {
		if (!isPlatformTempKey(key)) continue
		const value = source[key]
		if (best === undefined || value > best.value) {
			best = { value, key }
		}
	}
	return best
}

/** GPU temperatures are reported in `t` under the GPU's name. Returns the hottest GPU. */
export function gpuTemp(stats: SystemStats | null | undefined, peak = false): number | undefined {
	if (!stats?.g) return undefined
	const source = peak && stats.tm ? stats.tm : stats.t
	if (!source) return undefined
	let best: number | undefined
	for (const id in stats.g) {
		const value = source[stats.g[id].n]
		if (value !== undefined && (best === undefined || value > best)) best = value
	}
	return best
}

/** Total GPU power (W) across GPUs, if reported. */
export function gpuPower(stats: SystemStats | null | undefined): number | undefined {
	if (!stats?.g) return undefined
	let total: number | undefined
	for (const id in stats.g) {
		const p = stats.g[id].p
		if (p !== undefined) total = (total ?? 0) + p
	}
	return total
}

/** Highest GPU utilization (%) across GPUs. */
export function gpuUsage(stats: SystemStats | null | undefined): number | undefined {
	if (!stats?.g) return undefined
	let best: number | undefined
	for (const id in stats.g) {
		const u = stats.g[id].u
		if (u !== undefined && (best === undefined || u > best)) best = u
	}
	return best
}

/** Slowest fan in a record. With `trough`, uses the hub's per-window minima when present. */
export function minFan(stats: SystemStats | null | undefined, trough = false): number | undefined {
	if (!stats) return undefined
	const source = trough && stats.fmn ? stats.fmn : stats.f
	if (!source) return undefined
	let low: number | undefined
	for (const key in source) {
		if (low === undefined || source[key] < low) low = source[key]
	}
	return low
}

/** True when the system reports ACPI platform thermal zones and fans. */
export function hasPlatformThermal(stats: SystemStats | null | undefined): boolean {
	if (!stats?.t || !stats.f || Object.keys(stats.f).length === 0) return false
	return Object.keys(stats.t).some(isPlatformTempKey)
}

/** Short display name for a platform sensor key ("acpitz_TSOC" -> "TSOC"). */
export function platformSensorLabel(key: string) {
	return key.replace(/^acpitz_?/, "") || key
}

/** Short display name for a fan key ("acpi_fan_FAN0" -> "FAN0"). */
export function fanLabel(key: string) {
	return key.replace(/^acpi_fan_/, "")
}

type TimedRecord = { created: number; stats: SystemStats }

/** Records with a timestamp and stats (drops the null gap markers used by charts). */
export function timedRecords(records: SystemStatsRecord[]): TimedRecord[] {
	const out: TimedRecord[] = []
	for (const r of records) {
		if (r.created !== null && r.stats) out.push(r as TimedRecord)
	}
	return out
}

/**
 * Least-squares slope (°C/min) of the hottest platform temperature over the
 * most recent `windowMin` minutes. Needs at least 3 samples.
 */
export function riseRate(records: TimedRecord[], windowMin: number): number | undefined {
	const last = records.at(-1)
	if (!last) return undefined
	const start = last.created - windowMin * 60_000
	let n = 0
	let sx = 0
	let sy = 0
	let sxx = 0
	let sxy = 0
	for (let i = records.length - 1; i >= 0 && records[i].created >= start; i--) {
		const hot = hottestPlatform(records[i].stats)
		if (!hot) continue
		const x = (records[i].created - start) / 60_000
		n++
		sx += x
		sy += hot.value
		sxx += x * x
		sxy += x * hot.value
	}
	const denom = n * sxx - sx * sx
	if (n < 3 || denom === 0) return undefined
	return (n * sxy - sx * sy) / denom
}

/**
 * Time (ms) the hottest platform temperature spent above `threshold`. Each
 * record covers the gap since the previous one (capped at `maxGapMs` so
 * outages don't count). Uses per-window peaks, so for long ranges this is an
 * upper bound.
 */
export function timeAbove(records: TimedRecord[], threshold: number, maxGapMs: number): number {
	let total = 0
	for (let i = 1; i < records.length; i++) {
		const hot = hottestPlatform(records[i].stats, true)
		if (hot && hot.value > threshold) {
			total += Math.min(records[i].created - records[i - 1].created, maxGapMs)
		}
	}
	return total
}

export type ThermalState = "normal" | "warning" | "critical"

export function thermalState(temp: number | undefined, th: ThermalThresholds): ThermalState {
	if (temp === undefined) return "normal"
	if (temp > th.crit) return "critical"
	if (temp > th.warn) return "warning"
	return "normal"
}

/** High temperature while every reported fan is below the RPM threshold. */
export function isHighTempLowFan(stats: SystemStats | null | undefined, th: ThermalThresholds): boolean {
	const hot = hottestPlatform(stats)
	const low = minFan(stats)
	if (!hot || low === undefined || !stats?.f) return false
	if (hot.value <= th.lowFanTemp) return false
	return Object.values(stats.f).every((rpm) => rpm < th.lowFanRpm)
}

/**
 * Fans seen earlier in the window that are missing from the latest record
 * (telemetry loss, not proof of a stopped fan).
 */
export function missingFans(records: TimedRecord[]): string[] {
	const last = records.at(-1)?.stats.f ?? {}
	const seen = new Set<string>()
	for (const r of records) {
		for (const key in r.stats.f ?? {}) seen.add(key)
	}
	return [...seen].filter((key) => !(key in last)).sort()
}

/**
 * Isolated 0 RPM samples (neighbors reporting a normal speed). These are kept
 * as telemetry and surfaced as transients rather than treated as a stop.
 */
export function transientZeroFanSamples(records: TimedRecord[]): number {
	let count = 0
	for (let i = 1; i < records.length - 1; i++) {
		const f = records[i].stats.f
		if (!f) continue
		for (const key in f) {
			if (f[key] !== 0) continue
			const prev = records[i - 1].stats.f?.[key]
			const next = records[i + 1].stats.f?.[key]
			if (prev && next) count++
		}
	}
	return count
}
