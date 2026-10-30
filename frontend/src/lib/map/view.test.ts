import { describe, expect, it } from 'vitest';
import { boxHolds, mapGridViewBbox, snappedViewBbox } from './view.js';

describe('snappedViewBbox', () => {
	it('snaps outward, so a small pan asks the same box', () => {
		const a = snappedViewBbox([21.03, -33.97, 21.47, -33.53], 0.1, 2);
		const b = snappedViewBbox([21.04, -33.96, 21.48, -33.52], 0.1, 2);
		expect(a).toEqual([21, -34, 21.5, -33.5]);
		expect(b).toEqual(a);
	});
	it('has no box with no view, a non-finite one, or one past the limit', () => {
		expect(snappedViewBbox(null, 0.1, 2)).toBeNull();
		expect(snappedViewBbox([Number.NaN, 0, 1, 1], 0.1, 2)).toBeNull();
		expect(snappedViewBbox([20, -34, 22.5, -33], 0.1, 2)).toBeNull();
	});
});

describe('mapGridViewBbox', () => {
	it('keeps to what the server takes: 2° a side', () => {
		expect(mapGridViewBbox([21, -34, 22.95, -33])).toEqual([21, -34, 23, -33]);
		expect(mapGridViewBbox([21, -34, 23.05, -33])).toBeNull();
	});
});

describe('boxHolds', () => {
	it('says whether a view is inside the box loaded', () => {
		expect(boxHolds([0, 0, 2, 2], [0.5, 0.5, 1, 1])).toBe(true);
		expect(boxHolds([0, 0, 2, 2], [0.5, 0.5, 3, 1])).toBe(false);
		expect(boxHolds(null, [0, 0, 1, 1])).toBe(false);
		expect(boxHolds([0, 0, 1, 1], null)).toBe(false);
	});
});
