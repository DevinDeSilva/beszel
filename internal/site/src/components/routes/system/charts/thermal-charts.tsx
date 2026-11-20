import { t } from "@lingui/core/macro"
import { useStore } from "@nanostores/react"
import { memo, useMemo, useState } from "react"
import { CartesianGrid, ReferenceLine, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis } from "recharts"
import LineChartDefault from "@/components/charts/line-chart"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ChartContainer } from "@/components/ui/chart"
import { Input } from "@/components/ui/input"
import { $userSettings } from "@/lib/stores"
import {
	$thermalThresholds,
	defaultThermalThresholds,
	fanLabel,
	gpuPower,
	gpuTemp,
	gpuUsage,
	hottestPlatform,
	isHighTempLowFan,
	minFan,
	missingFans,
	platformSensorLabel,
	riseRate,
	setThermalThresholds,
	type ThermalThresholds,
	thermalState,
	timeAbove,
	timedRecords,
	transientZeroFanSamples,
} from "@/lib/thermal"
import {
	chartMargin,
	chartTimeData,
	cn,
	decimalString,
	formatShortDate,
	formatTemperature,
	toFixedFloat,
} from "@/lib/utils"
import type { ChartData, SystemStatsRecord } from "@/types"
import { ChartCard } from "../chart-card"

const HOTTEST_COLOR = "hsl(0, 75%, 58%)"
const GPU_TEMP_COLOR = "hsl(271, 70%, 62%)"
const fanColor = (i: number, n: number) => `hsl(${200 + (i * 120) / Math.max(n, 1)}, 70%, 52%)`

type ChartProps = { chartData: ChartData; grid: boolean; dataEmpty: boolean; maxValues: boolean }

function useTempFormat() {
	const { unitTemp } = useStore($userSettings)
	return {
		tick: (val: number) => {
			const { value, unit } = formatTemperature(val, unitTemp)
			return `${toFixedFloat(value, 0)} ${unit}`
		},
		full: (val: number) => {
			const { value, unit } = formatTemperature(val, unitTemp)
			return `${decimalString(value, 1)} ${unit}`
		},
	}
}

/** Sorted fan keys seen in the window, so series stay stable while data streams in. */
function useFanKeys(records: SystemStatsRecord[]) {
	let key = ""
	for (let i = records.length - 1; i >= 0; i--) {
		const f = records[i].stats?.f
		if (f) {
			key = Object.keys(f).sort().join("\0")
			break
		}
	}
	return useMemo(() => (key ? key.split("\0") : []), [key])
}

function formatDuration(ms: number) {
	const min = Math.round(ms / 60_000)
	if (min < 60) return `${min}m`
	return `${Math.floor(min / 60)}h ${min % 60}m`
}

/** Current/peak status for platform temperature, fans and GPU over the selected range. */
export const ThermalSummaryCard = memo(function ThermalSummaryCard({ chartData }: { chartData: ChartData }) {
	const th = useStore($thermalThresholds)
	const fmt = useTempFormat()
	const [editing, setEditing] = useState(false)

	const summary = useMemo(() => {
		const records = timedRecords(chartData.systemStats)
		const latest = records.at(-1)?.stats
		let peak: { value: number; key: string; created: number } | undefined
		let peakGpuPower: number | undefined
		for (const r of records) {
			const hot = hottestPlatform(r.stats, true)
			if (hot && (!peak || hot.value > peak.value)) peak = { ...hot, created: r.created }
			const p = gpuPower(r.stats)
			if (p !== undefined && (peakGpuPower === undefined || p > peakGpuPower)) peakGpuPower = p
		}
		const maxGap = (chartTimeData[chartData.chartTime]?.expectedInterval ?? 60_000) * 2
		return {
			latest,
			hottest: hottestPlatform(latest),
			peak,
			peakGpuPower,
			minFan: minFan(latest),
			gpuTemp: gpuTemp(latest),
			gpuPower: gpuPower(latest),
			gpuUsage: gpuUsage(latest),
			rise: riseRate(records, th.riseWindowMin),
			aboveWarn: timeAbove(records, th.warn, maxGap),
			aboveCrit: timeAbove(records, th.crit, maxGap),
			missing: missingFans(records),
			transients: transientZeroFanSamples(records),
			highTempLowFan: isHighTempLowFan(latest, th),
		}
	}, [chartData.systemStats, chartData.chartTime, th])

	const state = thermalState(summary.hottest?.value, th)
	const rapid =
		summary.rise !== undefined &&
		summary.rise > th.riseRate &&
		((summary.gpuUsage ?? 0) >= 80 || (summary.gpuPower ?? 0) >= 40)

	const fans = summary.latest?.f ?? {}
	const fanKeys = Object.keys(fans).sort()

	return (
		<Card className="px-3 py-5 sm:py-6 sm:px-6 col-span-full">
			<CardHeader className="gap-1.5 relative p-0 mb-4">
				<CardTitle>{t`Platform thermal diagnostics`}</CardTitle>
				<CardDescription>
					{t`Hottest ACPI thermal zone, fan response and GPU load over the selected range. Heuristics only — the EC controls the fans.`}
				</CardDescription>
				<div className="sm:absolute sm:top-0 sm:end-0 my-1 sm:my-0">
					<Button variant="outline" size="sm" onClick={() => setEditing((v) => !v)}>
						{editing ? t`Done` : t`Thresholds`}
					</Button>
				</div>
			</CardHeader>

			<div className="flex flex-wrap gap-2 mb-4">
				{state === "critical" && <Badge variant="danger">{t`Critical temperature`}</Badge>}
				{state === "warning" && <Badge variant="warning">{t`High temperature`}</Badge>}
				{state === "normal" && summary.hottest && <Badge variant="success">{t`Temperature normal`}</Badge>}
				{summary.highTempLowFan && <Badge variant="warning">{t`High temp / low fan`}</Badge>}
				{rapid && <Badge variant="warning">{t`Rapid heating under GPU load`}</Badge>}
				{summary.missing.length > 0 && (
					<Badge variant="warning">
						{t`Fan telemetry missing`}: {summary.missing.map(fanLabel).join(", ")}
					</Badge>
				)}
				{summary.transients > 0 && (
					<Badge variant="outline">
						{t`Transient 0 RPM samples`}: {summary.transients}
					</Badge>
				)}
			</div>

			<dl className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-x-6 gap-y-4 text-sm">
				<Stat
					label={t`Hottest platform`}
					value={summary.hottest ? fmt.full(summary.hottest.value) : "–"}
					sub={summary.hottest ? platformSensorLabel(summary.hottest.key) : undefined}
					tone={state}
				/>
				<Stat
					label={t`Peak in range`}
					value={summary.peak ? fmt.full(summary.peak.value) : "–"}
					sub={
						summary.peak
							? `${platformSensorLabel(summary.peak.key)} · ${formatShortDate(new Date(summary.peak.created).toISOString())}`
							: undefined
					}
					tone={thermalState(summary.peak?.value, th)}
				/>
				<Stat
					label={t`Rise rate`}
					value={
						summary.rise !== undefined ? `${summary.rise >= 0 ? "+" : ""}${decimalString(summary.rise, 2)} °C/min` : "–"
					}
					sub={t`last ${th.riseWindowMin} min`}
				/>
				<Stat
					label={t`Fans`}
					value={fanKeys.length ? `${fanKeys.map((k) => decimalString(fans[k], 0)).join(" / ")} RPM` : "–"}
					sub={fanKeys.length ? `${fanKeys.map(fanLabel).join(" / ")} · min ${summary.minFan ?? "–"}` : undefined}
				/>
				<Stat
					label={t`GPU`}
					value={summary.gpuTemp !== undefined ? fmt.full(summary.gpuTemp) : "–"}
					sub={[
						summary.gpuUsage !== undefined ? `${decimalString(summary.gpuUsage, 0)}%` : null,
						summary.gpuPower !== undefined ? `${decimalString(summary.gpuPower, 1)} W` : null,
						summary.peakGpuPower !== undefined ? `peak ${decimalString(summary.peakGpuPower, 1)} W` : null,
					]
						.filter(Boolean)
						.join(" · ")}
				/>
				<Stat
					label={t`Time above ${th.warn} / ${th.crit} °C`}
					value={`${formatDuration(summary.aboveWarn)} / ${formatDuration(summary.aboveCrit)}`}
					sub={t`in selected range`}
				/>
			</dl>

			{editing && <ThresholdEditor value={th} />}
		</Card>
	)
})

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
	return (
		<div className="min-w-0">
			<dt className="text-muted-foreground text-xs mb-1">{label}</dt>
			<dd
				className={cn("text-lg font-semibold tabular-nums leading-tight", {
					"text-red-500": tone === "critical",
					"text-yellow-600 dark:text-yellow-400": tone === "warning",
				})}
			>
				{value}
			</dd>
			{sub && <dd className="text-xs text-muted-foreground truncate mt-0.5">{sub}</dd>}
		</div>
	)
}

function ThresholdEditor({ value }: { value: ThermalThresholds }) {
	const fields: { key: keyof ThermalThresholds; label: string }[] = [
		{ key: "warn", label: t`Warning (°C)` },
		{ key: "crit", label: t`Critical (°C)` },
		{ key: "lowFanTemp", label: t`Low-fan check above (°C)` },
		{ key: "lowFanRpm", label: t`Low fan below (RPM)` },
		{ key: "riseWindowMin", label: t`Rise window (min)` },
		{ key: "riseRate", label: t`Rapid heating (°C/min)` },
	]
	return (
		<div className="mt-5 pt-4 border-t grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-7 gap-3 items-end">
			{fields.map(({ key, label }) => (
				<label key={key} htmlFor={`thermal-${key}`} className="grid gap-1 text-xs text-muted-foreground">
					{label}
					<Input
						id={`thermal-${key}`}
						type="number"
						defaultValue={value[key]}
						onChange={(e) => {
							const n = Number(e.target.value)
							if (Number.isFinite(n) && n > 0) setThermalThresholds({ ...$thermalThresholds.get(), [key]: n })
						}}
					/>
				</label>
			))}
			<Button variant="ghost" size="sm" onClick={() => setThermalThresholds({ ...defaultThermalThresholds })}>
				{t`Reset`}
			</Button>
		</div>
	)
}

/** Hottest platform zone vs GPU temperature. */
export function ThermalTimelineChart({ chartData, grid, dataEmpty, maxValues }: ChartProps) {
	const fmt = useTempFormat()
	const th = useStore($thermalThresholds)
	const dataPoints = useMemo(
		() => [
			{
				label: t`Hottest platform`,
				color: HOTTEST_COLOR,
				dataKey: ({ stats }: SystemStatsRecord) => hottestPlatform(stats, maxValues)?.value,
			},
			{
				label: t`GPU`,
				color: GPU_TEMP_COLOR,
				dataKey: ({ stats }: SystemStatsRecord) => gpuTemp(stats, maxValues),
			},
		],
		[maxValues]
	)
	return (
		<ChartCard
			empty={dataEmpty}
			grid={grid}
			legend
			title={t`Thermal timeline`}
			description={t`Hottest platform zone and GPU temperature (warning ${th.warn} °C, critical ${th.crit} °C)`}
		>
			<LineChartDefault
				chartData={chartData}
				maxToggled={maxValues}
				legend
				domain={["auto", "auto"]}
				dataPoints={dataPoints}
				tickFormatter={fmt.tick}
				contentFormatter={({ value, payload }, key) => {
					const hot = key === t`Hottest platform` ? hottestPlatform(payload?.stats, maxValues) : undefined
					return hot ? `${fmt.full(value)} (${platformSensorLabel(hot.key)})` : fmt.full(value)
				}}
				itemSorter={(a, b) => b.value - a.value}
			/>
		</ChartCard>
	)
}

/** Each fan's RPM against the hottest platform temperature, to see the EC's response. */
export function FanResponseChart({ chartData, grid, dataEmpty, maxValues }: ChartProps) {
	const fmt = useTempFormat()
	const fanKeys = useFanKeys(chartData.systemStats)
	const dataPoints = useMemo(
		() => [
			...fanKeys.map((key, i) => ({
				label: fanLabel(key),
				color: fanColor(i, fanKeys.length),
				// with "max" selected, show each window's slowest sample so dips aren't averaged away
				dataKey: ({ stats }: SystemStatsRecord) =>
					maxValues ? (stats?.fmn?.[key] ?? stats?.f?.[key]) : stats?.f?.[key],
			})),
			{
				label: t`Hottest platform`,
				color: HOTTEST_COLOR,
				yAxisId: "right" as const,
				strokeDasharray: "4 3",
				dataKey: ({ stats }: SystemStatsRecord) => hottestPlatform(stats, maxValues)?.value,
			},
		],
		[fanKeys, maxValues]
	)
	return (
		<ChartCard
			empty={dataEmpty}
			grid={grid}
			legend
			title={t`Fan response`}
			description={t`Fan speeds (RPM, left) vs hottest platform temperature (right)`}
		>
			<LineChartDefault
				chartData={chartData}
				maxToggled={maxValues}
				legend
				domain={["auto", "auto"]}
				domain2={["auto", "auto"]}
				dataPoints={dataPoints}
				tickFormatter={(v) => `${toFixedFloat(v, 0)}`}
				tickFormatter2={fmt.tick}
				contentFormatter={({ value }, key) =>
					key === t`Hottest platform` ? fmt.full(value) : `${decimalString(value, 0)} RPM`
				}
			/>
		</ChartCard>
	)
}

/** GPU power and utilization, to correlate heat with accelerator work. */
export function GpuWorkloadChart({ chartData, grid, dataEmpty, maxValues }: ChartProps) {
	const dataPoints = useMemo(
		() => [
			{
				label: t`Power`,
				color: "hsl(32, 90%, 55%)",
				dataKey: ({ stats }: SystemStatsRecord) => gpuPower(stats),
			},
			{
				label: t`Utilization`,
				color: "hsl(160, 60%, 45%)",
				yAxisId: "right" as const,
				dataKey: ({ stats }: SystemStatsRecord) => gpuUsage(stats),
			},
		],
		[]
	)
	return (
		<ChartCard
			empty={dataEmpty}
			grid={grid}
			legend
			title={t`GPU workload`}
			description={t`GPU power (W, left) and utilization (%, right)`}
		>
			<LineChartDefault
				chartData={chartData}
				maxToggled={maxValues}
				legend
				domain={[0, "auto"]}
				domain2={[0, 100]}
				dataPoints={dataPoints}
				tickFormatter={(v) => `${toFixedFloat(v, 0)} W`}
				tickFormatter2={(v) => `${toFixedFloat(v, 0)}%`}
				contentFormatter={({ value }, key) =>
					key === t`Utilization` ? `${decimalString(value, 0)}%` : `${decimalString(value, 1)} W`
				}
			/>
		</ChartCard>
	)
}

type ScatterPoint = { temp: number; rpm: number; created: number; sensor: string }

/**
 * Fan curve: X = hottest platform temperature, Y = fan RPM, one series per fan.
 * Every record in the selected range is a point (no averaging across points);
 * longer ranges use each window's peak temperature so short highs stay visible.
 */
export function FanCurveScatter({ chartData, grid, dataEmpty }: Omit<ChartProps, "maxValues">) {
	const fmt = useTempFormat()
	const th = useStore($thermalThresholds)
	const fanKeys = useFanKeys(chartData.systemStats)

	const series = useMemo(() => {
		const records = timedRecords(chartData.systemStats)
		return fanKeys.map((key) => {
			const points: ScatterPoint[] = []
			for (const r of records) {
				const hot = hottestPlatform(r.stats, true)
				const rpm = r.stats.f?.[key]
				if (hot && rpm !== undefined) {
					points.push({ temp: hot.value, rpm, created: r.created, sensor: hot.key })
				}
			}
			return { key, points }
		})
	}, [chartData.systemStats, fanKeys])

	const hasPoints = series.some((s) => s.points.length > 0)

	return (
		<ChartCard
			empty={dataEmpty}
			grid={grid}
			legend
			title={t`Fan curve`}
			description={t`Fan RPM vs hottest platform temperature for every sample in range`}
		>
			{hasPoints && (
				<ChartContainer className="h-full w-full absolute aspect-auto bg-card">
					<ScatterChart margin={{ ...chartMargin, bottom: 18, left: 8 }}>
						<CartesianGrid />
						<XAxis
							type="number"
							dataKey="temp"
							name={t`Temperature`}
							domain={["dataMin - 2", "dataMax + 2"]}
							tickFormatter={fmt.tick}
							tickLine={false}
							axisLine={false}
							allowDecimals={false}
						/>
						<YAxis
							type="number"
							dataKey="rpm"
							name="RPM"
							domain={["auto", "auto"]}
							width={44}
							tickFormatter={(v) => `${toFixedFloat(v, 0)}`}
							tickLine={false}
							axisLine={false}
						/>
						<ZAxis range={[14, 14]} />
						<ReferenceLine x={th.warn} stroke="hsl(45, 90%, 50%)" strokeDasharray="4 3" ifOverflow="hidden" />
						<ReferenceLine x={th.crit} stroke={HOTTEST_COLOR} strokeDasharray="4 3" ifOverflow="hidden" />
						<Tooltip
							cursor={{ strokeDasharray: "3 3" }}
							content={({ active, payload }) => {
								const p = payload?.[0]?.payload as ScatterPoint | undefined
								if (!active || !p) return null
								return (
									<div className="rounded-lg border bg-background px-2.5 py-1.5 text-xs shadow-xl grid gap-0.5">
										<div className="text-muted-foreground">{formatShortDate(new Date(p.created).toISOString())}</div>
										<div>
											{payload?.[0]?.name}:{" "}
											<span className="font-medium tabular-nums">{decimalString(p.rpm, 0)} RPM</span>
										</div>
										<div>
											{platformSensorLabel(p.sensor)}:{" "}
											<span className="font-medium tabular-nums">{fmt.full(p.temp)}</span>
										</div>
									</div>
								)
							}}
						/>
						{series.map((s, i) => (
							<Scatter
								key={s.key}
								name={fanLabel(s.key)}
								data={s.points}
								fill={fanColor(i, series.length)}
								fillOpacity={0.7}
								isAnimationActive={false}
							/>
						))}
					</ScatterChart>
				</ChartContainer>
			)}
		</ChartCard>
	)
}

/** The full platform thermal section. */
export function ThermalDiagnostics(props: ChartProps) {
	return (
		<div className="grid xl:grid-cols-2 gap-4">
			<ThermalSummaryCard chartData={props.chartData} />
			<ThermalTimelineChart {...props} />
			<FanResponseChart {...props} />
			<GpuWorkloadChart {...props} />
			<FanCurveScatter chartData={props.chartData} grid={props.grid} dataEmpty={props.dataEmpty} />
		</div>
	)
}
