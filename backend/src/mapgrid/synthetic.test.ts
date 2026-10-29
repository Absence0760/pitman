import { describe, expect, it } from 'vitest';
import { rainMapFromJson } from './rainMap.js';
import { SYNTHETIC_MAP_GRID, syntheticMapGridJson } from './synthetic.js';

describe('the synthetic MAP grid', () => {
	it('is a valid grid over the synthetic CHIRPS block, with no value south of the invented coast, the same every time', () => {
		const json = syntheticMapGridJson();
		expect(syntheticMapGridJson()).toBe(json);
		const r = rainMapFromJson(JSON.parse(json));
		if (typeof r === 'string') throw new Error(r);
		expect(r.grid.cellDeg).toBe(0.01);
		expect(r.grid.cells).toHaveLength(100 * 75);
		const lats = r.grid.cells.map((c) => r.grid.originLat + (c.row + 0.5) * 0.01);
		expect(Math.min(...lats)).toBeGreaterThan(SYNTHETIC_MAP_GRID.coastLat);
		const maps = r.grid.cells.map((c) => c.mapMm);
		expect(Math.min(...maps)).toBeGreaterThan(200);
		expect(Math.max(...maps)).toBeLessThan(1200);
	});
});
