import { describe, expect, it } from 'vitest';
import { planDemand, syntheticBundle, type DemandSpec, type DemandYearCheck, type Monthly12 } from '@pitman/wrsm';
import { emptyFileProblem, flatFrom, planChanges, roundingWarning, targetFrom, worstRounding } from './preview.js';

// The engine's synthetic network, invented values only (issue #3 rule 2).

const spec: DemandSpec = {
	annualVolumeMm3: 1.2,
	monthlyDistributionPercent: Array<number>(12).fill(100 / 12) as unknown as Monthly12,
	growth: [
		{ year: 1985, value: 1.2 },
		{ year: 2025, value: 2.4 }
	]
};
const source = { kind: 'manual', date: '2025-01-02' } as const;
const sources = { annualVolume: source, monthlyDistribution: source, growth: {} };
const bundle = syntheticBundle({ startYear: 1985, years: 10 });
const year = (y: number, askedMm3: number, writtenMm3: number): DemandYearCheck => ({ year: y, askedMm3, writtenMm3, differencePercent: askedMm3 === 0 ? 0 : ((writtenMm3 - askedMm3) / askedMm3) * 100 });

describe('planChanges', () => {
	it('lists each file a new demand on a new route touches', () => {
		const plan = planDemand(bundle, { spec, sources, target: { kind: 'newRoute', module: { type: 'RV', number: 5 } } });
		expect(planChanges(plan, bundle.network)).toEqual([
			'Writes SYRQ10.abs: 41 rows, 1985/86 to 2025/26, in million m³ a month.',
			'SYRV5.DAT: route 10 of RV 5 names SYRQ10.abs.',
			'SY.NET: adds route 10, from RV 5 to the zero sink.',
			'pitman.json: records the annual volume, the shares, the growth years and the source of each.'
		]);
	});

	it('says a rewrite stays where it is', () => {
		const plan = planDemand(bundle, { spec, sources, file: 'SYRQ9.ABS' });
		expect(planChanges(plan, bundle.network)).toEqual([
			'Rewrites SYRQ9.ABS: 41 rows, 1985/86 to 2025/26, in million m³ a month.',
			'pitman.json: records the annual volume, the shares, the growth years and the source of each.'
		]);
	});

	it('says what a move leaves behind', () => {
		const plan = planDemand(bundle, { spec, sources, file: 'SYRQ9.ABS', target: { kind: 'newRoute', module: { type: 'RV', number: 5 } } });
		const lines = planChanges(plan, bundle.network);
		expect(lines[1]).toBe('It takes the new route’s name; SYRQ9.ABS goes.');
		expect(lines[2]).toBe('Route 9 of CR 4 no longer reads a file.');
	});
});

describe('roundingWarning', () => {
	it('is quiet under the 0.5 % of formats § 12', () => {
		expect(roundingWarning([year(2000, 100, 100.4)])).toBeNull();
		expect(roundingWarning([])).toBeNull();
	});

	it('says how far and where, and what a demand file can hold', () => {
		const text = roundingWarning([year(2000, 12, 12), year(2001, 0.3, 0.36), year(2002, 0.4, 0.36)]);
		expect(text).toContain('Rounding moves 2 years by more than 0.5 %, 20.00 % at worst (2001/02: asked 0.300, the file holds 0.36 million m³).');
		expect(text).toContain('0.001 million m³ a month, which is 1,000 m³, so a very small demand moves in steps');
	});
});

describe('worstRounding', () => {
	it('compares sizes, not signs', () => {
		expect(worstRounding([year(2000, 1, 1.1), year(2001, 1, 0.8)])?.year).toBe(2001);
		expect(worstRounding([])).toBeNull();
	});
});

describe('emptyFileProblem', () => {
	it('refuses a demand that rounds away', () => {
		expect(emptyFileProblem([year(2000, 0.04, 0)])).toMatch(/Every month rounds to 0\.00/);
	});

	it('allows years of zero beside real ones', () => {
		expect(emptyFileProblem([year(2000, 0, 0), year(2001, 1, 1)])).toBeNull();
	});
});

describe('flatFrom', () => {
	it('is the last year the table gives', () => {
		expect(flatFrom(planDemand(bundle, { spec, sources, file: 'SYRQ9.ABS' }))).toBe(2025);
	});
});

describe('targetFrom', () => {
	it('reads the form’s choices', () => {
		expect(targetFrom('RV5', 'new')).toEqual({ kind: 'newRoute', module: { type: 'RV', number: 5 } });
		expect(targetFrom('CR12', '9')).toEqual({ kind: 'route', module: { type: 'CR', number: 12 }, route: 9 });
	});

	it('has nothing to say until both are chosen', () => {
		expect(targetFrom('', 'new')).toBeUndefined();
		expect(targetFrom('RV5', '')).toBeUndefined();
	});
});
