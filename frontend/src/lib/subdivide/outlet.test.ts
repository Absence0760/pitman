import type { MonthlySeries, RunMode, RunResult } from '@pitman/wrsm';
import { describe, expect, it } from 'vitest';
import { workedBundle } from './fixtures.test-helper.js';
import { meanAnnual, meanMonthly, outletChart, outletPairs, outletRoute, outletRows, routeChoices } from './outlet.js';

const flow = (startYear: number, values: readonly number[]): MonthlySeries => ({ startYear, values, unit: 'Mm3PerMonth' });
const year = (v: number) => new Array<number>(12).fill(v);
const run = (mode: RunMode, startYear: number, endYear: number, routeFlows: RunResult['routeFlows']): RunResult => ({ mode, startYear, endYear, routeFlows, reservoirStorage: {}, messages: [] });
const NATURAL: RunMode = { kind: 'natural' };
const PRESENT: RunMode = { kind: 'presentDay', year: 2025 };

describe('outletRoute', () => {
	it('is the route leaving the first module all of the module’s water reaches, past the join', () => {
		expect(outletRoute(workedBundle(), { type: 'RU', number: 3 })).toBe(13);
	});

	it('follows a single outflow past its head too: a new piece joins there', () => {
		const bundle = workedBundle();
		const network = { ...bundle.network, routes: bundle.network.routes.filter((r) => r.number !== 10) };
		expect(outletRoute({ ...bundle, network }, { type: 'RU', number: 3 })).toBe(13);
	});

	it('falls back to the module’s own route when its water leaves the network, or the routes never meet', () => {
		const bundle = workedBundle();
		const toEnd = { ...bundle.network, routes: [{ number: 20, upstreamPosition: 1, downstreamPosition: 0, cost: 0 }] };
		expect(outletRoute({ ...bundle, network: toEnd }, { type: 'RU', number: 3 })).toBe(20);
		const apart = {
			...bundle.network,
			routes: [
				{ number: 21, upstreamPosition: 1, downstreamPosition: 2, cost: 0 },
				{ number: 22, upstreamPosition: 1, downstreamPosition: 3, cost: 0 }
			]
		};
		expect(outletRoute({ ...bundle, network: apart }, { type: 'RU', number: 3 })).toBe(21);
	});

	it('has none for a module without routes or not in the network', () => {
		expect(outletRoute(workedBundle(), { type: 'RU', number: 8 })).toBeUndefined();
		expect(outletRoute(workedBundle(), { type: 'RU', number: 99 })).toBeUndefined();
	});
});

describe('routeChoices', () => {
	it('names each route by its ends', () => {
		const choices = routeChoices(workedBundle());
		expect(choices[0]).toEqual({ route: 10, label: 'Route 10: RU 3 Z01A upper to RV 2' });
		expect(choices[3]?.label).toContain('to outside the network');
	});
});

describe('the means', () => {
	const series = flow(2000, [...year(1), ...year(2), ...year(3)]);

	it('sums each hydrological year, then averages', () => {
		expect(meanAnnual(series, 2000, 2002)).toBe(24);
		expect(meanAnnual(series, 2001, 2001)).toBe(24);
		expect(meanAnnual(series, 2001, 2002)).toBe(30);
	});

	it('won’t compare years the series doesn’t hold', () => {
		expect(meanAnnual(series, 1999, 2001)).toBeNull();
		expect(meanAnnual(series, 2001, 2003)).toBeNull();
		expect(meanAnnual(series, 2002, 2001)).toBeNull();
	});

	it('keeps the months in hydrological order, October first', () => {
		const months = Array.from({ length: 24 }, (_, i) => i % 12);
		expect(meanMonthly(flow(2000, months), 2000, 2001)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
		expect(meanMonthly(series, 1990, 1991)).toEqual(new Array(12).fill(null));
	});
});

describe('before and after', () => {
	const before = [run(NATURAL, 2000, 2002, { 13: flow(2000, [...year(1), ...year(1), ...year(1)]) }), run(PRESENT, 2000, 2002, { 13: flow(2000, [...year(1), ...year(1), ...year(1)]) })];
	const after = [run(NATURAL, 2001, 2003, { 13: flow(2001, [...year(1.5), ...year(1.5), ...year(1.5)]) })];

	it('compares only the modes in both, over the years both ran', () => {
		const pairs = outletPairs(before, after);
		expect(pairs.map((p) => [p.slug, p.startYear, p.endYear])).toEqual([['natural', 2001, 2002]]);
		expect(outletRows(pairs, 13)).toEqual([{ slug: 'natural', label: 'Natural', period: '2001/02 to 2002/03', before: 12, after: 18, change: 6, changePct: 50 }]);
	});

	it('shows a gap, not a zero, for a route one side doesn’t have', () => {
		const [row] = outletRows(outletPairs(before, after), 99);
		expect(row).toMatchObject({ before: null, after: null, change: null, changePct: null });
	});

	it('has no percentage from a dry route', () => {
		const dry = [run(NATURAL, 2000, 2000, { 13: flow(2000, year(0)) })];
		const wet = [run(NATURAL, 2000, 2000, { 13: flow(2000, year(1)) })];
		expect(outletRows(outletPairs(dry, wet), 13)[0]).toMatchObject({ change: 12, changePct: null });
	});

	it('draws the two as a results chart, October first', () => {
		const [pair] = outletPairs(before, after);
		const spec = outletChart(pair as NonNullable<typeof pair>, 13);
		expect(spec.id).toBe('mean-monthly');
		expect(spec.xLabel).toContain('October first');
		expect(spec.lines.map((l) => l.label)).toEqual(['Before the split', 'After the split']);
		expect(spec.lines[0]?.values[0]).toBe(1);
		expect(spec.lines[1]?.values[0]).toBe(1.5);
		expect(outletChart(pair as NonNullable<typeof pair>, 99).lines[0]?.values[0]).toBeNull();
	});
});
