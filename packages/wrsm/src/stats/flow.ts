/**
 * Flow statistics for a monthly series (docs/theory/statistics.md).
 *
 * The five WR2012 calibration statistics are the ones on WRSM2000's
 * View | Statistics screen, defined in TT 689 §6.1.18 pp.61–62 and listed as
 * the `Stats_Type` record in TT 691 §8.2 pp.93–95:
 *
 * | Statistic | TT 691 name | Definition |
 * |---|---|---|
 * | MAR | QMSIM / QMOBS | mean of the n annual flows x_i (TT 689 p.61) |
 * | Mean (log) | QMLSIM / QMLOBS | mean of y_i = log x_i (p.61) |
 * | Standard deviation | SDSIM / SDOBS | √(Σ(x_i − MAR)² / (n − 1)) (p.61) |
 * | Log standard deviation | SDLSIM / SDLOBS | √(Σ(y_i − mean(log))² / (n − 1)) (p.62) |
 * | Index of seasonal variability | SISIM / SIOBS | max_m S_m − min_m S_m, S_m = Σ_{k≤m} (Q_k − 100/12), Q_k = mean flow of month k as % MAR (p.62) |
 *
 * Two typos in TT 689 are read the obvious way: the mean (log) formula sums
 * x_i where it defines y_i (p.61), and the log standard deviation subtracts
 * "Standard Deviation" where it must subtract the mean of the logs (p.62).
 * The seasonal index's `sum(Qm − m·100/12)` is the cumulative departure from
 * a uniform 100/12 % per month, read as a running sum (R3-S4).
 *
 * The coefficient of variation (CVSIM / CVOBS, TT 691 p.94) has no formula
 * in the manuals; it is SD / MAR, its standard definition (R3-S5).
 *
 * "Annual" is the hydrological year, October to September (TT 691 §12.1
 * L.004); x_i is the sum of the year's 12 months, million m³.
 * Everything is computed in float64: these are display figures, not file
 * values, so WRSM2000's float32 is not mimicked (R3-S7).
 */

import type { HydroYear, Monthly12, MonthlyRow, MonthlySeries, YearValue } from '../types.js';

/** The base of the logarithm in the log statistics (R3-S2). */
export type LogBase = 10 | 'e';

export interface FlowStatisticsOptions {
	/** Default 10 (R3-S2). */
	readonly logBase?: LogBase;
}

/** The WR2012 statistics of a set of complete hydrological years. */
export interface FlowStatistics {
	/** Number of years n. */
	readonly years: number;
	/** First and last year used. */
	readonly firstYear: HydroYear;
	readonly lastYear: HydroYear;
	/** Mean annual runoff, million m³/year. */
	readonly marMm3: number;
	/** Mean of log₁₀ (or ln) annual flow; `null` when no year has a positive flow. */
	readonly meanLog: number | null;
	/** Sample standard deviation of the annual flows, million m³/year; `null` when n < 2. */
	readonly sdMm3: number | null;
	/** Sample standard deviation of the log annual flows; `null` when fewer than 2 years have a positive flow. */
	readonly logSd: number | null;
	/** SD / MAR, dimensionless; `null` when SD is `null` or MAR is 0. */
	readonly cv: number | null;
	/** Index of seasonal variability, % MAR; `null` when MAR is 0. */
	readonly seasonalIndex: number | null;
	/** Mean flow of each month over the years, million m³/month, October first. */
	readonly meanMonthlyMm3: Monthly12;
	/** Years left out of the log statistics because their annual flow is 0 or less (R3-S3). */
	readonly yearsWithoutLog: number;
}

/** Split a series into hydrological-year rows, October first. */
export function seriesRows(series: MonthlySeries): MonthlyRow[] {
	if (series.values.length % 12 !== 0) {
		throw new RangeError(`series length ${series.values.length} is not a multiple of 12`);
	}
	const rows: MonthlyRow[] = [];
	for (let i = 0; 12 * i < series.values.length; i++) {
		rows.push({ year: series.startYear + i, months: series.values.slice(12 * i, 12 * i + 12) as unknown as Monthly12 });
	}
	return rows;
}

/** Keep the rows whose year is in [startYear, endYear] (either bound optional). */
export function rowsInPeriod(rows: readonly MonthlyRow[], startYear?: HydroYear, endYear?: HydroYear): MonthlyRow[] {
	return rows.filter((r) => (startYear === undefined || r.year >= startYear) && (endYear === undefined || r.year <= endYear));
}

function sum(values: readonly number[]): number {
	let s = 0;
	for (const v of values) s += v;
	return s;
}

/** Annual totals (sum of the 12 months, Oct–Sep), million m³/year. */
export function annualTotals(rows: readonly MonthlyRow[]): YearValue[] {
	return rows.map((r) => ({ year: r.year, value: sum(r.months) }));
}

/** Mean of each month over the rows, October first; zeros when there are no rows. */
export function meanMonthly(rows: readonly MonthlyRow[]): Monthly12 {
	const means = new Array<number>(12).fill(0);
	for (const r of rows) r.months.forEach((v, k) => (means[k] = (means[k] ?? 0) + v));
	return means.map((s) => (rows.length === 0 ? 0 : s / rows.length)) as unknown as Monthly12;
}

/**
 * Index of seasonal variability, % MAR (TT 689 p.62): the range of the
 * cumulative departure of the mean monthly flows (as % MAR) from a uniform
 * 100/12 % per month. `null` when the mean monthly flows sum to 0 or less.
 *
 * Because the departures sum to 0 over the year, the range does not depend
 * on which month the running sum starts in.
 */
export function seasonalIndex(meanMonthlyFlows: Monthly12): number | null {
	const mar = sum(meanMonthlyFlows);
	if (!(mar > 0)) return null;
	let running = 0;
	let max = -Infinity;
	let min = Infinity;
	for (const q of meanMonthlyFlows) {
		running += (100 * q) / mar - 100 / 12;
		max = Math.max(max, running);
		min = Math.min(min, running);
	}
	return max - min;
}

function sampleSd(values: readonly number[]): number | null {
	if (values.length < 2) return null;
	const mean = sum(values) / values.length;
	return Math.sqrt(sum(values.map((v) => (v - mean) ** 2)) / (values.length - 1));
}

/**
 * The WR2012 statistics of complete hydrological years (12 months each).
 * `null` when there are no rows. The caller chooses the years: a gauge
 * comparison passes the years it paired (`pairAtGauge`).
 */
export function flowStatistics(rows: readonly MonthlyRow[], options: FlowStatisticsOptions = {}): FlowStatistics | null {
	const first = rows[0];
	const last = rows[rows.length - 1];
	if (first === undefined || last === undefined) return null;
	const log = (options.logBase ?? 10) === 10 ? Math.log10 : Math.log;
	const annual = annualTotals(rows).map((a) => a.value);
	const mar = sum(annual) / annual.length;
	const logs = annual.filter((x) => x > 0).map(log);
	const sd = sampleSd(annual);
	const monthly = meanMonthly(rows);
	return {
		years: rows.length,
		firstYear: first.year,
		lastYear: last.year,
		marMm3: mar,
		meanLog: logs.length === 0 ? null : sum(logs) / logs.length,
		sdMm3: sd,
		logSd: sampleSd(logs),
		cv: sd === null || mar === 0 ? null : sd / mar,
		seasonalIndex: seasonalIndex(monthly),
		meanMonthlyMm3: monthly,
		yearsWithoutLog: annual.length - logs.length
	};
}

/** One point of a flow-duration curve. */
export interface DurationPoint {
	/** Percentage of months the value is equalled or exceeded. */
	readonly exceedancePercent: number;
	readonly value: number;
}

/**
 * Flow-duration (cumulative frequency) curve of monthly values: the
 * percentage of time a flow is equalled or exceeded (TT 689 p.68). Values
 * are ranked from largest (rank 1) to smallest and plotted at the Weibull
 * position 100·i/(n + 1) (R3-S6; the manual does not state one). Non-finite
 * values are ignored.
 */
export function flowDuration(values: readonly number[]): DurationPoint[] {
	const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => b - a);
	const n = sorted.length;
	return sorted.map((value, i) => ({ exceedancePercent: (100 * (i + 1)) / (n + 1), value }));
}
