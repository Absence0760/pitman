// The mean MAP over an area (mean.ts): the area-weighted mean against hand-made grids, partial cells,
// the 90 % coverage rule, and D6's finest-grid-first choice; on IC-WBT's synthetic grid too.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIXTURE_GEO_DIR } from '../__tests__/fakeS3.js';
import type { Geometry } from '../geo/geojson.js';
import { areaOverGrid, mapGridMean } from './mean.js';
import { type IndexedRainMap, indexRainMap, rainMapFromJson } from './rainMap.js';

const box = (w: number, s: number, e: number, n: number): Geometry => ({ type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });
const grid = (dataset: string, doc: unknown): IndexedRainMap => {
	const r = rainMapFromJson(doc);
	if (typeof r === 'string') throw new Error(r);
	return indexRainMap(dataset, r.grid, r.meta);
};
/** Two 0.1° cells side by side, 400 and 800 mm. */
const TWO = grid('two', { cellDeg: 0.1, version: 'v1', attribution: 'test', cells: [[20.05, -33.05, 400], [20.15, -33.05, 800]] });

describe('areaOverGrid', () => {
	it('weights each cell by the area of it inside', () => {
		expect(areaOverGrid(box(20, -33.1, 20.2, -33), TWO)).toMatchObject({ ok: true, meanMapMm: 600, cells: 2, coverage: 1 });
		// Three quarters of the first cell and one quarter of the second.
		expect(areaOverGrid(box(20.025, -33.1, 20.125, -33), TWO)).toMatchObject({ ok: true, meanMapMm: 500 });
	});

	it('refuses an area under 90 % covered, or with no value at all', () => {
		expect(areaOverGrid(box(20, -33.1, 20.22, -33), TWO)).toMatchObject({ ok: true });
		expect(areaOverGrid(box(20, -33.1, 20.3, -33), TWO)).toEqual({ ok: false, reason: 'two has values for only 67 % of the area (at least 90 % is needed)' });
		expect(areaOverGrid(box(30, -30, 30.1, -29.9), TWO)).toEqual({ ok: false, reason: 'two has no value inside the area' });
		expect(areaOverGrid(box(20, -34, 30, -24), TWO, 1000)).toMatchObject({ ok: false, reason: expect.stringContaining('more than the 1') });
	});

	it('gives IC-WBT’s synthetic hill a mean between its lowest and highest cells', () => {
		const g = grid('synthetic', JSON.parse(readFileSync(join(FIXTURE_GEO_DIR, 'map-grid.synthetic.json'), 'utf8')));
		const r = areaOverGrid(box(21.3, -33.7, 21.5, -33.5), g);
		if (!r.ok) throw new Error(r.reason);
		expect(r.cells).toBe(400);
		expect(r.meanMapMm).toBeGreaterThan(300);
		expect(r.meanMapMm).toBeLessThan(1200);
		expect(Math.sqrt(r.cellM2)).toBeGreaterThan(900);
		expect(Math.sqrt(r.cellM2)).toBeLessThan(1100);
	});
});

describe('mapGridMean (D6)', () => {
	const COARSE = grid('coarse', { cellDeg: 0.2, cells: [[20.1, -33.1, 1000]] });
	it('answers from the finest grid covering the area, in MapGridSample’s shape with provenance', () => {
		const r = mapGridMean(box(20, -33.1, 20.2, -33), [{ grid: COARSE, source: 's3' }, { grid: TWO, source: 'local' }], '2026-10-29');
		expect(r).toEqual({
			grid: 'two',
			cellSizeM: expect.any(Number),
			cellCount: 2,
			meanMapMm: 600,
			fetchedOn: '2026-10-29',
			cellDeg: 0.1,
			coveragePct: 100,
			version: 'v1',
			attribution: 'test',
			source: 'local'
		});
	});

	it('falls back to a coarser grid when the finer one doesn’t cover the area, and lists every reason when none does', () => {
		expect(mapGridMean(box(20, -33.2, 20.2, -33), [{ grid: TWO, source: 'local' }, { grid: COARSE, source: 's3' }], '2026-10-29')).toMatchObject({ grid: 'coarse', meanMapMm: 1000 });
		const none = mapGridMean(box(30, -30, 30.1, -29.9), [{ grid: TWO, source: 'local' }, { grid: COARSE, source: 's3' }], '2026-10-29');
		expect(none).toEqual({ reasons: ['two has no value inside the area', 'coarse has no value inside the area'] });
	});
});
