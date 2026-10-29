// The MAP grid's JSON form (rainMapFromJson, copied) and Pitman's in-memory index of it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIXTURE_GEO_DIR } from '../__tests__/fakeS3.js';
import { indexOf, indexRainMap, originOf, rainMapAt, rainMapFromJson } from './rainMap.js';

const fixture = () => JSON.parse(readFileSync(join(FIXTURE_GEO_DIR, 'map-grid.synthetic.json'), 'utf8'));

describe('rainMapFromJson', () => {
	it('reads IC-WBT’s synthetic grid: 0.01° cells keyed by their south-west corners', () => {
		const r = rainMapFromJson(fixture());
		if (typeof r === 'string') throw new Error(r);
		expect(r.grid.cellDeg).toBe(0.01);
		expect(r.grid.cells).toHaveLength(1575);
		expect(r.meta.attribution).toBe('Synthetic test data');
		expect(originOf(21.255, 0.01)).toBeCloseTo(0, 9);
		expect(indexOf(21.255, 0, 0.01)).toBe(2125);
	});

	it('refuses a file with no cell size, a cell off the grid or a MAP out of range', () => {
		expect(rainMapFromJson({ cells: [] })).toMatch(/cellDeg/);
		expect(rainMapFromJson({ cellDeg: 0.01, cells: [[21.255, -33.795, 300], [21.26, -33.795, 300]] })).toMatch(/isn't on the first cell's/);
		expect(rainMapFromJson({ cellDeg: 0.01, cells: [[21.255, -33.795, 30_000]] })).toMatch(/not a MAP/);
	});
});

describe('indexRainMap', () => {
	it('answers each cell’s MAP, and NaN off the grid or where it has no value', () => {
		const r = rainMapFromJson({ cellDeg: 0.5, cells: [[20.25, -33.75, 400], [21.25, -33.25, 800]] });
		if (typeof r === 'string') throw new Error(r);
		const g = indexRainMap('t', r.grid, r.meta);
		expect(g).toMatchObject({ rows: 2, cols: 3, cells: 2, source: 't', version: '' });
		const [r0, c0] = [indexOf(-33.75, g.originLat, 0.5), indexOf(20.25, g.originLon, 0.5)];
		expect(rainMapAt(g, r0, c0)).toBe(400);
		expect(rainMapAt(g, r0 + 1, c0 + 2)).toBe(800);
		expect(rainMapAt(g, r0, c0 + 1)).toBeNaN();
		expect(rainMapAt(g, r0 - 1, c0)).toBeNaN();
	});
});
