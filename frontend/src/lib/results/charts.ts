/**
 * Chart descriptions for the results screen, independent of the plotting
 * library: `plot.ts` turns one into a uPlot chart, and `chartTable` turns
 * the same description into the data table every chart offers as its
 * accessible alternative.
 */

import { flowDuration } from './engine.js';
import type { TargetAnalysis } from './analysis.js';
import {
	ANNUAL_FLOW_UNIT,
	FLOW_UNIT,
	HYDRO_MONTHS,
	STORAGE_UNIT,
	formatNumber,
	hydroYearLabel,
	monthLabel
} from './format.js';

/** How the x values are labelled. */
export type XKind = 'month' | 'hydroYear' | 'monthOfYear' | 'percent';

export interface ChartLine {
	readonly label: string;
	/** One per x; `null` = no value (a gap). */
	readonly values: readonly (number | null)[];
	/** Style slot: 0, 1, 2 … for runs; 'observed' for the gauge. Each slot has its own colour **and** dash. */
	readonly style: number | 'observed';
	/** Per x: draw a marker (incomplete observed months). */
	readonly marks?: readonly boolean[];
}

export interface ChartSpec {
	/** Stable id, also the figure's DOM id suffix. */
	readonly id: 'monthly' | 'annual' | 'mean-monthly' | 'duration';
	readonly title: string;
	readonly xLabel: string;
	readonly yLabel: string;
	readonly xKind: XKind;
	readonly x: readonly number[];
	readonly lines: readonly ChartLine[];
	/** Draw as grouped bars (mean monthly flows). */
	readonly bars: boolean;
	/** Logarithmic y axis. */
	readonly yLog: boolean;
	/** Join the points across `null`s (duration curves on a merged x). */
	readonly spanGaps: boolean;
}

const HYDRO_YEAR_AXIS = 'Hydrological year (October–September)';

function isReservoir(a: TargetAnalysis): boolean {
	return a.target.kind === 'reservoir';
}

function observedLine(label: string, values: readonly (number | null)[], marks?: readonly boolean[]): ChartLine {
	return marks === undefined ? { label, values, style: 'observed' } : { label, values, style: 'observed', marks };
}

/** Monthly hydrograph: every run over the whole record, with the observed flows. */
export function monthlyChart(a: TargetAnalysis): ChartSpec | null {
	if (a.timeline === null) return null;
	const { startYear, years } = a.timeline;
	const x = Array.from({ length: 12 * years }, (_, i) => startYear + i / 12);
	const lines: ChartLine[] = a.runs.map((r, i) => ({ label: r.label, values: r.values, style: i }));
	if (a.observed !== null) lines.push(observedLine('Observed', a.observed.values, a.observed.incomplete));
	const reservoir = isReservoir(a);
	return {
		id: 'monthly',
		title: reservoir ? 'Monthly storage' : 'Monthly hydrograph',
		xLabel: HYDRO_YEAR_AXIS,
		yLabel: reservoir ? `End-of-month storage (${STORAGE_UNIT})` : `Monthly flow (${FLOW_UNIT})`,
		xKind: 'month',
		x,
		lines,
		bars: false,
		yLog: false,
		spanGaps: false
	};
}

function yearly(values: readonly (number | null)[], years: number, reduce: 'sum' | 'mean'): (number | null)[] {
	return Array.from({ length: years }, (_, i) => {
		const months = values.slice(12 * i, 12 * i + 12);
		if (months.length < 12 || months.some((v) => v === null)) return null;
		const total = (months as number[]).reduce((s, v) => s + v, 0);
		return reduce === 'sum' ? total : total / 12;
	});
}

/**
 * Annual hydrograph: the total of each hydrological year (a reservoir's
 * mean storage). An observed year with any unusable month has no value.
 */
export function annualChart(a: TargetAnalysis): ChartSpec | null {
	if (a.timeline === null) return null;
	const { startYear, years } = a.timeline;
	const reservoir = isReservoir(a);
	const reduce = reservoir ? 'mean' : 'sum';
	const lines: ChartLine[] = a.runs.map((r, i) => ({ label: r.label, values: yearly(r.values, years, reduce), style: i }));
	if (a.observed !== null) {
		const usable = a.observed.values.map((v, i) => (a.includeIncomplete || !a.observed?.incomplete[i] ? v : null));
		lines.push(observedLine('Observed (complete years)', yearly(usable, years, 'sum')));
	}
	return {
		id: 'annual',
		title: reservoir ? 'Annual mean storage' : 'Annual hydrograph',
		xLabel: HYDRO_YEAR_AXIS,
		yLabel: reservoir ? `Mean storage (${STORAGE_UNIT})` : `Annual flow (${ANNUAL_FLOW_UNIT})`,
		xKind: 'hydroYear',
		x: Array.from({ length: years }, (_, i) => startYear + i),
		lines,
		bars: false,
		yLog: false,
		spanGaps: false
	};
}

/** Mean monthly flows over the statistics period (the gauge's complete years when there is a gauge). */
export function meanMonthlyChart(a: TargetAnalysis): ChartSpec | null {
	if (a.period === null) return null;
	const lines: ChartLine[] = a.runs.map((r, i) => ({
		label: r.label,
		values: r.statistics === null ? new Array<null>(12).fill(null) : [...r.statistics.meanMonthlyMm3],
		style: i
	}));
	if (a.observedStatistics !== null) lines.push(observedLine('Observed', [...a.observedStatistics.meanMonthlyMm3]));
	const reservoir = isReservoir(a);
	return {
		id: 'mean-monthly',
		title: reservoir ? 'Mean monthly storage' : 'Mean monthly flows',
		xLabel: 'Month (hydrological year, October first)',
		yLabel: reservoir ? `Mean storage (${STORAGE_UNIT})` : `Mean flow (${FLOW_UNIT})`,
		xKind: 'monthOfYear',
		x: HYDRO_MONTHS.map((_, k) => k),
		lines,
		bars: true,
		yLog: false,
		spanGaps: false
	};
}

/**
 * Flow-duration curve of the monthly values in the statistics period
 * (Weibull plotting position, R3-S6). The curves have different numbers of
 * points, so their x values are merged and each curve spans its gaps. The
 * flow axis is logarithmic when every value is positive.
 */
export function durationChart(a: TargetAnalysis): ChartSpec | null {
	const curves = a.runs.map((r, i) => ({ label: r.label, style: i as number | 'observed', points: flowDuration(r.periodMonths) }));
	if (a.observedPeriodMonths.length > 0) {
		curves.push({ label: 'Observed', style: 'observed', points: flowDuration(a.observedPeriodMonths) });
	}
	const xs = [...new Set(curves.flatMap((c) => c.points.map((p) => p.exceedancePercent)))].sort((p, q) => p - q);
	if (xs.length === 0) return null;
	const index = new Map(xs.map((x, i) => [x, i]));
	const lines: ChartLine[] = curves.map((c) => {
		const values = new Array<number | null>(xs.length).fill(null);
		for (const p of c.points) values[index.get(p.exceedancePercent) as number] = p.value;
		return { label: c.label, values, style: c.style };
	});
	const all = curves.flatMap((c) => c.points.map((p) => p.value));
	const reservoir = isReservoir(a);
	return {
		id: 'duration',
		title: reservoir ? 'Storage-duration curve' : 'Flow-duration curve',
		xLabel: 'Time equalled or exceeded (% of months)',
		yLabel: reservoir ? `Storage (${STORAGE_UNIT})` : `Monthly flow (${FLOW_UNIT})`,
		xKind: 'percent',
		x: xs,
		lines,
		bars: false,
		yLog: all.length > 0 && all.every((v) => v > 0),
		spanGaps: true
	};
}

/** All the charts for a target, in screen order. */
export function targetCharts(a: TargetAnalysis): ChartSpec[] {
	return [monthlyChart(a), annualChart(a), meanMonthlyChart(a), durationChart(a)].filter((c): c is ChartSpec => c !== null);
}

/** The label of an x value. */
export function xLabelOf(kind: XKind, x: number): string {
	switch (kind) {
		case 'month': {
			const year = Math.floor(x + 1e-9);
			return monthLabel(year, Math.round((x - year) * 12));
		}
		case 'hydroYear':
			return hydroYearLabel(x);
		case 'monthOfYear':
			return HYDRO_MONTHS[x] ?? String(x);
		case 'percent':
			return `${formatNumber(x, 1)} %`;
	}
}

export interface DataTable {
	readonly caption: string;
	readonly columns: readonly string[];
	readonly rows: readonly (readonly string[])[];
}

/** The data table alternative of a chart: one row per x, one column per line. */
export function chartTable(spec: ChartSpec): DataTable {
	const marked = spec.lines.some((l) => l.marks?.some(Boolean));
	const columns = [spec.xLabel, ...spec.lines.map((l) => l.label)];
	if (marked) columns.push('Note');
	const rows = spec.x.map((x, i) => {
		const row = [xLabelOf(spec.xKind, x), ...spec.lines.map((l) => formatNumber(l.values[i], spec.xKind === 'percent' ? 3 : 2))];
		if (marked) row.push(spec.lines.some((l) => l.marks?.[i] === true) ? 'observed month incomplete (+)' : '');
		return row;
	});
	return { caption: `${spec.title}: ${spec.yLabel}`, columns, rows };
}
