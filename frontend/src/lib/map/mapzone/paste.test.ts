import { describe, expect, it } from 'vitest';
import { parseZone, ringCrosses, ringProblem, wktToGeoJson } from './paste.js';

const POLYGON = 'POLYGON ((20.1 -33.5, 20.2 -33.5, 20.2 -33.4, 20.1 -33.5))';
const GEOJSON = JSON.stringify({
	type: 'Polygon',
	coordinates: [
		[
			[20.1, -33.5],
			[20.2, -33.5],
			[20.2, -33.4],
			[20.1, -33.5]
		]
	]
});

describe('parseZone', () => {
	it('reads GeoJSON', () => {
		const zone = parseZone(GEOJSON);
		expect(zone.ok && zone.geometry.type).toBe('Polygon');
	});

	it('reads WKT, any case, and a MULTIPOLYGON', () => {
		expect(parseZone(POLYGON).ok).toBe(true);
		expect(parseZone(POLYGON.toLowerCase()).ok).toBe(true);
		const multi = parseZone('MULTIPOLYGON (((20.1 -33.5, 20.2 -33.5, 20.2 -33.4, 20.1 -33.5)), ((21.1 -33.5, 21.2 -33.5, 21.2 -33.4, 21.1 -33.5)))');
		expect(multi.ok && multi.geometry.type).toBe('MultiPolygon');
	});

	it('reads a hole in WKT', () => {
		const zone = parseZone('POLYGON ((20 -34, 21 -34, 21 -33, 20 -33, 20 -34), (20.4 -33.6, 20.6 -33.6, 20.6 -33.4, 20.4 -33.6))');
		expect(zone.ok && zone.geometry.type === 'Polygon' && zone.geometry.coordinates.length).toBe(2);
	});

	it('asks for something when the box is empty', () => {
		expect(parseZone('  ')).toEqual({ ok: false, error: expect.stringContaining('Paste a polygon first') });
	});

	it('says why text isn’t a polygon', () => {
		expect(parseZone('not a polygon')).toEqual({ ok: false, error: expect.stringContaining('POLYGON or a MULTIPOLYGON') });
		expect(parseZone('POINT (20 -33)')).toEqual({ ok: false, error: expect.stringContaining('POLYGON or a MULTIPOLYGON') });
		expect(parseZone('POLYGON ((20 -33, 21))')).toEqual({ ok: false, error: expect.stringContaining('not a longitude and a latitude') });
		expect(parseZone('POLYGON ((20 -33, 21 -33)')).toEqual({ ok: false, error: expect.stringContaining('brackets') });
	});

	it('gives pasted text the same checks as an uploaded boundary', () => {
		expect(parseZone('POLYGON ((20.1 -33.5, 20.2 -33.5, 20.2 -33.4, 20.15 -33.45))')).toEqual({ ok: false, error: expect.stringContaining('not closed') });
		expect(parseZone('POLYGON ((-33.5 20.1, -33.5 20.2, -33.4 20.2, -33.5 20.1))')).toEqual({ ok: false, error: expect.stringContaining('swapped') });
		expect(parseZone(JSON.stringify({ type: 'Point', coordinates: [20, -33] }))).toEqual({ ok: false, error: expect.stringContaining('Polygon or MultiPolygon') });
	});

	it('refuses a ring that crosses itself', () => {
		expect(parseZone('POLYGON ((20 -34, 21 -33, 21 -34, 20 -33.2, 20 -34))')).toEqual({ ok: false, error: expect.stringContaining('crosses itself') });
	});

	it('refuses a hole outside its ring', () => {
		expect(parseZone('POLYGON ((20 -34, 20.4 -34, 20.4 -33.6, 20 -34), (21 -34, 21.2 -34, 21.2 -33.8, 21 -34))')).toEqual({ ok: false, error: expect.stringContaining('hole outside') });
	});
});

describe('ring checks', () => {
	it('lets a simple ring through, its closing edge included', () => {
		expect(
			ringCrosses([
				[0, 0],
				[1, 0],
				[1, 1],
				[0, 1],
				[0, 0]
			])
		).toBe(false);
	});

	it('catches a ring that touches itself at a vertex', () => {
		expect(
			ringCrosses([
				[0, 0],
				[2, 0],
				[2, 2],
				[1, 0],
				[0, 2],
				[0, 0]
			])
		).toBe(true);
	});

	it('names the polygon in a MultiPolygon', () => {
		const good = [
			[
				[0, 0],
				[1, 0],
				[1, 1],
				[0, 0]
			]
		] as const;
		const bad = [
			[
				[0, 0],
				[1, 1],
				[1, 0],
				[0, 1],
				[0, 0]
			]
		] as const;
		expect(ringProblem({ type: 'MultiPolygon', coordinates: [good, bad] })).toContain('Polygon 2 crosses itself');
	});

	it('turns WKT into GeoJSON text', () => {
		expect(JSON.parse(wktToGeoJson('POLYGON Z ((1 2 3, 4 5 6, 7 8 9, 1 2 3))'))).toEqual({
			type: 'Polygon',
			coordinates: [
				[
					[1, 2],
					[4, 5],
					[7, 8],
					[1, 2]
				]
			]
		});
	});
});
