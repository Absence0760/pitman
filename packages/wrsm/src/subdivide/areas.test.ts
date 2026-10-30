import { describe, expect, it } from 'vitest';

import { fileRound, largestRemainder, scalePieceAreas } from './areas.js';

const units = (values: readonly number[], decimals: number) => values.reduce((s, v) => s + Math.round(v * 10 ** decimals), 0);

describe('largestRemainder', () => {
	it('adds back to the total in whole file units', () => {
		for (const [total, shares] of [
			[100, [1, 1, 1]],
			[0.7, [0.3, 0.3, 0.4]],
			[12.3, [5, 7, 11, 13, 17]],
			[5.01, [0.3, 0.7]]
		] as const) {
			expect(units(largestRemainder(total, shares, 1), 1)).toBe(Math.round(total * 10));
		}
	});

	it('gives the units left to the largest remainders, ties to the larger share, then the earlier part', () => {
		expect(largestRemainder(1, [2, 1], 0)).toEqual([1, 0]);
		expect(largestRemainder(1, [1, 1], 0)).toEqual([1, 0]);
		expect(largestRemainder(10, [1, 1, 1], 0)).toEqual([4, 3, 3]);
	});

	it('gives nothing to a zero share', () => {
		expect(largestRemainder(5, [0, 1], 1)).toEqual([0, 5]);
	});

	it('keeps a negative total negative and refuses shares that mean nothing', () => {
		expect(largestRemainder(-3, [1, 2], 0)).toEqual([-1, -2]);
		expect(() => largestRemainder(1, [0, 0], 1)).toThrow(/shares/);
		expect(() => largestRemainder(1, [-1, 2], 1)).toThrow(/shares/);
	});
});

describe('fileRound', () => {
	it('rounds the float32 value, as the writers do (docs/formats.md §2)', () => {
		expect(fileRound(120.3, 1)).toBe(120.3);
		expect(fileRound(0.00054772256, 8)).toBe(0.00054772);
	});
});

describe('scalePieceAreas', () => {
	it('gives the worked example: 400 km² over polygons of 121.1 and 282.6', () => {
		const { areasKm2, scale, warning } = scalePieceAreas(400, [121.1, 282.6]);
		expect(areasKm2).toEqual([120, 280]);
		expect(scale).toBeCloseTo(0.991, 3);
		expect(warning).toBeNull();
	});

	it('warns outside [0.95, 1.05] with the spec sentence', () => {
		expect(scalePieceAreas(400, [200, 230]).warning).toBe("the network's area for this module differs from its boundary by 7 %: check you picked the right quaternary");
		expect(scalePieceAreas(400, [200, 180]).warning).toMatch(/by 5 %/);
	});

	it('sums to the module exactly, for eight pieces of awkward size (invariant 1)', () => {
		const { areasKm2 } = scalePieceAreas(1234.5, [1.3, 77.7, 300.01, 2, 2, 411.9, 19.05, 500]);
		expect(units(areasKm2, 1)).toBe(12345);
		expect(areasKm2.every((a) => Math.abs(a * 10 - Math.round(a * 10)) < 1e-9)).toBe(true);
	});
});
