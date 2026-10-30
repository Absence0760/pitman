// The adapter against invented features of the provisional shape. Replace these samples with the layer's real one when
// the token's answers arrive (docs/data.md § Cape Farm Mapper).
import { describe, expect, it } from 'vitest';
import { CROP_LAYER, CROP_OUT_FIELDS, DAM_LAYER, DAM_OUT_FIELDS, damFromFeature, fieldFromFeature, irrigatedFrom } from './adapter.js';

const ring = [[21, -34], [21.01, -34], [21.01, -33.99], [21, -33.99], [21, -34]];
const crop = { [CROP_LAYER.id]: 12, [CROP_LAYER.crop]: ' Apples ', [CROP_LAYER.irrigation!]: 'Drip' };

describe('fieldFromFeature', () => {
	it('maps a feature onto a field, the id and crop as text', () => {
		expect(fieldFromFeature({ properties: crop, geometry: { type: 'Polygon', coordinates: [ring] } })).toEqual({ id: '12', crop: 'Apples', irrigated: true, geometry: { type: 'Polygon', coordinates: [ring] } });
	});

	it('takes a MultiPolygon, and drops a third coordinate', () => {
		const out = fieldFromFeature({ properties: crop, geometry: { type: 'MultiPolygon', coordinates: [[ring.map(([x, y]) => [x, y, 120])]] } });
		expect(out?.geometry).toEqual({ type: 'MultiPolygon', coordinates: [[ring]] });
	});

	it('falls back on the feature’s own id', () => {
		expect(fieldFromFeature({ id: 7, properties: { [CROP_LAYER.crop]: 'Apples' }, geometry: { type: 'Polygon', coordinates: [ring] } })?.id).toBe('7');
	});

	it('answers null for what it can’t read, whatever the shape', () => {
		for (const f of [{}, { properties: crop }, { properties: crop, geometry: null }, { properties: crop, geometry: { type: 'Polygon', coordinates: 'x' } }, { properties: crop, geometry: { type: 'Polygon', coordinates: [[[900000, 3000000], [1, 1], [2, 2], [1, 1]]] } }, { properties: crop, geometry: { type: 'MultiPolygon', coordinates: [1] } }, { properties: crop, geometry: { type: 'Polygon', coordinates: [[null]] } }, { properties: { [CROP_LAYER.id]: 1 }, geometry: { type: 'Polygon', coordinates: [ring] } }]) {
			expect(fieldFromFeature(f)).toBeNull();
		}
	});
});

describe('irrigatedFrom (D-8, question 6)', () => {
	it('reads the wordings it knows and never guesses at the rest', () => {
		expect(['Irrigated', 'drip', 'Centre pivot'.split(' ')[1], 'micro', 'Flood irrigation'].map(irrigatedFrom)).toEqual([true, true, true, true, true]);
		expect(['Dryland', 'dry land', 'Rainfed', 'no'].map(irrigatedFrom)).toEqual([false, false, false, false]);
		expect(['', 'unknown', 1, null, undefined].map(irrigatedFrom)).toEqual([null, null, null, null, null]);
	});
});

describe('damFromFeature', () => {
	const props = { [DAM_LAYER.id]: 3, [DAM_LAYER.name]: 'Upper', [DAM_LAYER.capacity!]: 120_000 };

	it('maps a point, capacity in million m³', () => {
		expect(damFromFeature({ properties: props, geometry: { type: 'Point', coordinates: [21.5, -33.8] } })).toEqual({ id: 'cfm-3', source: 'capeFarmMapper', lon: 21.5, lat: -33.8, capacityMm3: 0.12, name: 'Upper' });
	});

	it('maps an outline to its middle and geodesic area, never a capacity it wasn’t given', () => {
		const out = damFromFeature({ properties: { [DAM_LAYER.id]: 4 }, geometry: { type: 'Polygon', coordinates: [ring] } });
		expect(out).toMatchObject({ id: 'cfm-4', lon: expect.closeTo(21.005, 9), lat: expect.closeTo(-33.995, 9) });
		expect(out?.areaKm2).toBeGreaterThan(1);
		expect(out?.capacityMm3).toBeUndefined();
	});

	it('answers null without an id or a place', () => {
		expect(damFromFeature({ geometry: { type: 'Point', coordinates: [21, -34] } })).toBeNull();
		expect(damFromFeature({ properties: props, geometry: { type: 'Point', coordinates: [900000, 1] } })).toBeNull();
	});
});

describe('out fields', () => {
	it('asks only for what the adapter reads', () => {
		expect(CROP_OUT_FIELDS.split(',')).toEqual([CROP_LAYER.id, CROP_LAYER.crop, CROP_LAYER.irrigation]);
		expect(DAM_OUT_FIELDS.split(',')).toEqual([DAM_LAYER.id, DAM_LAYER.name, DAM_LAYER.capacity]);
	});
});
