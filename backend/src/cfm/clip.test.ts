import { type AreaGeometry, intersectGeometry } from '@pitman/wrsm';
import { describe, expect, it } from 'vitest';
import { geometryAreaM2 } from '../geo/area.js';
import type { LayerField } from './adapter.js';
import { clipFields } from './clip.js';
import { CFM_DEADLINE_MS } from './routes.js';

const box = (w: number, s: number, e: number, n: number): AreaGeometry => ({ type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });
const field = (id: string, geometry: AreaGeometry, irrigated: boolean | null = true): LayerField => ({ id, crop: 'Apples', irrigated, geometry });
const ha = (g: AreaGeometry) => geometryAreaM2(g)! / 1e4;
const AREA = box(21, -34, 21.1, -33.9);
/** A U: the notch is 21.04–21.06 from the north down to −33.96. */
const U: AreaGeometry = { type: 'Polygon', coordinates: [[[21, -34], [21.1, -34], [21.1, -33.9], [21.06, -33.9], [21.06, -33.96], [21.04, -33.96], [21.04, -33.9], [21, -33.9], [21, -34]]] };

describe('clipFields', () => {
	it('keeps a field wholly inside, with its geodesic area', () => {
		const inside = box(21.02, -33.98, 21.03, -33.97);
		const { fields, failed } = clipFields([field('a', inside)], AREA);
		expect(failed).toBe(0);
		expect(fields).toHaveLength(1);
		expect(fields[0]).toMatchObject({ id: 'a', crop: 'Apples', irrigated: true });
		expect(fields[0]!.areaHa).toBeCloseTo(ha(inside), 3);
	});

	it('drops a field outside, near or far', () => {
		expect(clipFields([field('far', box(25, -30, 25.1, -29.9)), field('near', box(21.11, -33.98, 21.12, -33.97))], AREA).fields).toEqual([]);
	});

	it('drops a field in the area’s box but in its notch', () => {
		expect(clipFields([field('n', box(21.045, -33.95, 21.055, -33.92))], U).fields).toEqual([]);
	});

	it('cuts a field the boundary crosses, the area from what is left', () => {
		const { fields } = clipFields([field('a', box(21.09, -33.98, 21.11, -33.97))], AREA);
		expect(fields[0]!.areaHa).toBeCloseTo(ha(box(21.09, -33.98, 21.1, -33.97)), 2);
	});

	it('matches the whole-outline boolean on a concave area, where the cut outline runs back on itself', () => {
		for (const g of [box(21.03, -33.95, 21.07, -33.93), box(21.05, -33.97, 21.07, -33.94), box(21.02, -33.99, 21.08, -33.91)]) {
			const { fields, failed } = clipFields([field('a', g)], U);
			expect(failed).toBe(0);
			expect(fields[0]!.areaHa).toBeCloseTo(ha(intersectGeometry(g, U)!), 2);
		}
	});

	it('takes a field that is itself two parts, and a hole in the area', () => {
		const two: AreaGeometry = { type: 'MultiPolygon', coordinates: [box(21.09, -33.98, 21.11, -33.97).coordinates, box(21.02, -33.98, 21.03, -33.97).coordinates] as never };
		expect(clipFields([field('a', two)], AREA).fields[0]!.areaHa).toBeCloseTo(ha(box(21.09, -33.98, 21.1, -33.97)) + ha(box(21.02, -33.98, 21.03, -33.97)), 2);
		const holed: AreaGeometry = { type: 'Polygon', coordinates: [box(21, -34, 21.1, -33.9).coordinates[0]!, box(21.04, -33.96, 21.06, -33.94).coordinates[0]!] as never };
		expect(clipFields([field('in', box(21.045, -33.955, 21.055, -33.945))], holed).fields).toEqual([]);
		expect(clipFields([field('edge', box(21.03, -33.955, 21.05, -33.945))], holed).fields[0]!.areaHa).toBeCloseTo(ha(box(21.03, -33.955, 21.04, -33.945)), 2);
	});

	it('keeps shapes to 1e-6° for the wire, the area computed before rounding', () => {
		const { fields } = clipFields([field('a', box(21.012345678, -33.98, 21.02, -33.97))], AREA);
		expect(fields[0]!.geometry.coordinates.flat(1)[0]).toEqual([21.012346, -33.98]);
	});

	it('runs the deadline check between fields', () => {
		const stop = new Error('late');
		expect(() => clipFields([field('a', AREA)], AREA, () => { throw stop; })).toThrow(stop);
	});

	it('fits the route’s deadline on the longest boundary it takes: thousands of fields against 10 000 vertices', { timeout: CFM_DEADLINE_MS }, () => {
		const n = 10_000;
		const ring = Array.from({ length: n }, (_, i): [number, number] => {
			const t = (2 * Math.PI * i) / n;
			return [21.5 + (0.4 + 0.02 * Math.sin(40 * t)) * Math.cos(t), -33.9 + (0.4 + 0.02 * Math.sin(40 * t)) * Math.sin(t)];
		});
		ring.push(ring[0]!);
		const area: AreaGeometry = { type: 'Polygon', coordinates: [ring] };
		const fields: LayerField[] = [];
		for (let x = 0; x < 50; x++) for (let y = 0; y < 50; y++) fields.push(field(`${x}-${y}`, box(21 + x * 0.02, -34.4 + y * 0.02, 21.008 + x * 0.02, -34.392 + y * 0.02)));
		const out = clipFields(fields, area);
		expect(out.failed).toBe(0);
		expect(out.fields.length).toBeGreaterThan(1_000);
	});
});
