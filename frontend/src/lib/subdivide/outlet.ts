/**
 * Before and after at the outlet. Route numbers survive a split (the outlet
 * piece keeps the module's routes), so one route number reads both sets of
 * results. The default is not a route leaving the module itself: a new piece's
 * water joins further down, so the first place all of the module's water
 * passes through is what a before/after can honestly compare.
 */

import type { ModuleRef, MonthlySeries, NetworkBundle, RunResult } from '@pitman/wrsm';
import type { ChartSpec } from '#lib/results/charts.js';
import { FLOW_UNIT, HYDRO_MONTHS, hydroYearLabel, runLabel, runSlug } from '#lib/results/format.js';
import { moduleLabel } from '#lib/results/targets.js';

export interface OutletChoice {
	readonly route: number;
	readonly label: string;
}

/** Every route, labelled by its ends, for the "compare at" list. */
export function routeChoices(bundle: NetworkBundle): OutletChoice[] {
	return bundle.network.routes.map((r) => ({ route: r.number, label: `Route ${r.number}: ${moduleLabel(bundle, r.upstreamPosition)} to ${moduleLabel(bundle, r.downstreamPosition)}` }));
}

function reachable(bundle: NetworkBundle, position: number): Set<number> {
	const seen = new Set<number>([position]);
	const queue = [position];
	while (queue.length > 0) {
		const at = queue.pop() as number;
		for (const r of bundle.network.routes) {
			if (r.upstreamPosition === at && r.downstreamPosition !== 0 && !seen.has(r.downstreamPosition)) {
				seen.add(r.downstreamPosition);
				queue.push(r.downstreamPosition);
			}
		}
	}
	return seen;
}

/**
 * The default route to compare at, read on the network **before** the split:
 * the route leaving the first module all of `module`'s outflow routes reach,
 * else, with no such module or no way out of it, the module's first outflow
 * route (the user can pick another).
 */
export function outletRoute(bundle: NetworkBundle, module: ModuleRef): number | undefined {
	const { routes, modules } = bundle.network;
	const position = modules.findIndex((m) => m.type === module.type && m.number === module.number) + 1;
	if (position === 0) return undefined;
	const leaving = routes.filter((r) => r.upstreamPosition === position);
	const first = leaving[0];
	if (first === undefined) return undefined;
	const [head, ...tail] = leaving.filter((r) => r.downstreamPosition !== 0).map((r) => reachable(bundle, r.downstreamPosition));
	if (head === undefined) return first.number;
	const common = [...head].filter((p) => tail.every((s) => s.has(p))).sort((a, b) => a - b);
	for (const p of common) {
		const out = routes.find((r) => r.upstreamPosition === p);
		if (out) return out.number;
	}
	return first.number;
}

function monthlyWindow(series: MonthlySeries, startYear: number, endYear: number): { readonly offset: number; readonly years: number } | null {
	const years = endYear - startYear + 1;
	const offset = (startYear - series.startYear) * 12;
	return years <= 0 || offset < 0 || offset + years * 12 > series.values.length ? null : { offset, years };
}

/** Mean annual flow over `startYear`–`endYear`: each hydrological year's months summed, then averaged. */
export function meanAnnual(series: MonthlySeries, startYear: number, endYear: number): number | null {
	const window = monthlyWindow(series, startYear, endYear);
	if (window === null) return null;
	let total = 0;
	for (let i = window.offset; i < window.offset + window.years * 12; i++) total += series.values[i] as number;
	return total / window.years;
}

/** Mean of each month over the period, October first. */
export function meanMonthly(series: MonthlySeries, startYear: number, endYear: number): (number | null)[] {
	const window = monthlyWindow(series, startYear, endYear);
	if (window === null) return new Array<null>(12).fill(null);
	const totals = new Array<number>(12).fill(0);
	for (let y = 0; y < window.years; y++) {
		for (let k = 0; k < 12; k++) totals[k] = (totals[k] as number) + (series.values[window.offset + y * 12 + k] as number);
	}
	return totals.map((t) => t / window.years);
}

export interface OutletPair {
	readonly slug: string;
	readonly before: RunResult;
	readonly after: RunResult;
	readonly startYear: number;
	readonly endYear: number;
}

/** The modes in both sets of results, compared over the years both ran. */
export function outletPairs(before: readonly RunResult[], after: readonly RunResult[]): OutletPair[] {
	return before.flatMap((b) => {
		const a = after.find((r) => runSlug(r.mode) === runSlug(b.mode));
		if (a === undefined) return [];
		return [{ slug: runSlug(b.mode), before: b, after: a, startYear: Math.max(b.startYear, a.startYear), endYear: Math.min(b.endYear, a.endYear) }];
	});
}

export interface OutletRow {
	readonly slug: string;
	readonly label: string;
	readonly period: string;
	readonly before: number | null;
	readonly after: number | null;
	readonly change: number | null;
	readonly changePct: number | null;
}

export function outletRows(pairs: readonly OutletPair[], route: number): OutletRow[] {
	return pairs.map((pair) => {
		const b = pair.before.routeFlows[route];
		const a = pair.after.routeFlows[route];
		const before = b ? meanAnnual(b, pair.startYear, pair.endYear) : null;
		const after = a ? meanAnnual(a, pair.startYear, pair.endYear) : null;
		const change = before !== null && after !== null ? after - before : null;
		return {
			slug: pair.slug,
			label: runLabel(pair.before.mode),
			period: `${hydroYearLabel(pair.startYear)} to ${hydroYearLabel(pair.endYear)}`,
			before,
			after,
			change,
			changePct: change !== null && before !== null && before !== 0 ? (100 * change) / before : null
		};
	});
}

/** The two mean monthly curves as a results chart (October first), with its data table. */
export function outletChart(pair: OutletPair, route: number): ChartSpec {
	const side = (run: RunResult) => {
		const series = run.routeFlows[route];
		return series ? meanMonthly(series, pair.startYear, pair.endYear) : new Array<null>(12).fill(null);
	};
	return {
		id: 'mean-monthly',
		title: `Mean monthly flow at route ${route}, ${runLabel(pair.before.mode)}`,
		xLabel: 'Month (hydrological year, October first)',
		yLabel: `Mean flow (${FLOW_UNIT})`,
		xKind: 'monthOfYear',
		x: HYDRO_MONTHS.map((_, k) => k),
		lines: [
			{ label: 'Before the split', values: side(pair.before), style: 0 },
			{ label: 'After the split', values: side(pair.after), style: 1 }
		],
		bars: true,
		yLog: false,
		spanGaps: false
	};
}
