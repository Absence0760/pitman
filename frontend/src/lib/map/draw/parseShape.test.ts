import { describe, expect, it } from 'vitest';
import { parseShape, PASTE_MAX_CHARS } from './parseShape.js';

const RING = [[21, -34], [22, -34], [22, -33], [21, -34]];
const POLYGON = { type: 'Polygon', coordinates: [RING] };

describe('parseShape: GeoJSON', () => {
	it.each([
		['a geometry', POLYGON],
		['a feature', { type: 'Feature', geometry: POLYGON }],
		['a collection of one', { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: POLYGON }] }]
	])('takes %s', (_name, v) => {
		expect(parseShape(JSON.stringify(v))).toEqual({ geometry: POLYGON });
	});
	it('takes a multipolygon', () => {
		expect(parseShape(JSON.stringify({ type: 'MultiPolygon', coordinates: [[RING]] }))).toEqual({ geometry: { type: 'MultiPolygon', coordinates: [[RING]] } });
	});
	it('closes an open ring', () => {
		expect(parseShape(JSON.stringify({ type: 'Polygon', coordinates: [RING.slice(0, 3)] }))).toEqual({ geometry: POLYGON });
	});
	it.each([
		['a point', { type: 'Point', coordinates: [21, -34] }, 'the map takes a polygon'],
		['two features', { type: 'FeatureCollection', features: [{}, {}] }, 'holds 2 features'],
		['projected coordinates', { type: 'Polygon', coordinates: [[[50000, 3700000], [1, 1], [2, 2]]] }, 'looks projected'],
		['3D coordinates', { type: 'Polygon', coordinates: [[[21, -34, 100], [22, -34, 100], [22, -33, 100]]] }, '3D'],
		['another CRS', { ...POLYGON, crs: { properties: { name: 'EPSG:2048' } } }, 'reproject'],
		['too few positions', { type: 'Polygon', coordinates: [[[21, -34], [22, -34]]] }, 'at least 3']
	])('refuses %s, in words', (_name, v, words) => {
		expect(parseShape(JSON.stringify(v))).toEqual({ error: expect.stringContaining(words) });
	});
	it('refuses broken JSON', () => {
		expect(parseShape('{ nope')).toEqual({ error: expect.stringContaining('isn’t valid JSON') });
	});
});

describe('parseShape: WKT', () => {
	it('takes a polygon, with or without an SRID', () => {
		expect(parseShape('POLYGON((21 -34, 22 -34, 22 -33, 21 -34))')).toEqual({ geometry: POLYGON });
		expect(parseShape('SRID=4326;polygon ((21 -34, 22 -34, 22 -33, 21 -34))')).toEqual({ geometry: POLYGON });
	});
	it('takes a multipolygon', () => {
		expect(parseShape('MULTIPOLYGON(((21 -34, 22 -34, 22 -33, 21 -34)))')).toEqual({ geometry: { type: 'MultiPolygon', coordinates: [[RING]] } });
	});
	it.each([
		['POINT(21 -33)', 'the map takes a polygon'],
		['SRID=2048;POLYGON((1 2, 3 4, 5 6))', 'SRID 2048'],
		['POLYGON Z((21 -34 1, 22 -34 1, 22 -33 1))', '3D'],
		['POLYGON EMPTY', 'empty'],
		['POLYGON((21 -34, 22 -34', 'brackets'],
		['POLYGON((21 x, 22 -34, 22 -33))', '“x”'],
		['hello', 'Paste GeoJSON']
	])('refuses %s, in words', (text, words) => {
		expect(parseShape(text)).toEqual({ error: expect.stringContaining(words) });
	});
});

describe('parseShape: limits', () => {
	it('asks for something, and refuses too much', () => {
		expect(parseShape('  ')).toEqual({ error: 'Paste a shape first.' });
		expect(parseShape('x'.repeat(PASTE_MAX_CHARS + 1))).toEqual({ error: expect.stringContaining('too long') });
	});
});
