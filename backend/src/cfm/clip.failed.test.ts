// A boolean that throws (a ring it can't take) counts the field and says so: the area must not fall quietly.
import type { AreaGeometry } from '@pitman/wrsm';
import { describe, expect, it, vi } from 'vitest';
import { clipFields } from './clip.js';

vi.mock('@pitman/wrsm', async (original) => ({
	...(await original<typeof import('@pitman/wrsm')>()),
	intersectGeometry: () => {
		throw new Error('Unable to complete output ring');
	}
}));

const box = (w: number, s: number, e: number, n: number): AreaGeometry => ({ type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });

describe('clipFields', () => {
	it('counts a field it couldn’t cut, and keeps the others', () => {
		const fields = [
			{ id: 'edge', crop: 'Apples', irrigated: true, geometry: box(21.09, -33.98, 21.11, -33.97) },
			{ id: 'inside', crop: 'Apples', irrigated: true, geometry: box(21.02, -33.98, 21.03, -33.97) }
		];
		const out = clipFields(fields, box(21, -34, 21.1, -33.9));
		expect(out.failed).toBe(1);
		expect(out.fields.map((f) => f.id)).toEqual(['inside']);
	});
});
