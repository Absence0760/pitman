import { describe, expect, it } from 'vitest';
import type { Monthly12, MonthlyRow } from '../types.js';
import { annualTotals, flowDuration, flowStatistics, meanMonthly, rowsInPeriod, seasonalIndex, seriesRows } from './flow.js';

const twelve = (v: number) => new Array<number>(12).fill(v) as unknown as Monthly12;
const oneMonth = (k: number, v: number) => twelve(0).map((_, i) => (i === k ? v : 0)) as unknown as Monthly12;

// Three years of uniform monthly flow: annual totals 12, 24 and 36 million m³.
const rows: MonthlyRow[] = [
	{ year: 1990, months: twelve(1) },
	{ year: 1991, months: twelve(2) },
	{ year: 1992, months: twelve(3) }
];

describe('seriesRows', () => {
	it('splits a series into hydrological years, October first', () => {
		const series = { startYear: 2000, values: [...Array(24).keys()], unit: 'Mm3PerMonth' as const };
		const r = seriesRows(series);
		expect(r.map((x) => x.year)).toEqual([2000, 2001]);
		expect(r[1]?.months[0]).toBe(12);
	});

	it('rejects a series that is not whole years', () => {
		expect(() => seriesRows({ startYear: 2000, values: [1, 2], unit: 'Mm3' })).toThrow(RangeError);
	});

	it('limits rows to a period', () => {
		expect(rowsInPeriod(rows, 1991).map((r) => r.year)).toEqual([1991, 1992]);
		expect(rowsInPeriod(rows, undefined, 1990).map((r) => r.year)).toEqual([1990]);
	});
});

describe('annual totals and mean monthly flows', () => {
	it('sums the twelve months of each hydrological year', () => {
		expect(annualTotals(rows)).toEqual([
			{ year: 1990, value: 12 },
			{ year: 1991, value: 24 },
			{ year: 1992, value: 36 }
		]);
	});

	it('averages each month over the years', () => {
		expect(meanMonthly(rows)).toEqual(twelve(2));
		expect(meanMonthly([])).toEqual(twelve(0));
	});
});

describe('seasonalIndex (TT 689 p.62)', () => {
	it('is 0 for flow spread evenly over the year', () => {
		expect(seasonalIndex(twelve(5))).toBeCloseTo(0, 12);
	});

	it('is 100 − 100/12 % MAR when all the flow comes in one month, whichever month', () => {
		for (const k of [0, 5, 11]) expect(seasonalIndex(oneMonth(k, 7))).toBeCloseTo(100 - 100 / 12, 10);
	});

	it('is 50 − 100/12 % MAR for two equal months half a year apart', () => {
		const q = twelve(0).map((_, i) => (i === 0 || i === 6 ? 1 : 0)) as unknown as Monthly12;
		expect(seasonalIndex(q)).toBeCloseTo(50 - 100 / 12, 10);
	});

	it('is null with no flow', () => {
		expect(seasonalIndex(twelve(0))).toBeNull();
	});
});

describe('flowStatistics (TT 689 pp.61–62)', () => {
	it('computes MAR, SD (n − 1), CV and the log statistics', () => {
		const s = flowStatistics(rows);
		expect(s).not.toBeNull();
		if (s === null) return;
		expect(s.years).toBe(3);
		expect([s.firstYear, s.lastYear]).toEqual([1990, 1992]);
		expect(s.marMm3).toBe(24);
		expect(s.sdMm3).toBeCloseTo(12, 12);
		expect(s.cv).toBeCloseTo(0.5, 12);
		const logs = [12, 24, 36].map(Math.log10);
		const meanLog = (logs[0]! + logs[1]! + logs[2]!) / 3;
		expect(s.meanLog).toBeCloseTo(meanLog, 12);
		const logSd = Math.sqrt(logs.reduce((a, y) => a + (y - meanLog) ** 2, 0) / 2);
		expect(s.logSd).toBeCloseTo(logSd, 12);
		expect(s.seasonalIndex).toBeCloseTo(0, 12);
		expect(s.yearsWithoutLog).toBe(0);
	});

	it('uses natural logarithms when asked', () => {
		expect(flowStatistics(rows, { logBase: 'e' })?.meanLog).toBeCloseTo((Math.log(12) + Math.log(24) + Math.log(36)) / 3, 12);
	});

	it('leaves years with no flow out of the log statistics only', () => {
		const s = flowStatistics([...rows, { year: 1993, months: twelve(0) }]);
		expect(s?.years).toBe(4);
		expect(s?.marMm3).toBe(18);
		expect(s?.yearsWithoutLog).toBe(1);
		expect(s?.meanLog).toBeCloseTo((Math.log10(12) + Math.log10(24) + Math.log10(36)) / 3, 12);
	});

	it('has no SD for a single year and nothing for no years', () => {
		const one = flowStatistics([rows[0]!]);
		expect(one?.sdMm3).toBeNull();
		expect(one?.logSd).toBeNull();
		expect(one?.cv).toBeNull();
		expect(flowStatistics([])).toBeNull();
	});

	it('has no CV or seasonal index when there is no flow', () => {
		const s = flowStatistics([{ year: 1, months: twelve(0) }, { year: 2, months: twelve(0) }]);
		expect(s?.cv).toBeNull();
		expect(s?.seasonalIndex).toBeNull();
		expect(s?.meanLog).toBeNull();
	});
});

describe('flowDuration', () => {
	it('ranks from largest down at the Weibull position i/(n + 1)', () => {
		expect(flowDuration([3, 1, 2])).toEqual([
			{ exceedancePercent: 25, value: 3 },
			{ exceedancePercent: 50, value: 2 },
			{ exceedancePercent: 75, value: 1 }
		]);
	});

	it('ignores non-finite values', () => {
		expect(flowDuration([Number.NaN, 4]).map((p) => p.value)).toEqual([4]);
		expect(flowDuration([])).toEqual([]);
	});
});
