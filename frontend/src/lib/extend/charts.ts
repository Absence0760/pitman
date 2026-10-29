/**
 * The fit diagnostics' charts (extend.md § Fit diagnostics, items 1–3),
 * independent of the plotting library: `plot.ts` draws a spec with uPlot and
 * `chartTable` gives the same numbers as the data table each chart offers
 * as its accessible alternative. Every number comes from the engine's fit
 * (`ExtensionFit`) or the file's own rows; the only arithmetic here is a
 * factor times a CHIRPS value, and sums of a year's months.
 */

import type { ExtensionFit, HydroYear, Monthly12, RainfallSeries } from '@pitman/wrsm';
import { HYDRO_MONTHS, formatNumber, hydroYearLabel } from '#lib/results/format.js';
import { MONTH_NAMES } from './factors.js';

export type ExtendXKind = 'percent' | 'monthOfYear' | 'hydroYear';

export interface ExtendSeries {
	readonly label: string;
	readonly values: readonly (number | null)[];
	/** How it is drawn. */
	readonly mark: 'points' | 'line' | 'bars';
	/** Colour slot: a month index (0 = October) for the scatter, else 'model' | 'chirps' | 'corrected' | 'oneToOne'. */
	readonly style: number | 'model' | 'chirps' | 'corrected' | 'oneToOne';
}

export interface ExtendChartSpec {
	readonly id: 'scatter' | 'means' | 'annual';
	readonly title: string;
	readonly xLabel: string;
	readonly yLabel: string;
	readonly xKind: ExtendXKind;
	readonly x: readonly number[];
	readonly series: readonly ExtendSeries[];
	/** x ranges drawn shaded (the appended years), with what they mean. */
	readonly bands: readonly { readonly from: number; readonly to: number; readonly label: string }[];
	/** A label printed above each x (the factor above each month's bars). */
	readonly xNotes?: readonly string[];
}

export interface ChartTable {
	readonly caption: string;
	readonly columns: readonly string[];
	readonly rows: readonly (readonly string[])[];
}

const PCT_MAP = '% of MAP';

function rowsByYear(ran: RainfallSeries): Map<HydroYear, Monthly12> {
	return new Map(ran.rows.map((r) => [r.year, r.months]));
}

function chirpsByYear(fit: ExtensionFit): Map<HydroYear, readonly (number | null)[]> {
	return new Map(fit.chirpsPct.map((y) => [y.year, y.months]));
}

function overlapYears(fit: ExtensionFit): HydroYear[] {
	const years: HydroYear[] = [];
	for (let y = fit.overlap.startYear; y <= fit.overlap.endYear; y++) years.push(y);
	return years;
}

function sum(values: readonly (number | null)[]): number | null {
	let total = 0;
	for (const v of values) {
		if (v === null) return null;
		total += v;
	}
	return total;
}

/** One overlap month as a point of the scatter. */
export interface ScatterPoint {
	readonly year: HydroYear;
	readonly month: number;
	/** CHIRPS % of its MAP (`p`), or `f·p` when corrected. */
	readonly x: number;
	/** The file's % MAP (`r`). */
	readonly y: number;
}

/** Every overlap month with both values, ordered by x (uPlot wants ascending x). */
export function scatterPoints(fit: ExtensionFit, ran: RainfallSeries, factors: Monthly12, corrected: boolean): ScatterPoint[] {
	const r = rowsByYear(ran);
	const p = chirpsByYear(fit);
	const points: ScatterPoint[] = [];
	for (const year of overlapYears(fit)) {
		const file = r.get(year);
		const chirps = p.get(year);
		if (file === undefined || chirps === undefined) continue;
		for (let month = 0; month < 12; month++) {
			const pk = chirps[month];
			if (pk === null || pk === undefined) continue;
			points.push({ year, month, x: corrected ? factors[month] * pk : pk, y: file[month] });
		}
	}
	return points.sort((a, b) => a.x - b.x || a.year - b.year || a.month - b.month);
}

/**
 * 1. Monthly scatter: `p` (or `f·p`) against `r`, a series per calendar
 * month, and the 1:1 line. `month` shows one month only (a way to tell the
 * months apart that doesn't rest on colour).
 */
export function scatterChart(fit: ExtensionFit, ran: RainfallSeries, factors: Monthly12, corrected: boolean, month: number | null = null): ExtendChartSpec {
	const points = scatterPoints(fit, ran, factors, corrected).filter((pt) => month === null || pt.month === month);
	const x = points.map((pt) => pt.x);
	const months = month === null ? HYDRO_MONTHS.map((_, k) => k) : [month];
	const series: ExtendSeries[] = months.map((k) => ({
		label: MONTH_NAMES[k] as string,
		values: points.map((pt) => (pt.month === k ? pt.y : null)),
		mark: 'points',
		style: k
	}));
	series.push({ label: '1:1 line', values: x, mark: 'line', style: 'oneToOne' });
	return {
		id: 'scatter',
		title: corrected ? 'Monthly scatter, corrected CHIRPS (f·p) against the file' : 'Monthly scatter, CHIRPS (p) against the file',
		xLabel: corrected ? `Corrected CHIRPS, f × p (${PCT_MAP})` : `CHIRPS, p (% of CHIRPS MAP)`,
		yLabel: `The file, r (${PCT_MAP})`,
		xKind: 'percent',
		x,
		series,
		bands: []
	};
}

/** 2. Mean monthly bars over the overlap: `r̄`, `p̄` and `f·p̄`, the factor above each month. */
export function meansChart(fit: ExtensionFit, factors: Monthly12): ExtendChartSpec {
	return {
		id: 'means',
		title: 'Mean monthly rainfall over the overlap',
		xLabel: 'Month (hydrological year, October first)',
		yLabel: `Mean (${PCT_MAP})`,
		xKind: 'monthOfYear',
		x: HYDRO_MONTHS.map((_, k) => k),
		series: [
			{ label: 'The file, r', values: fit.factors.map((f) => f.meanFilePct), mark: 'bars', style: 'model' },
			{ label: 'CHIRPS, p', values: fit.factors.map((f) => f.meanChirpsPct), mark: 'bars', style: 'chirps' },
			{ label: 'Corrected, f × p', values: fit.factors.map((f, k) => factors[k] * f.meanChirpsPct), mark: 'bars', style: 'corrected' }
		],
		bands: [],
		xNotes: factors.map((f) => `×${f.toFixed(2)}`)
	};
}

/** 3. Annual totals: `Σr`, `Σp`, `Σf·p` from the overlap's first year to the last appended year, the appended stretch shaded. */
export function annualChart(fit: ExtensionFit, ran: RainfallSeries, factors: Monthly12): ExtendChartSpec {
	const r = rowsByYear(ran);
	const p = chirpsByYear(fit);
	const last = Math.max(fit.overlap.endYear, fit.appendable?.lastYear ?? fit.overlap.endYear);
	const x: number[] = [];
	for (let y = fit.overlap.startYear; y <= last; y++) x.push(y);
	const model = x.map((y) => {
		const months = r.get(y);
		return months === undefined ? null : sum(months);
	});
	const chirps = x.map((y) => {
		const months = p.get(y);
		return months === undefined ? null : sum(months);
	});
	const corrected = x.map((y) => {
		const months = p.get(y);
		return months === undefined ? null : sum(months.map((v, k) => (v === null ? null : factors[k] * v)));
	});
	return {
		id: 'annual',
		title: 'Annual totals',
		xLabel: 'Hydrological year (October–September)',
		yLabel: `Annual total (${PCT_MAP})`,
		xKind: 'hydroYear',
		x,
		series: [
			{ label: 'The file, Σr', values: model, mark: 'line', style: 'model' },
			{ label: 'CHIRPS, Σp', values: chirps, mark: 'line', style: 'chirps' },
			{ label: 'Corrected, Σ f × p', values: corrected, mark: 'line', style: 'corrected' }
		],
		bands: fit.appendable ? [{ from: fit.appendable.firstYear - 0.5, to: fit.appendable.lastYear + 0.5, label: 'Appended years (shaded)' }] : []
	};
}

function xText(kind: ExtendXKind, x: number): string {
	if (kind === 'hydroYear') return hydroYearLabel(x);
	if (kind === 'monthOfYear') return MONTH_NAMES[x] ?? String(x);
	return formatNumber(x, 2);
}

/** The data table behind a chart: every plotted value, and the band and note columns where the chart has them. */
export function chartTable(spec: ExtendChartSpec, points?: readonly ScatterPoint[]): ChartTable {
	if (spec.id === 'scatter' && points !== undefined) {
		return {
			caption: `${spec.title}: every overlap month`,
			columns: ['Year', 'Month', spec.xLabel, spec.yLabel],
			rows: points.map((pt) => [hydroYearLabel(pt.year), MONTH_NAMES[pt.month] as string, formatNumber(pt.x, 2), formatNumber(pt.y, 2)])
		};
	}
	const plotted = spec.series.filter((s) => s.style !== 'oneToOne');
	const band = spec.bands[0];
	const columns = [spec.xLabel, ...plotted.map((s) => `${s.label} (${PCT_MAP})`)];
	if (spec.xNotes) columns.push('Factor in use');
	if (band) columns.push('Appended');
	return {
		caption: spec.title,
		columns,
		rows: spec.x.map((x, i) => {
			const row = [xText(spec.xKind, x), ...plotted.map((s) => formatNumber(s.values[i] ?? null, 2))];
			if (spec.xNotes) row.push(spec.xNotes[i]?.replace('×', '') ?? '');
			if (band) row.push(x >= band.from && x <= band.to ? 'yes' : 'no');
			return row;
		})
	};
}
