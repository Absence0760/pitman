// Copied from IC-WBT (Absence0760/project-water-management, MIT) backend/src/geo/area.test.ts at f888e4461
// Geodesic area (geo/area.ts): squares of known size at South African
// latitudes, the ellipsoid's own published surface area, holes and parts.
import { describe, expect, it } from 'vitest';
import { AUTHALIC_RADIUS_M, geometryAreaM2, polygonAreaM2, ringAreaM2 } from './area.js';
import type { Position } from './geojson.js';

const A = 6_378_137;
const E2 = 0.006_694_379_990_14;
const rad = Math.PI / 180;

/** A square `sideM` metres on a side centred at (lon, lat), sides along the meridian and the parallel (radii of curvature of WGS84). */
function square(lon: number, lat: number, sideM: number): Position[] {
	const s = Math.sin(lat * rad);
	const w = 1 - E2 * s * s;
	const meridional = (A * (1 - E2)) / Math.pow(w, 1.5);
	const primeVertical = A / Math.sqrt(w);
	const dLat = sideM / meridional / rad / 2;
	const dLon = sideM / (primeVertical * Math.cos(lat * rad)) / rad / 2;
	return [
		[lon - dLon, lat - dLat],
		[lon + dLon, lat - dLat],
		[lon + dLon, lat + dLat],
		[lon - dLon, lat + dLat],
		[lon - dLon, lat - dLat]
	];
}

describe('geodesic area', () => {
	it('gives a 1 km² square at a southern-hemisphere latitude its area, within 0.01 %', () => {
		for (const lat of [-22, -30, -34.5]) {
			const a = ringAreaM2(square(25, lat, 1000));
			expect(Math.abs(a - 1e6) / 1e6, `at ${lat}°`).toBeLessThan(1e-4);
		}
	});

	it('gives a 10 km square (100 km²) its area within 0.05 %', () => {
		const a = ringAreaM2(square(19.5, -33.9, 10_000));
		expect(Math.abs(a - 1e8) / 1e8).toBeLessThan(5e-4);
	});

	it('gives a quarter of the ellipsoid a quarter of WGS84’s published surface area (510 065 621.724 km²)', () => {
		const quarter = ringAreaM2([
			[0, 0],
			[180, 0],
			[180, 90],
			[0, 90],
			[0, 0]
		]);
		expect(quarter / 1e6).toBeCloseTo(510_065_621.724 / 4, 0);
		expect(4 * Math.PI * AUTHALIC_RADIUS_M ** 2 / 1e6).toBeCloseTo(510_065_621.724, 0);
	});

	it('is the same either way round, closed or not', () => {
		const sq = square(25, -30, 1000);
		expect(ringAreaM2([...sq].reverse())).toBeCloseTo(ringAreaM2(sq), 6);
		expect(ringAreaM2(sq.slice(0, 4))).toBeCloseTo(ringAreaM2(sq), 6);
	});

	it('takes a polygon’s holes away and adds a MultiPolygon’s parts', () => {
		const outer = square(25, -30, 2000);
		const hole = square(25, -30, 1000);
		expect(polygonAreaM2([outer, hole]) / 1e6).toBeCloseTo(3, 3);
		const g = { type: 'MultiPolygon', coordinates: [[square(25, -30, 1000)], [square(26, -30, 1000)]] };
		expect(geometryAreaM2(g)! / 1e6).toBeCloseTo(2, 3);
		expect(geometryAreaM2({ type: 'Point', coordinates: [25, -30] })).toBeNull();
	});
});
