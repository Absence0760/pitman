import type { AreaGeometry } from '@pitman/wrsm';
import { describe, expect, it } from 'vitest';
import { boxOf, boxOfAll, interiorPoint, pieceTintsFor } from './pieces.js';

const box = (w: number, s: number, e: number, n: number): AreaGeometry => ({ type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });

describe('boxOf', () => {
	it('boxes a polygon and a multipolygon', () => {
		expect(boxOf(box(1, 2, 3, 4))).toEqual([1, 2, 3, 4]);
		expect(boxOf({ type: 'MultiPolygon', coordinates: [box(1, 2, 3, 4).coordinates, box(5, 0, 6, 1).coordinates] as never })).toEqual([1, 0, 6, 4]);
	});
	it('has none for an empty geometry', () => {
		expect(boxOf({ type: 'Polygon', coordinates: [] })).toBeNull();
		expect(boxOfAll([])).toBeNull();
	});
	it('boxes several', () => {
		expect(boxOfAll([box(1, 2, 3, 4), box(0, 3, 2, 5)])).toEqual([0, 2, 3, 5]);
	});
});

describe('pieceTintsFor', () => {
	it('gives touching pieces different tints', () => {
		const [a, b] = pieceTintsFor([box(0, 0, 1, 1), box(1, 0, 2, 1)]);
		expect(a).not.toBe(b);
	});
	it('reuses a tint for pieces that don’t touch', () => {
		expect(pieceTintsFor([box(0, 0, 1, 1), box(5, 5, 6, 6)])).toEqual([0, 0]);
	});
	it('stays within the tints with more pieces than tints', () => {
		const tints = pieceTintsFor(Array.from({ length: 8 }, () => box(0, 0, 1, 1)));
		expect(tints).toHaveLength(8);
		expect(Math.max(...tints)).toBeLessThan(6);
	});
});

describe('interiorPoint', () => {
	const inside = (g: AreaGeometry, p: readonly [number, number]) => {
		const ring = (g.type === 'Polygon' ? g.coordinates[0] : g.coordinates[0]![0])!;
		let odd = false;
		for (let i = 0; i + 1 < ring.length; i++) {
			const [ax, ay] = ring[i]!;
			const [bx, by] = ring[i + 1]!;
			if (ay > p[1] !== by > p[1] && p[0] < ax + ((p[1] - ay) * (bx - ax)) / (by - ay)) odd = !odd;
		}
		return odd;
	};
	it('is the middle of a square', () => {
		expect(interiorPoint(box(0, 0, 2, 2))).toEqual([1, 1]);
	});
	it('lands inside a crescent, where the centroid wouldn’t', () => {
		const c: AreaGeometry = { type: 'Polygon', coordinates: [[[0, 0], [4, 0], [4, 1], [1, 1], [1, 3], [4, 3], [4, 4], [0, 4], [0, 0]]] };
		expect(inside(c, interiorPoint(c)!)).toBe(true);
	});
	it('takes the largest part', () => {
		const g: AreaGeometry = { type: 'MultiPolygon', coordinates: [box(0, 0, 1, 1).coordinates, box(10, 10, 14, 14).coordinates] as never };
		expect(interiorPoint(g)).toEqual([12, 12]);
	});
	it('has none for a degenerate ring', () => {
		expect(interiorPoint({ type: 'Polygon', coordinates: [[[1, 1], [2, 2], [1, 1]]] })).toBeNull();
	});
});
