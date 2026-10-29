import { describe, expect, it } from 'vitest';
import type { AnswerFile, Monthly12, MonthlySeries } from '../types.js';
import { answerToSeries, compareAnswers, compareSeries } from './compare.js';
import { MAR_PCT_DIFF_MAX, NSE_MIN, meetsThresholds } from './expectations.js';

const series = (startYear: number, values: number[]): MonthlySeries => ({ startYear, values, unit: 'Mm3PerMonth' });
const year = (v: number): number[] => Array<number>(12).fill(v);

describe('compareSeries', () => {
	it('gives MAR, NSE and differences for a hand-computed case', () => {
		// Reference: one year of 1, then one year of 3 (mean 2, Σ(r − r̄)² = 24).
		// Simulated: same, except Oct of year 1 is 1.5 and Nov of year 2 is 2.
		const ref = series(2000, [...year(1), ...year(3)]);
		const simValues = [...year(1), ...year(3)];
		simValues[0] = 1.5;
		simValues[13] = 2;
		const c = compareSeries(series(2000, simValues), ref)!;
		expect(c.overlap).toEqual({ startYear: 2000, endYear: 2001 });
		// Annual totals: ref 12 and 36 → MAR 24; sim 12.5 and 35 → MAR 23.75.
		expect(c.marReference).toBe(24);
		expect(c.marSimulated).toBe(23.75);
		expect(c.marPctDiff).toBeCloseTo(-1.041_666_667, 9);
		// SSE = 0.25 + 1 = 1.25; NSE = 1 − 1.25 / 24.
		expect(c.nse).toBeCloseTo(1 - 1.25 / 24, 12);
		expect(c.maxAbsDiff).toBe(1);
		expect(c.maxAbsDiffAt).toEqual({ year: 2001, month: 1 });
		expect(c.firstDivergingMonth).toEqual({ year: 2000, month: 0 });
	});

	it('compares only whole years both series cover', () => {
		const sim = series(1999, [...year(9), ...year(2), ...year(2)]); // 1999–2001
		const ref = series(2000, [...year(2), ...year(2), ...year(9)]); // 2000–2002
		const c = compareSeries(sim, ref)!;
		expect(c.overlap).toEqual({ startYear: 2000, endYear: 2001 });
		expect(c.marSimulated).toBe(24);
		expect(c.marPctDiff).toBe(0);
		expect(c.maxAbsDiff).toBe(0);
		expect(c.firstDivergingMonth).toBeNull();
	});

	it('ignores a trailing partial year', () => {
		const c = compareSeries(series(2000, [...year(1), 5, 5]), series(2000, year(1)))!;
		expect(c.overlap).toEqual({ startYear: 2000, endYear: 2000 });
	});

	it('returns null when no year is common', () => {
		expect(compareSeries(series(2000, year(1)), series(2001, year(1)))).toBeNull();
	});

	it('reports NSE as null for a zero-variance reference', () => {
		const c = compareSeries(series(2000, year(2.5)), series(2000, year(2)))!;
		expect(c.nse).toBeNull();
		expect(c.marPctDiff).toBe(25);
	});

	it('handles a dry reference: 0 % when both are dry, null when only the reference is', () => {
		expect(compareSeries(series(2000, year(0)), series(2000, year(0)))!.marPctDiff).toBe(0);
		expect(compareSeries(series(2000, year(0.1)), series(2000, year(0)))!.marPctDiff).toBeNull();
	});

	it('does not count a difference of exactly the tolerance as divergence', () => {
		const c = compareSeries(series(2000, year(0.33)), series(2000, year(0.32)))!;
		expect(c.firstDivergingMonth).toBeNull();
		expect(compareSeries(series(2000, year(0.33)), series(2000, year(0.32)), { tolerance: 0.001 })!.firstDivergingMonth).toEqual({
			year: 2000,
			month: 0
		});
	});

	it('treats Mm3 and Mm3PerMonth as the same unit but rejects others', () => {
		expect(compareSeries({ ...series(2000, year(1)), unit: 'Mm3' }, series(2000, year(1)))).not.toBeNull();
		expect(() => compareSeries({ ...series(2000, year(1)), unit: 'mm' }, series(2000, year(1)))).toThrow(/cannot compare/);
	});
});

describe('compareAnswers', () => {
	const answer = (startYear: number, values: number[][]): AnswerFile => {
		const rows = values.map((v, i) => {
			const total = v.reduce((a, b) => a + b, 0);
			return { year: startYear + i, months: v as unknown as Monthly12, annualTotal: total, monthlyMean: total / 12 };
		});
		return { kind: 'RQ', number: 7, rows, average: { months: year(0) as unknown as Monthly12, annualTotal: 0, monthlyMean: 0 } };
	};

	it('compares the monthly values, not the annual columns', () => {
		const sim = answer(2000, [year(1), year(3)]);
		const ref = answer(2000, [year(1), year(3)]);
		const c = compareAnswers(sim, ref)!;
		expect(c.nse).toBe(1);
		expect(c.marReference).toBe(24);
	});

	it('rejects an answer file with a gap in its years', () => {
		const gappy: AnswerFile = { ...answer(2000, [year(1), year(1)]) };
		const rows = [gappy.rows[0]!, { ...gappy.rows[1]!, year: 2002 }];
		expect(() => answerToSeries({ ...gappy, rows })).toThrow('RQ7: year 2002 follows 2000');
	});
});

describe('meetsThresholds', () => {
	const base = compareSeries(series(2000, year(1)), series(2000, [...year(1).slice(0, 11), 2]))!;

	it('uses the issue #3 thresholds', () => {
		expect(MAR_PCT_DIFF_MAX).toBe(1);
		expect(NSE_MIN).toBe(0.99);
	});

	it('passes within both thresholds and fails outside either', () => {
		expect(meetsThresholds({ ...base, marPctDiff: -1, nse: 0.99 })).toBe(true);
		expect(meetsThresholds({ ...base, marPctDiff: 1.01, nse: 1 })).toBe(false);
		expect(meetsThresholds({ ...base, marPctDiff: 0, nse: 0.989 })).toBe(false);
		expect(meetsThresholds(null)).toBe(false);
		expect(meetsThresholds({ ...base, marPctDiff: null, nse: 1 })).toBe(false);
	});

	it('accepts an undefined NSE only when no month diverges', () => {
		const dry = compareSeries(series(2000, year(0)), series(2000, year(0)))!;
		expect(meetsThresholds(dry)).toBe(true);
		expect(meetsThresholds({ ...dry, firstDivergingMonth: { year: 2000, month: 3 } })).toBe(false);
	});
});
