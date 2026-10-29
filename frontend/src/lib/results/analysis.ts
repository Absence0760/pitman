/**
 * Everything the results screen computes for one route or reservoir across
 * the runs: the series on a common timeline, the observed flows laid on it,
 * the statistics period and the statistics (docs/theory/statistics.md).
 */

import type { HydroYear, MonthlySeries, RunResult } from '@pitman/wrsm';
import {
	flowStatistics,
	gaugeStatistics,
	observedOnSeries,
	rowsInPeriod,
	seriesRows,
	type FlowStatistics,
	type GaugeStatistics
} from './engine.js';
import { runLabel, runSlug } from './format.js';
import { targetSeries, type ResultTarget } from './targets.js';

export interface Timeline {
	readonly startYear: HydroYear;
	/** Number of hydrological years. */
	readonly years: number;
}

export interface RunAnalysis {
	readonly label: string;
	readonly slug: string;
	readonly series: MonthlySeries | null;
	/** The series on the common timeline, `null` where the run has no value. */
	readonly values: readonly (number | null)[];
	/** Statistics over the period: of the gauge's complete years when there is a gauge. */
	readonly statistics: FlowStatistics | null;
	/** Present when the target has observed flows. */
	readonly gauge: GaugeStatistics | null;
	/** Monthly values in the statistics period (paired months at a gauge), for the duration curve. */
	readonly periodMonths: readonly number[];
}

export interface StatisticsOptions {
	readonly startYear?: HydroYear;
	readonly endYear?: HydroYear;
	/** Use observed months flagged `+`. Default true (R3-S1). */
	readonly includeIncomplete?: boolean;
}

export interface TargetAnalysis {
	readonly target: ResultTarget;
	readonly timeline: Timeline | null;
	readonly runs: readonly RunAnalysis[];
	/** Observed flows on the timeline; `null` without a gauge file. */
	readonly observed: { readonly values: readonly (number | null)[]; readonly incomplete: readonly boolean[] } | null;
	/** The statistics of the observed flows over the paired complete years. */
	readonly observedStatistics: FlowStatistics | null;
	/** Observed values of the paired months in the period, for the duration curve. */
	readonly observedPeriodMonths: readonly number[];
	/** The period the statistics cover; `null` when there is nothing to cover. */
	readonly period: { readonly startYear: HydroYear; readonly endYear: HydroYear } | null;
	readonly includeIncomplete: boolean;
}

/** The years every series spans together (their union). */
export function commonTimeline(series: readonly (MonthlySeries | null)[]): Timeline | null {
	let start = Infinity;
	let end = -Infinity;
	for (const s of series) {
		if (s === null || s.values.length === 0) continue;
		start = Math.min(start, s.startYear);
		end = Math.max(end, s.startYear + s.values.length / 12 - 1);
	}
	return start === Infinity ? null : { startYear: start, years: end - start + 1 };
}

/** A series on a timeline, `null` outside it. */
export function onTimeline(series: MonthlySeries | null, timeline: Timeline): (number | null)[] {
	const out = new Array<number | null>(12 * timeline.years).fill(null);
	if (series === null) return out;
	const offset = 12 * (series.startYear - timeline.startYear);
	series.values.forEach((v, i) => {
		const j = offset + i;
		if (j >= 0 && j < out.length) out[j] = v;
	});
	return out;
}

/** Analyse one target in every run. */
export function analyseTarget(target: ResultTarget, runs: readonly RunResult[], options: StatisticsOptions = {}): TargetAnalysis {
	const includeIncomplete = options.includeIncomplete ?? true;
	const seriesList = runs.map((r) => targetSeries(r, target));
	const timeline = commonTimeline(seriesList);
	const observedFlow = target.kind === 'route' ? target.observed : null;
	const observed = observedFlow === null || timeline === null ? null : observedOnSeries(observedFlow, timeline.startYear, timeline.years);

	// The period: what the user chose, else the gauge's record within the simulation (TT 689 p.60), else the whole record (R3-S9).
	let period: TargetAnalysis['period'] = null;
	if (timeline !== null) {
		let start = timeline.startYear;
		let end = timeline.startYear + timeline.years - 1;
		if (observedFlow !== null) {
			const years = observedFlow.rows.map((r) => r.year).filter((y) => y >= start && y <= end);
			if (years.length > 0) {
				start = Math.min(...years);
				end = Math.max(...years);
			}
		}
		period = {
			startYear: Math.max(options.startYear ?? start, timeline.startYear),
			endYear: Math.min(options.endYear ?? end, timeline.startYear + timeline.years - 1)
		};
		if (period.startYear > period.endYear) period = null;
	}

	// Compare with the gauge only when it has a year in the period; otherwise the statistics are the simulated ones alone.
	const gaugeFlow =
		observedFlow !== null && period !== null && observedFlow.rows.some((r) => r.year >= period.startYear && r.year <= period.endYear)
			? observedFlow
			: null;
	let observedStatistics: FlowStatistics | null = null;
	let observedPeriodMonths: number[] = [];
	const analysed = runs.map((run, i): RunAnalysis => {
		const series = seriesList[i] ?? null;
		const base = {
			label: runLabel(run.mode),
			slug: runSlug(run.mode),
			series,
			values: timeline === null ? [] : onTimeline(series, timeline)
		};
		if (series === null || period === null) return { ...base, statistics: null, gauge: null, periodMonths: [] };
		if (gaugeFlow !== null) {
			const gauge = gaugeStatistics(series, gaugeFlow, { ...period, includeIncomplete });
			if (observedStatistics === null && gauge.observed !== null) observedStatistics = gauge.observed;
			if (observedPeriodMonths.length === 0) observedPeriodMonths = gauge.pairing.months.map((m) => m.observed);
			return { ...base, statistics: gauge.simulated, gauge, periodMonths: gauge.pairing.months.map((m) => m.simulated) };
		}
		const rows = rowsInPeriod(seriesRows(series), period.startYear, period.endYear);
		return { ...base, statistics: flowStatistics(rows), gauge: null, periodMonths: rows.flatMap((r) => [...r.months]) };
	});

	return {
		target,
		timeline,
		runs: analysed,
		observed,
		observedStatistics,
		observedPeriodMonths,
		period,
		includeIncomplete
	};
}
