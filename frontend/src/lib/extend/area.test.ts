import { describe, expect, it } from 'vitest';
import { MAX_AREA_VERTICES, parseArea, parseQuaternaries, ringAreaM2 } from './area.js';

const R = 6_371_008.8;
const rad = Math.PI / 180;
/** Exact area of a longitude/latitude rectangle on the sphere, km². */
const rectKm2 = (w: number, s: number, e: number, n: number) => (R * R * (e - w) * rad * (Math.sin(n * rad) - Math.sin(s * rad))) / 1e6;
const rect = (w: number, s: number, e: number, n: number) => [
	[w, s],
	[e, s],
	[e, n],
	[w, n],
	[w, s]
];
const poly = (...rings: number[][][]) => ({ type: 'Polygon', coordinates: rings });
const ok = (doc: unknown) => {
	const r = parseArea(JSON.stringify(doc));
	if (!r.ok) throw new Error(r.error);
	return r;
};
const refused = (doc: unknown) => {
	const r = parseArea(typeof doc === 'string' ? doc : JSON.stringify(doc));
	if (r.ok) throw new Error('expected a refusal');
	return r.error;
};

describe('parseArea', () => {
	it('reads a Polygon and gives its area on the sphere (exact for a lon/lat rectangle)', () => {
		const a = ok(poly(rect(20, -30, 21, -29)));
		expect(a.geometry.type).toBe('Polygon');
		expect(a.areaKm2).toBeCloseTo(rectKm2(20, -30, 21, -29), 6);
		expect(a.areaKm2).toBeGreaterThan(10_000);
		expect([a.polygons, a.holes, a.vertices, a.features]).toEqual([1, 0, 5, 1]);
		expect(a.bbox).toEqual({ west: 20, south: -30, east: 21, north: -29 });
		expect(a.warnings).toEqual([]);
	});

	it('is the same whichever way the ring winds', () => {
		expect(ringAreaM2([...rect(20, -30, 21, -29)].reverse() as [number, number][])).toBeCloseTo(ringAreaM2(rect(20, -30, 21, -29) as [number, number][]), 3);
	});

	it('subtracts holes and adds MultiPolygon parts', () => {
		const holed = ok(poly(rect(20, -30, 21, -29), rect(20.25, -29.75, 20.75, -29.25)));
		expect(holed.holes).toBe(1);
		expect(holed.areaKm2).toBeCloseTo(rectKm2(20, -30, 21, -29) - rectKm2(20.25, -29.75, 20.75, -29.25), 6);
		const multi = ok({ type: 'MultiPolygon', coordinates: [[rect(20, -30, 21, -29)], [rect(22, -30, 23, -29)]] });
		expect(multi.geometry.type).toBe('MultiPolygon');
		expect(multi.areaKm2).toBeCloseTo(2 * rectKm2(20, -30, 21, -29), 6);
	});

	it('reads a Feature and a FeatureCollection, sending the geometry only (no properties)', () => {
		const feature = ok({ type: 'Feature', properties: { owner: 'someone' }, geometry: poly(rect(20, -30, 21, -29)) });
		expect(feature.geometry).toEqual({ type: 'Polygon', coordinates: [rect(20, -30, 21, -29)] });
		expect(JSON.stringify(feature.geometry)).not.toContain('owner');

		const fc = ok({
			type: 'FeatureCollection',
			features: [
				{ type: 'Feature', properties: { q: 'Z01A' }, geometry: poly(rect(20, -30, 21, -29)) },
				{ type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: [[rect(21, -30, 22, -29)]] } }
			]
		});
		expect(fc.geometry.type).toBe('MultiPolygon');
		expect(fc.polygons).toBe(2);
		expect(fc.features).toBe(2);
		expect(fc.warnings[0]).toMatch(/overlap counts twice/);
		expect(Object.keys(fc.geometry)).toEqual(['type', 'coordinates']);
	});

	it('drops a third (height) coordinate and accepts a byte-order mark', () => {
		const ring3 = rect(20, -30, 21, -29).map(([x, y]) => [x, y, 100]);
		const a = parseArea(`﻿${JSON.stringify(poly(ring3))}`);
		expect(a.ok && a.geometry.coordinates[0]).toEqual(rect(20, -30, 21, -29));
	});

	it('accepts a CRS84 / EPSG:4326 crs member and refuses any other', () => {
		ok({ ...poly(rect(20, -30, 21, -29)), crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' } } });
		ok({ ...poly(rect(20, -30, 21, -29)), crs: { type: 'name', properties: { name: 'EPSG:4326' } } });
		expect(refused({ ...poly(rect(20, -30, 21, -29)), crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::32734' } } })).toMatch(
			/EPSG::32734.*WGS84/
		);
	});

	it.each([
		['not JSON', '{"type": "Polygon"', /not GeoJSON/],
		['a point', { type: 'Point', coordinates: [20, -30] }, /is a Point: the area must be a Polygon or MultiPolygon/],
		['a line in a feature', { type: 'Feature', geometry: { type: 'LineString', coordinates: [] } }, /The feature is a LineString/],
		['an empty collection', { type: 'FeatureCollection', features: [] }, /no features/],
		['an open ring', poly([[20, -30], [21, -30], [21, -29], [20, -29]]), /not closed/],
		['a ring of three positions', poly([[20, -30], [21, -30], [20, -30]]), /at least 4 positions/],
		['a non-number', poly([[20, -30], [21, 'x'], [21, -29], [20, -30]]), /position 2: a position must be \[longitude, latitude\]/],
		['projected coordinates', poly(rect(500000, 6600000, 510000, 6610000)), /look projected/],
		['swapped longitude and latitude', poly(rect(-30, 20, -29, 21)), /look swapped/],
		['outside the copy', poly(rect(42, -30, 43, -29)), /outside the CHIRPS copy/],
		['no area', poly([[20, -30], [21, -30], [20, -30], [20, -30]]), /encloses no area/]
	])('refuses %s with a plain message', (_name, doc, message) => {
		expect(refused(doc)).toMatch(message);
	});

	it('names the bad feature in a collection', () => {
		expect(refused({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: poly(rect(20, -30, 21, -29)) }, { type: 'Nope' }] })).toMatch(
			/^Feature 2 is not a GeoJSON Feature/
		);
	});

	it('refuses more vertices than it sends', () => {
		const n = MAX_AREA_VERTICES + 10;
		const ring = Array.from({ length: n }, (_, i) => [20 + 0.5 * Math.cos((2 * Math.PI * i) / n), -30 + 0.5 * Math.sin((2 * Math.PI * i) / n)]);
		ring.push(ring[0] as number[]);
		expect(refused(poly(ring))).toMatch(/vertices; at most/);
	});
});

describe('parseQuaternaries', () => {
	it('upper-cases, de-duplicates and names what is not a code', () => {
		expect(parseQuaternaries(' h80a, H80B;h80a  x1 ')).toEqual({ codes: ['H80A', 'H80B'], invalid: ['X1'] });
		expect(parseQuaternaries('')).toEqual({ codes: [], invalid: [] });
	});
});
