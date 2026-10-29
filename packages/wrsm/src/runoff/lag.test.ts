import { describe, expect, it } from 'vitest';
import { MuskingumRouter, muskingumCoefficients, routeSeries } from './lag.js';

/** Seeded uniform [0, 1) generator (mulberry32). */
function random(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

describe('Muskingum, x = 0 (TT 690 eqs. 1.14–1.16)', () => {
	it('eqs. 1.15–1.16: coefficients for GL = 2.5 and TL = 0.25 (spec §2.6)', () => {
		expect(muskingumCoefficients(2.5, 1).C1).toBeCloseTo(1 / 3, 15);
		expect(muskingumCoefficients(2.5, 1).C2).toBeCloseTo(1 / 6, 15);
		expect(muskingumCoefficients(0.25, 1).C1).toBeCloseTo(4 / 3, 15);
		expect(muskingumCoefficients(0.25, 1).C2).toBeCloseTo(2 / 3, 15);
	});

	it('eq. 1.14 with + C2 (OQ-21): a rise from a dry start is positive', () => {
		expect(routeSeries([3], { k: 2.5, dt: 1 })[0]).toBeCloseTo(0.5, 15);
	});

	it('spec §4.7: k = 0.25 goes negative after a wet month (OQ-22, literal form)', () => {
		const out = routeSeries([0, 10, 0, 0], { k: 0.25, dt: 1 });
		const expected = [0, 6.6666666667, 4.4444444444, -1.4814814815];
		out.forEach((o, i) => expect(o).toBeCloseTo(expected[i]!, 10));
	});

	it('k = 0 passes the inflow through (OQ-22 (d))', () => {
		const inflow = [0, 5, 1, 0, 7.25];
		expect(routeSeries(inflow, { k: 0, dt: 1 })).toEqual(inflow);
		expect(routeSeries(inflow, { k: 0, dt: 1, initial: { inflow: 3, outflow: 9 } })).toEqual(inflow);
	});

	it('a constant inflow from a steady state stays steady', () => {
		expect(routeSeries([4, 4, 4], { k: 2.5, dt: 1, initial: { inflow: 4, outflow: 4 } })).toEqual([4, 4, 4]);
	});

	it('keeps and resets state', () => {
		const r = new MuskingumRouter({ k: 1, dt: 1 });
		r.step(6);
		expect(r.state).toEqual({ inflow: 6, outflow: 6 * (0.5 / 1.5) });
		r.reset({ inflow: 1, outflow: 2 });
		expect(r.state).toEqual({ inflow: 1, outflow: 2 });
	});

	it('rejects k < 0 and dt ≤ 0', () => {
		expect(() => new MuskingumRouter({ k: -1, dt: 1 })).toThrow(RangeError);
		expect(() => new MuskingumRouter({ k: 1, dt: 0 })).toThrow(RangeError);
	});

	it('conserves the trapezoidal volume exactly, and the whole volume once drained', () => {
		const rnd = random(7);
		for (const [k, dt] of [[2.5, 1], [0.25, 1], [0.6, 0.25], [0, 1], [5, 0.25]] as const) {
			const inflow = Array.from({ length: 600 }, () => (rnd() < 0.3 ? 0 : 50 * rnd() ** 3));
			const out = routeSeries(inflow, { k, dt });
			const N = inflow.length - 1;
			const identity = sum(inflow) - inflow[N]! / 2 + out[N]! / 2 - (k / dt) * out[N]!;
			expect(sum(out)).toBeCloseTo(identity, 8);

			const drained = routeSeries([...inflow, ...new Array<number>(4000).fill(0)], { k, dt });
			expect(sum(drained)).toBeCloseTo(sum(inflow), 7);
		}
	});

	it('rounds the stored outflow when asked (OQ-25)', () => {
		const out = routeSeries([1, 2, 3], { k: 2.5, dt: 1, round: Math.fround });
		for (const o of out) expect(Math.fround(o)).toBe(o);
	});
});
