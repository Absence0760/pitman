// Copied from IC-WBT (Absence0760/project-water-management, MIT) backend/src/geo/gridShares.test.ts at f888e4461; the cultivatedFromCells block (cropland.ts, not copied) removed.
// The share of each grid cell a polygon covers (gridShares.ts): shapes whose answer is known by hand, holes, the
// shares adding up to the polygon's own area, the cell filter and the limit.

import { describe, expect, it } from 'vitest';
import { geometryAreaM2 } from './area.js';
import type { Geometry, Position } from './geojson.js';
import { cellAreaM2, cellSpan, gridShares, toGrid } from './gridShares.js';

const D = 0.0025;
const poly = (...rings: Position[][]): Geometry => ({ type: 'Polygon', coordinates: rings.map((r) => [...r, r[0]!]) });
const rect = (w: number, s: number, e: number, n: number): Position[] => [
	[w, s],
	[e, s],
	[e, n],
	[w, n]
];
const ok = (g: Geometry, cell = D, only?: (r: number, c: number) => boolean) => {
	const r = gridShares(g, cell, 1e6, only);
	if ('problem' in r) throw new Error(r.problem);
	return r;
};

describe('gridShares', () => {
	it('gives the cells wholly inside a share of 1, and none outside', () => {
		const r = ok(poly(rect(21.3, -33.68, 21.305, -33.675)));
		expect(r.cells).toHaveLength(4);
		for (const c of r.cells) expect(c.share).toBeCloseTo(1, 6);
		expect(r.cells.map((c) => [c.row, c.col])).toEqual([
			[-13472, 8520],
			[-13472, 8521],
			[-13471, 8520],
			[-13471, 8521]
		]);
	});

	it('cuts a cell at the polygon’s edge by its area: half a cell is a share of ½', () => {
		const r = ok(poly(rect(21.3, -33.68, 21.30125, -33.6775)));
		expect(r.cells).toHaveLength(1);
		expect(r.cells[0]!.share).toBeCloseTo(0.5, 6);
	});

	it('subtracts a hole, and the cells times their shares add up to the polygon’s own area', () => {
		const g = poly(rect(21.3001, -33.6912, 21.3313, -33.6707), rect(21.31, -33.685, 21.32, -33.68).reverse());
		const r = ok(g);
		const sum = r.cells.reduce((s, c) => s + c.cellM2 * c.share, 0);
		expect(sum / geometryAreaM2(g)!).toBeCloseTo(1, 4);
		const inHole = r.cells.find((c) => c.row === Math.floor(-33.68125 / D) && c.col === Math.floor(21.31375 / D));
		expect(inHole).toBeUndefined();
	});

	it('clips only the cells the filter keeps', () => {
		const r = ok(poly(rect(21.3, -33.68, 21.31, -33.67)), D, (row, col) => col === Math.floor(21.30125 / D) && row === Math.floor(-33.67875 / D));
		expect(r.cells).toHaveLength(1);
	});

	it('refuses an extent past the limit before clipping, and a line', () => {
		expect(gridShares(poly(rect(20, -34, 21, -33)), D, 1000)).toEqual({ problem: expect.stringMatching(/spans 160\D000 land-cover cells, more than the 1\D000/) });
		// Another grid names itself (geo/evaporation.ts passes 'evaporation').
		expect(gridShares(poly(rect(20, -34, 21, -33)), D, 1000, undefined, 'evaporation')).toEqual({ problem: expect.stringMatching(/spans 160\D000 evaporation cells/) });
		expect(gridShares({ type: 'LineString', coordinates: [[21, -33], [21.1, -33.1]] }, D, 1000)).toEqual({ problem: 'not a polygon' });
	});

	it('spans no extra cell for an edge on a grid line, and a cell’s area is the ellipsoid’s', () => {
		expect(cellSpan(21.3, 21.305, D)).toEqual([8520, 8522]);
		// 0.0025° at 33.7° S: about 278 m × 232 m.
		expect(cellAreaM2(21.3, -33.68, D) / 1e4).toBeCloseTo(6.43, 1);
	});
});

describe('toGrid', () => {
	it('moves a Polygon and every ring of a MultiPolygon by the grid’s origin, and leaves anything else as it is', () => {
		const origin = { originLon: 0.05, originLat: 0.025 };
		expect(toGrid({ type: 'Polygon', coordinates: [[[1, 2], [1.5, 2], [1.5, 2.5], [1, 2]]] }, origin)).toEqual({
			type: 'Polygon',
			coordinates: [[[0.95, 1.975], [1.45, 1.975], [1.45, 2.475], [0.95, 1.975]]]
		});
		const multi = toGrid({ type: 'MultiPolygon', coordinates: [[[[1, 2], [2, 2], [2, 3], [1, 2]]], [[[3, 4], [4, 4], [4, 5], [3, 4]]]] }, origin);
		expect(multi.type).toBe('MultiPolygon');
		expect((multi as { coordinates: Position[][][] }).coordinates[1]![0]![0]).toEqual([2.95, 3.975]);
		const point: Geometry = { type: 'Point', coordinates: [1, 2] };
		expect(toGrid(point, origin)).toBe(point);
	});
});
