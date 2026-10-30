import { describe, expect, it } from 'vitest';
import { syntheticDams } from '../dams/synthetic.js';
import { SYNTHETIC_LAND_USE, syntheticFields } from './synthetic.js';

const Z01A = [21, -33.75, 21.25, -33.5] as const;

describe('the synthetic land use', () => {
	it('answers the same every time', () => {
		expect(syntheticFields(Z01A)).toEqual(syntheticFields(Z01A));
		expect(syntheticDams(Z01A)).toEqual(syntheticDams(Z01A));
	});

	it('gives a quaternary a few hundred fields of crops of each kind', () => {
		const fields = syntheticFields(Z01A);
		expect(fields.length).toBeGreaterThan(200);
		expect(fields.length).toBeLessThan(1000);
		expect(new Set(fields.map((f) => f.irrigated))).toEqual(new Set([true, false, null]));
		expect(new Set(fields.map((f) => f.crop)).size).toBeGreaterThan(5);
		// The layer overrides a crop's usual word sometimes, so one crop can be both.
		const grapes = fields.filter((f) => f.crop === 'Wine grapes');
		expect(new Set(grapes.map((f) => f.irrigated))).toEqual(new Set([true, false]));
	});

	it('gives every field a distinct id and keeps inside the block', () => {
		const fields = syntheticFields([20, -35, 23, -33]);
		expect(new Set(fields.map((f) => f.id)).size).toBe(fields.length);
		const points = fields.flatMap((f) => f.geometry.coordinates.flat(1) as unknown as [number, number][]);
		for (const [x, y] of points) {
			expect(x).toBeGreaterThanOrEqual(SYNTHETIC_LAND_USE.west);
			expect(x).toBeLessThanOrEqual(SYNTHETIC_LAND_USE.east);
			expect(y).toBeGreaterThanOrEqual(SYNTHETIC_LAND_USE.south);
			expect(y).toBeLessThanOrEqual(SYNTHETIC_LAND_USE.north);
		}
	});

	it('gives dams from all three sources, some with no figure at all', () => {
		const dams = syntheticDams([20, -35, 23, -33]);
		expect(new Set(dams.map((d) => d.source))).toEqual(new Set(['register', 'capeFarmMapper', 'surfaceWater']));
		expect(dams.some((d) => d.capacityMm3 === undefined && d.areaKm2 === undefined)).toBe(true);
	});

	it('answers nothing off the block', () => {
		expect(syntheticFields([25, -30, 26, -29])).toEqual([]);
		expect(syntheticDams([25, -30, 26, -29])).toEqual([]);
	});
});
