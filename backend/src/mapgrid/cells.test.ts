import { describe, expect, it } from 'vitest';
import { ApiError } from '../http/errors.js';
import { MAP_GRID_BBOX_MAX_DEG, MAP_GRID_MAX_CELLS, mapGridCells, parseBbox } from './cells.js';
import { indexRainMap, type RainMapGrid } from './rainMap.js';

/** A grid with its origin at 0, 0; `value(row, col)` null leaves a cell out. */
function grid(dataset: string, cellDeg: number, rows: number, cols: number, value: (row: number, col: number) => number | null = (r, c) => 100 * r + c, row0 = 0, col0 = 0) {
	const cells: RainMapGrid['cells'] = [];
	for (let row = row0; row < row0 + rows; row++) {
		for (let col = col0; col < col0 + cols; col++) {
			const mapMm = value(row, col);
			if (mapMm !== null) cells.push({ row, col, mapMm });
		}
	}
	return indexRainMap(dataset, { cellDeg, originLon: 0, originLat: 0, cells }, { source: `${dataset} source` });
}

describe('parseBbox', () => {
	it('takes four finite numbers in order', () => {
		expect(parseBbox({ bbox: [21, -34, 22, -33] })).toEqual([21, -34, 22, -33]);
	});
	it.each([[{}], [null], [{ bbox: [1, 2, 3] }], [{ bbox: [1, 2, 3, 'x'] }], [{ bbox: [2, 0, 1, 1] }], [{ bbox: [0, 1, 1, 0] }], [{ bbox: [0, 0, 181, 1] }], [{ bbox: [0, -91, 1, 0] }]])('refuses %j with a 400', (body) => {
		expect(() => parseBbox(body)).toThrowError(ApiError);
		expect(() => parseBbox(body)).toThrowError(expect.objectContaining({ status: 400 }));
	});
	it('refuses a box over the limit with a 422 the client can name', () => {
		expect(() => parseBbox({ bbox: [0, 0, MAP_GRID_BBOX_MAX_DEG + 0.01, 1] })).toThrowError(expect.objectContaining({ status: 422, extra: { code: 'too_wide' } }));
	});
});

describe('mapGridCells', () => {
	it('answers rows north to south, west to east, with the north-west cell’s centre as origin', () => {
		const c = mapGridCells([grid('g', 0.1, 3, 2)], [0, 0, 0.2, 0.3]);
		expect(c).toMatchObject({ dataset: 'g', source: 'g source', cellDeg: 0.1, cols: 2, rows: 3 });
		expect(c.originLon).toBeCloseTo(0.05, 9);
		expect(c.originLat).toBeCloseTo(0.25, 9);
		expect(c.values).toEqual([200, 201, 100, 101, 0, 1]);
	});
	it('takes cells by their centres and trims the block to the grid', () => {
		const c = mapGridCells([grid('g', 0.1, 4, 4)], [0.06, 0.06, 5, 0.24]);
		expect(c).toMatchObject({ cols: 3, rows: 1, values: [101, 102, 103] });
		expect(c.originLon).toBeCloseTo(0.15, 9);
		expect(c.originLat).toBeCloseTo(0.15, 9);
	});
	it('works on grids south and west of the origin', () => {
		const g = grid('g', 0.1, 2, 2, (r, c) => 10 * (r + 300) + c + 200, -300, -200);
		const c = mapGridCells([g], [-20, -30, -19.8, -29.8]);
		expect(c).toMatchObject({ cols: 2, rows: 2, values: [10, 11, 0, 1] });
		expect(c.originLon).toBeCloseTo(-19.95, 9);
		expect(c.originLat).toBeCloseTo(-29.85, 9);
	});
	it('gives null where the grid has no value, and rounds to a tenth of a mm', () => {
		const c = mapGridCells([grid('g', 0.1, 1, 3, (_, col) => (col === 1 ? null : 812.3456))], [0, 0, 0.3, 0.1]);
		expect(c.values).toEqual([812.3, null, 812.3]);
	});
	it('takes the finest grid with a value in the box, whatever the order', () => {
		const coarse = grid('coarse', 0.5, 2, 2);
		const fine = grid('fine', 0.1, 2, 2);
		expect(mapGridCells([coarse, fine], [0, 0, 0.2, 0.2]).dataset).toBe('fine');
		expect(mapGridCells([fine, coarse], [0.5, 0.5, 1, 1]).dataset).toBe('coarse');
		const partial = grid('partial', 0.1, 2, 2, (r) => (r === 0 ? 1 : null));
		expect(mapGridCells([partial, coarse], [0, 0.1, 0.5, 0.5]).dataset).toBe('coarse');
	});
	it('says no grid covers a box with no value', () => {
		expect(() => mapGridCells([grid('g', 0.1, 2, 2)], [10, 10, 11, 11])).toThrowError(expect.objectContaining({ status: 422, extra: { code: 'no_coverage' } }));
	});
	it('refuses a block over the cell limit without reading it', () => {
		const side = Math.ceil(Math.sqrt(MAP_GRID_MAX_CELLS)) + 1;
		const wide = { ...grid('dense', 0.001, 1, 1), rows: side, cols: side, values: new Float32Array(side * side) };
		expect(() => mapGridCells([wide], [0, 0, 2, 2])).toThrowError(expect.objectContaining({ status: 422, extra: { code: 'too_dense' } }));
	});
});
