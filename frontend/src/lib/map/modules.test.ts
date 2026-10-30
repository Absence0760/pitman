import type { AreaGeometry, QuaternaryFeature } from '@pitman/wrsm';
import { describe, expect, it } from 'vitest';
import { placeModules, quaternaryCodeIn, type ModuleLike } from './modules.js';
import { boxOf } from './pieces.js';

const box = (w: number, s: number, e: number, n: number): AreaGeometry => ({ type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });
const quaternary = (code: string, geometry: AreaGeometry): QuaternaryFeature => ({ type: 'Feature', properties: { code }, geometry });
const Q = [quaternary('Z01A', box(21, -34, 21.25, -33.75)), quaternary('Z01B', box(21.25, -34, 21.5, -33.75))];
const KNOWN = new Set(['Z01A', 'Z01B']);
const ru = (number: number, name: string): ModuleLike => ({ kind: 'RU', number, name });

describe('quaternaryCodeIn', () => {
	it.each([
		['Z01A', 'Z01A'],
		['z01a upper', 'Z01A'],
		['UP_Z01B', 'Z01B'],
		['Z01B-2', 'Z01B'],
		['Z01B1', 'Z01B'],
		['Dam at Z01A weir', 'Z01A']
	])('finds it in %s', (name, code) => {
		expect(quaternaryCodeIn(name, KNOWN)).toBe(code);
	});
	it.each([['River'], [''], ['Z01C'], ['XZ01A'], ['Z01AB']])('finds none in %j', (name) => {
		expect(quaternaryCodeIn(name, KNOWN)).toBeNull();
	});
	it('skips a code the boundaries don’t know for one they do', () => {
		expect(quaternaryCodeIn('H10F from Z01A', KNOWN)).toBe('Z01A');
	});
});

describe('placeModules', () => {
	it('puts a module inside the quaternary its name holds', () => {
		const { placed, unplaced } = placeModules([ru(1, 'Z01A')], Q);
		expect(unplaced).toEqual([]);
		expect(placed).toHaveLength(1);
		expect(placed[0]).toMatchObject({ id: 'RU1', label: 'RU1 Z01A' });
		const [lon, lat] = placed[0]!.lngLat;
		const [w, s, e, n] = boxOf(Q[0]!.geometry)!;
		expect(lon).toBeGreaterThan(w);
		expect(lon).toBeLessThan(e);
		expect(lat).toBeGreaterThan(s);
		expect(lat).toBeLessThan(n);
	});
	it('says which it couldn’t place, whatever the module type', () => {
		const { placed, unplaced } = placeModules([ru(1, 'Z01A'), ru(2, 'River'), { kind: 'unparsed', moduleType: 'RV', number: 3, name: '' }], Q);
		expect(placed).toHaveLength(1);
		expect(unplaced).toEqual([
			{ id: 'RU2', label: 'RU2 River' },
			{ id: 'RV3', label: 'RV3' }
		]);
	});
	it('spreads modules in one quaternary so none hides another, inside it', () => {
		const modules = Array.from({ length: 12 }, (_, i) => ru(i + 1, `Z01A ${i}`));
		const { placed } = placeModules(modules, Q);
		expect(new Set(placed.map((m) => m.lngLat.join())).size).toBe(12);
		const [w, s, e, n] = boxOf(Q[0]!.geometry)!;
		for (const { lngLat: [lon, lat] } of placed) {
			expect(lon).toBeGreaterThan(w);
			expect(lon).toBeLessThan(e);
			expect(lat).toBeGreaterThan(s);
			expect(lat).toBeLessThan(n);
		}
	});
	it('holds up with 60 modules', () => {
		const modules = Array.from({ length: 64 }, (_, i) => ru(i + 1, i % 2 ? 'Z01A' : 'River'));
		const { placed, unplaced } = placeModules(modules, Q);
		expect(placed).toHaveLength(32);
		expect(unplaced).toHaveLength(32);
	});
	it('can’t place anything on no boundaries', () => {
		expect(placeModules([ru(1, 'Z01A')], [])).toEqual({ placed: [], unplaced: [{ id: 'RU1', label: 'RU1 Z01A' }] });
	});
	it('lists a module whose quaternary has a degenerate outline as not placed', () => {
		const flat: AreaGeometry = { type: 'Polygon', coordinates: [[[1, 1], [2, 2], [1, 1]]] };
		expect(placeModules([ru(1, 'Z01A')], [quaternary('Z01A', flat)]).unplaced).toHaveLength(1);
	});
});
