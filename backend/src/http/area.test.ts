// The `{ area }` body (area.ts): what is refused as a 400 with a message, the ring limit, and a hash
// that keys the cache the same for the same checked geometry.
import { describe, expect, it } from 'vitest';
import { GEO_MAX_VERTICES } from '../geo/geojson.js';
import { GEO_MAX_RINGS, parseArea } from './area.js';
import { ApiError } from './errors.js';

const square = (x: number, y: number, d = 0.1) => [[x, y], [x + d, y], [x + d, y + d], [x, y + d], [x, y]];
const refused = (body: unknown) => {
	try {
		parseArea(body);
	} catch (e) {
		expect(e).toBeInstanceOf(ApiError);
		expect((e as ApiError).status).toBe(400);
		return (e as Error).message;
	}
	throw new Error('not refused');
};

describe('parseArea', () => {
	it('takes a Polygon or a MultiPolygon, and hashes the checked geometry', () => {
		const a = parseArea({ area: { type: 'Polygon', coordinates: [square(21, -34)] } });
		expect(a.geometry.type).toBe('Polygon');
		expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
		// Coordinates are rounded to 1e-7° by the check, so a difference below that is the same area.
		expect(parseArea({ area: { type: 'Polygon', coordinates: [square(21.00000001, -34)] } }).hash).toBe(a.hash);
		expect(parseArea({ area: { type: 'Polygon', coordinates: [square(21.001, -34)] } }).hash).not.toBe(a.hash);
		expect(parseArea({ area: { type: 'MultiPolygon', coordinates: [[square(21, -34)], [square(22, -34)]] } }).geometry.type).toBe('MultiPolygon');
	});

	it('refuses a body that is not { area: <polygon> }', () => {
		expect(refused([])).toMatch(/JSON object/);
		expect(refused({})).toMatch(/no "area"/);
		expect(refused({ area: { type: 'Point', coordinates: [21, -34] } })).toMatch(/Polygon or MultiPolygon geometry, not Point/);
		expect(refused({ area: { type: 'Feature', geometry: {} } })).toMatch(/not Feature/);
		expect(refused({ area: { type: 'Polygon' } })).toMatch(/no coordinates/);
	});

	it('refuses invalid GeoJSON with checkGeometry’s message', () => {
		expect(refused({ area: { type: 'Polygon', coordinates: [[[21, -34], [21.1, -34], [21.1, -33.9], [21, -33.9]]] } })).toMatch(/not closed/);
		expect(refused({ area: { type: 'Polygon', coordinates: [[[21, -34], [21.2, -33.9], [21.2, -34], [21, -33.7], [21, -34]]] } })).toMatch(/crosses itself/);
		expect(refused({ area: { type: 'Polygon', coordinates: [square(2_100_000, -3_400_000, 1000)] } })).toMatch(/looks projected/);
		expect(refused({ area: { type: 'MultiPolygon', coordinates: [[square(21, -34)], [square(21.05, -34)]] } })).toMatch(/overlap/);
	});

	it(`refuses more than ${GEO_MAX_RINGS} rings and more than ${GEO_MAX_VERTICES} positions`, () => {
		const parts = Array.from({ length: GEO_MAX_RINGS + 1 }, (_, i) => [square(10 + (i % 100) * 0.2, -30 + Math.floor(i / 100) * 0.2)]);
		expect(refused({ area: { type: 'MultiPolygon', coordinates: parts } })).toMatch(/1001 rings/);
		const n = GEO_MAX_VERTICES + 1;
		const ring = Array.from({ length: n }, (_, i) => [21 + 0.1 * Math.cos((2 * Math.PI * i) / n), -34 + 0.1 * Math.sin((2 * Math.PI * i) / n)]);
		ring.push(ring[0]!);
		expect(refused({ area: { type: 'Polygon', coordinates: [ring] } })).toMatch(/more than 50/);
	});
});
