// The CHIRPS cells of an area (boundaryCells.ts, copied): shares against shapes known by hand, holes,
// the shares adding up to the area, and Pitman's 2 000-cell limit (extend.md § Step 1).
import { describe, expect, it } from 'vitest';
import { geometryAreaM2 } from '../geo/area.js';
import type { Geometry, Position } from '../geo/geojson.js';
import { boundaryCells, MIN_SHARE } from './boundaryCells.js';
import { CHIRPS_MAX_CELLS } from './config.js';

const cos = (lat: number) => Math.cos((lat * Math.PI) / 180);
const poly = (...rings: Position[][]): Geometry => ({ type: 'Polygon', coordinates: rings.map((r) => [...r, r[0]!]) });
const rect = (w: number, s: number, e: number, n: number): Position[] => [
	[w, s],
	[e, s],
	[e, n],
	[w, n]
];
const ok = (g: Geometry) => {
	const r = boundaryCells(g);
	if ('problem' in r) throw new Error(r.problem);
	return r;
};

describe('boundaryCells', () => {
	it('gives a cell wholly inside a share of 1, weighted by cos(latitude)', () => {
		const r = ok(poly(rect(21.1, -33.7, 21.2, -33.6)));
		expect(r.cells.map((c) => `${c.lat},${c.lon}`).sort()).toEqual(['-33.625,21.125', '-33.625,21.175', '-33.675,21.125', '-33.675,21.175']);
		for (const c of r.cells) {
			expect(c.share).toBeCloseTo(1, 9);
			expect(c.weight).toBeCloseTo(cos(c.lat), 9);
		}
	});

	it('shares a cell cut in half, subtracts holes, and sums the shares to the area', () => {
		const half = ok(poly(rect(21.1, -33.7, 21.125, -33.65)));
		expect(half.cells).toHaveLength(1);
		expect(half.cells[0]!.share).toBeCloseTo(0.5, 9);
		const g = poly(rect(21, -34, 21.5, -33.5), rect(21.1, -33.9, 21.2, -33.8).reverse());
		const r = ok(g);
		expect(r.cells).toHaveLength(100 - 4);
		expect(r.insideKm2 / (geometryAreaM2(g)! / 1e6)).toBeCloseTo(1, 4);
	});

	it('leaves out slivers under MIN_SHARE of a cell', () => {
		const r = ok(poly(rect(21.1, -33.7, 21.15 + 0.05 * MIN_SHARE * 0.5, -33.65)));
		expect(r.cells).toHaveLength(1);
	});

	it(`refuses an area over ${CHIRPS_MAX_CELLS} cells with the count, and takes one just under`, () => {
		// 44 × 45 = 1 980 cells; 45 × 45 = 2 025.
		expect(ok(poly(rect(20, -34, 22.2, -31.75))).cells).toHaveLength(1980);
		const big = boundaryCells(poly(rect(20, -34, 22.25, -31.75)));
		expect(big).toEqual({ problem: expect.stringContaining('covers 2025 of the 0.05° CHIRPS cells') });
		expect(boundaryCells(poly(rect(10, -35, 25, -20)))).toEqual({ problem: expect.stringContaining('spans 300 rows') });
	});

	it('refuses a geometry that is not a polygon', () => {
		expect(boundaryCells({ type: 'Point', coordinates: [21, -33] })).toEqual({ problem: 'the area is not a polygon' });
	});
});
