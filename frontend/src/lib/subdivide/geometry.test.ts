import type { AreaGeometry } from '@pitman/wrsm';
import { describe, expect, it } from 'vitest';
import { box } from './fixtures.test-helper.js';
import { bboxOf, centreOf, geometryAreaKm2, pointInGeometry } from './geometry.js';

const WITH_HOLE: AreaGeometry = {
	type: 'Polygon',
	coordinates: [
		[
			[20, -34],
			[21, -34],
			[21, -33],
			[20, -33],
			[20, -34]
		],
		[
			[20.4, -33.6],
			[20.6, -33.6],
			[20.6, -33.4],
			[20.4, -33.4],
			[20.4, -33.6]
		]
	]
};

const TWO_PARTS: AreaGeometry = { type: 'MultiPolygon', coordinates: [box(20, -34, 20.1, -33.9).coordinates as never, box(21, -33, 21.2, -32.8).coordinates as never] };

describe('outline questions', () => {
	it('finds the box and the centre, across every part', () => {
		expect(bboxOf(TWO_PARTS)).toEqual([20, -34, 21.2, -32.8]);
		const [lon, lat] = centreOf(box(20, -34, 21, -33));
		expect(lon).toBeCloseTo(20.5, 9);
		expect(lat).toBeCloseTo(-33.5, 9);
	});

	it('takes a hole out of the area', () => {
		const whole = geometryAreaKm2(box(20, -34, 21, -33));
		expect(whole).toBeCloseTo(10_310, -1); // 111.19² × cos 33.5° for a 1° box
		expect(geometryAreaKm2(WITH_HOLE)).toBeLessThan(whole);
		expect(geometryAreaKm2(WITH_HOLE)).toBeCloseTo(whole * 0.96, -2);
	});

	it('counts a point in a hole as outside', () => {
		expect(pointInGeometry(20.2, -33.5, WITH_HOLE)).toBe(true);
		expect(pointInGeometry(20.5, -33.5, WITH_HOLE)).toBe(false);
		expect(pointInGeometry(22, -33.5, WITH_HOLE)).toBe(false);
	});

	it('looks in every part of a MultiPolygon', () => {
		expect(pointInGeometry(21.1, -32.9, TWO_PARTS)).toBe(true);
		expect(pointInGeometry(20.5, -33.5, TWO_PARTS)).toBe(false);
	});
});
