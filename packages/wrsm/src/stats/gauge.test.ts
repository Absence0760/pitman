import { describe, expect, it } from 'vitest';
import type { Monthly12, MonthlySeries, ObservedFlow, ObservedRow, Twelve } from '../types.js';
import { WR2012_FIT_GUIDELINES, gaugeStatistics, observedOnSeries, pairAtGauge, percentError } from './gauge.js';

const flags = (on: readonly number[] = []) => Array.from({ length: 12 }, (_, k) => on.includes(k)) as unknown as Twelve<boolean>;
const obsRow = (year: number, months: readonly number[], incomplete: readonly number[] = []): ObservedRow => ({
	year,
	months: months as unknown as Monthly12,
	incomplete: flags(incomplete),
	annualTotal: null,
	annualIncomplete: false
});
const months = (base: number) => Array.from({ length: 12 }, (_, k) => base + k);

// Simulated 1990–1992; observed has a year before the simulation, a complete
// year, a year with one missing month and a year with one incomplete month.
const simulated: MonthlySeries = { startYear: 1990, values: [...months(1), ...months(2), ...months(3)], unit: 'Mm3PerMonth' };
const missingYear = months(20);
missingYear[3] = -99.999;
const observed: ObservedFlow = {
	rows: [obsRow(1989, months(9)), obsRow(1990, months(10)), obsRow(1991, missingYear), obsRow(1992, months(30), [5])]
};

describe('pairAtGauge', () => {
	it('pairs usable months and keeps incomplete ones by default', () => {
		const p = pairAtGauge(simulated, observed);
		expect(p.period).toEqual({ startYear: 1990, endYear: 1992 });
		expect(p.months).toHaveLength(35);
		expect(p.completeYears).toEqual([1990, 1992]);
		expect(p.dropped).toEqual({ missing: 1, incomplete: 0, outside: 12 });
		expect(p.months.find((m) => m.year === 1992 && m.month === 5)).toEqual({
			year: 1992,
			month: 5,
			simulated: 8,
			observed: 35,
			incomplete: true
		});
		expect(p.simulatedYears.map((r) => r.months[0])).toEqual([1, 3]);
		expect(p.observedYears.map((r) => r.months[0])).toEqual([10, 30]);
	});

	it('drops incomplete months, and their years from the annual statistics, when asked', () => {
		const p = pairAtGauge(simulated, observed, { includeIncomplete: false });
		expect(p.completeYears).toEqual([1990]);
		expect(p.dropped.incomplete).toBe(1);
		expect(p.months).toHaveLength(34);
	});

	it('limits the comparison to a period', () => {
		const p = pairAtGauge(simulated, observed, { startYear: 1991, endYear: 1991 });
		expect(p.period).toEqual({ startYear: 1991, endYear: 1991 });
		expect(p.completeYears).toEqual([]);
		expect(p.dropped.outside).toBe(36);
	});

	it('has no period when the gauge record misses the simulation', () => {
		const p = pairAtGauge(simulated, { rows: [obsRow(2000, months(1))] });
		expect(p.period).toBeNull();
		expect(p.months).toEqual([]);
	});
});

describe('observedOnSeries', () => {
	it('lays the observed months on the route series with nulls for gaps and missing values', () => {
		const o = observedOnSeries(observed, 1990, 3);
		expect(o.values).toHaveLength(36);
		expect(o.values[0]).toBe(10);
		expect(o.values[12 + 3]).toBeNull();
		expect(o.incomplete[24 + 5]).toBe(true);
		expect(observedOnSeries({ rows: [] }, 1990, 1).values).toEqual(new Array(12).fill(null));
	});
});

describe('gaugeStatistics', () => {
	it('compares simulated with observed over the same complete years, against the TT 689 p.177 guidelines', () => {
		// Simulated is observed × 1.1: MAR and SD 10 % high, log SD and seasonal index unchanged.
		const obs: ObservedFlow = { rows: [obsRow(2000, months(1)), obsRow(2001, months(5)), obsRow(2002, months(2))] };
		const sim: MonthlySeries = {
			startYear: 2000,
			values: obs.rows.flatMap((r) => r.months.map((v) => v * 1.1)),
			unit: 'Mm3PerMonth'
		};
		const g = gaugeStatistics(sim, obs);
		const by = Object.fromEntries(g.comparison.map((c) => [c.statistic, c]));
		expect(g.comparison.map((c) => c.statistic)).toEqual(['marMm3', 'meanLog', 'sdMm3', 'logSd', 'seasonalIndex']);
		expect(by.marMm3?.errorPercent).toBeCloseTo(10, 9);
		expect(by.marMm3?.withinGuideline).toBe(false);
		expect(by.sdMm3?.errorPercent).toBeCloseTo(10, 9);
		expect(by.logSd?.errorPercent).toBeCloseTo(0, 9);
		expect(by.logSd?.withinGuideline).toBe(true);
		expect(by.seasonalIndex?.errorPercent).toBeCloseTo(0, 9);
		expect(by.seasonalIndex?.guidelinePercent).toBe(8);
		expect(g.simulated?.years).toBe(3);
		expect(g.observed?.marMm3).toBeCloseTo(obs.rows.reduce((a, r) => a + r.months.reduce((b, v) => b + v, 0), 0) / 3, 9);
	});

	it('has no statistics when no year is complete', () => {
		const g = gaugeStatistics(simulated, observed, { startYear: 1991, endYear: 1991 });
		expect(g.simulated).toBeNull();
		expect(g.observed).toBeNull();
		expect(g.comparison.every((c) => c.errorPercent === null && c.withinGuideline === null)).toBe(true);
	});
});

describe('percentError and the guidelines', () => {
	it('is relative to |observed| and undefined for a zero observed value', () => {
		expect(percentError(11, 10)).toBeCloseTo(10, 12);
		expect(percentError(-1.1, -1)).toBeCloseTo(-10, 12);
		expect(percentError(1, 0)).toBeNull();
		expect(percentError(null, 1)).toBeNull();
	});

	it('are TT 689 p.177: 4 % MAR and mean (log), 6 % SDs, 8 % seasonal index', () => {
		expect(WR2012_FIT_GUIDELINES).toEqual({ marMm3: 4, meanLog: 4, sdMm3: 6, logSd: 6, seasonalIndex: 8 });
	});
});
