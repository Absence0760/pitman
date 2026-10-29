import { describe, expect, it } from 'vitest';
import { interceptionConstants, monthlyInterception, rainfallDeviation, sCurve, sCurveExponent, sCurveFractions } from './rain.js';

// Reference values: docs/theory/pitman.md §2.1, §2.3, §4.3, §4.4, §4.6 (10 decimals).

describe('mass curve (TT 690 eqs. 1.1–1.3)', () => {
	it('eq. 1.1 W and eq. 1.3 n match the spec values', () => {
		expect(rainfallDeviation(90)).toBeCloseTo(48.9624353694, 10);
		expect(sCurveExponent(90)).toBeCloseTo(3.8691217634, 10);
		expect(rainfallDeviation(30)).toBeCloseTo(19.7512119773, 10);
		expect(sCurveExponent(30)).toBeCloseTo(5.8264311144, 10);
		expect(rainfallDeviation(240)).toBeCloseTo(108.7162426234, 10);
		expect(sCurveExponent(240)).toBeCloseTo(2.9809407555, 10);
		expect(sCurveExponent(1)).toBeCloseTo(66.25, 2);
		expect(sCurveExponent(400)).toBeCloseTo(2.68, 2);
	});

	it('W(0) is about zero and W/P stays below 1.02, so n is finite', () => {
		expect(Math.abs(rainfallDeviation(0))).toBeLessThan(2e-6);
		for (const P of [1e-3, 0.1, 1, 10, 100, 1000, 5000]) {
			expect(rainfallDeviation(P) / P).toBeLessThan(1.02);
			expect(Number.isFinite(sCurveExponent(P))).toBe(true);
		}
	});

	it('eq. 1.2 is symmetric, uniform at n = 1, and runs 0 to 1', () => {
		for (const n of [1, 2.5, 7, 60]) {
			expect(sCurve(0.5, n)).toBeCloseTo(0.5, 15);
			expect(sCurve(0, n)).toBe(0);
			expect(sCurve(1, n)).toBe(1);
			expect(sCurve(0.25, n) + sCurve(0.75, n)).toBeCloseTo(1, 14);
		}
		expect(sCurve(0.3, 1)).toBeCloseTo(0.3, 15);
	});

	it('OQ-1 (a): cumulative fractions reproduce the spec y values and sum to 1', () => {
		const f = sCurveFractions(90);
		expect(f[0]).toBeCloseTo(0.0140544132, 10);
		expect(f[0]! + f[1]!).toBeCloseTo(0.5, 15);
		expect(f[0]! + f[1]! + f[2]!).toBeCloseTo(0.9859455868, 10);
		expect(f.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 15);
		expect(sCurveFractions(30)[0]).toBeCloseTo(0.0016571643, 10);
		expect(sCurveFractions(240)[0]).toBeCloseTo(0.0364424418, 10);
	});

	it('OQ-1 (b): mid-point density fractions are symmetric and sum to 1', () => {
		const f = sCurveFractions(90, 4, 'midpointDensity');
		expect(f.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 15);
		expect(f[0]).toBeCloseTo(f[3]!, 14);
		expect(f[1]).toBeCloseTo(f[2]!, 14);
		expect(f[0]).toBeLessThan(f[1]!);
	});

	it('OQ-2: no rain gives all-zero fractions', () => {
		expect(sCurveFractions(0)).toEqual([0, 0, 0, 0]);
	});
});

describe('interception (TT 690 eqs. 1.5–1.7)', () => {
	it('matches the spec constants and worked-example totals', () => {
		const { a, b } = interceptionConstants(1.5);
		expect(a).toBeCloseTo(20.76594882, 8);
		expect(b).toBeCloseTo(-0.009658151, 9);
		expect(monthlyInterception(90, 1.5)).toBeCloseTo(12.0593521432, 10);
		expect(monthlyInterception(30, 1.5)).toBeCloseTo(5.2235757804, 10);
		expect(monthlyInterception(240, 1.5)).toBeCloseTo(18.7210295266, 10);
	});

	it('agrees with TT 690 Fig. 1.3 (PI = 4: a ≈ 63.6, I(100) ≈ 36)', () => {
		expect(interceptionConstants(4).a).toBeCloseTo(63.5, 0); // 63.53; the spec rounds it to 63.6
		expect(monthlyInterception(100, 4)).toBeCloseTo(35.5, 0); // 35.55; the figure reads about 36
	});

	it('is zero without rain and below the rain for PI ≤ 10', () => {
		expect(monthlyInterception(0, 1.5)).toBe(0);
		expect(monthlyInterception(0, 0)).toBe(0);
		expect(monthlyInterception(50, 0)).toBe(0);
		for (const P of [0.1, 1, 10, 100]) expect(monthlyInterception(P, 10)).toBeLessThan(P);
	});
});
