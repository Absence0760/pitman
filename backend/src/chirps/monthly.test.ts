// chirpsMonthly (docs/data.md § CHIRPS steps 1–4) on the fixture copy: the contract's shape, every month
// from January 1981 to finalThrough, the sea cell removed with its weight, months the copy doesn't hold
// missing, and the refusals (outside the region, too many cells, no data under the area).
import { describe, expect, it } from 'vitest';
import { FIXTURE_MIRROR_DIR } from '../__tests__/fakeS3.js';
import type { Geometry } from '../geo/geojson.js';
import { ChirpsCopy, chirpsCopyConfig } from './copy.js';
import { AreaRefusedError, CHIRPS_PRODUCT, chirpsMonthly } from './monthly.js';

const copy = () => new ChirpsCopy(chirpsCopyConfig({ CHIRPS_SOURCE: 'local', CHIRPS_LOCAL_DIR: FIXTURE_MIRROR_DIR })).open();
const box = (w: number, s: number, e: number, n: number): Geometry => ({ type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });
/** The fixture grid's 8 × 10 written cells (mirror y 300–309, x 300–307), its sea cell among them. */
const GRID = box(25.0, -20.5, 25.4, -20.0);

describe('chirpsMonthly on the fixture copy', () => {
	it('answers in the contract’s shape: every month from 1981-01 to finalThrough, in order', async () => {
		const r = await chirpsMonthly(await copy(), GRID);
		expect(r).toMatchObject({ product: CHIRPS_PRODUCT, revision: 1, finalThrough: '2025-12-31', source: 'local' });
		expect(r.months).toHaveLength(45 * 12);
		expect(r.months[0]).toMatchObject({ year: 1981, month: 1 });
		expect(r.months.at(-1)).toMatchObject({ year: 2025, month: 12 });
		r.months.forEach((m, k) => expect([m.year, m.month]).toEqual([1981 + Math.floor(k / 12), (k % 12) + 1]));
		expect(r.areaKm2).toBeGreaterThan(2300);
		expect(r.areaKm2).toBeLessThan(2330);
	});

	it('removes the sea cell with its share of the weight, and leaves the years the copy doesn’t hold missing', async () => {
		const r = await chirpsMonthly(await copy(), GRID);
		expect(r.cells).toBe(79);
		expect(r.weightRemovedPct).toBeGreaterThan(1);
		expect(r.weightRemovedPct).toBeLessThan(1.4);
		const held = r.months.filter((m) => m.year >= 2023);
		expect(held.every((m) => typeof m.mm === 'number' && m.mm >= 0)).toBe(true);
		expect(r.months.filter((m) => m.year < 2023).every((m) => m.mm === null)).toBe(true);
	});

	it('refuses an area outside the copy’s region, over the cell limit, or with no data under it', async () => {
		const c = await copy();
		await expect(chirpsMonthly(c, box(5, -20.5, 5.2, -20))).rejects.toThrow(/outside the CHIRPS copy/);
		await expect(chirpsMonthly(c, box(20, -34, 23, -31))).rejects.toThrow(/covers 3600 of the 0.05° CHIRPS cells/);
		await expect(chirpsMonthly(c, box(30, -30, 30.2, -29.8))).rejects.toThrow(AreaRefusedError);
		await expect(chirpsMonthly(c, box(30, -30, 30.2, -29.8))).rejects.toThrow(/no data under the area/);
	});
});
