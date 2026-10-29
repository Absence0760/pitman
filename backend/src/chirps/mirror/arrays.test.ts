// The finals reader (arrays.ts) on the committed fixture copy: its layout, a block read with the leap
// day's slot, unwritten chunks and years outside the array as NaN, and a copy laid out differently
// refused.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AbsolutePath } from '@zarrita/storage';
import { describe, expect, it } from 'vitest';
import { FIXTURE_MIRROR_DIR } from '../../__tests__/fakeS3.js';
import { MirrorFormatError, openFinals, readFinalsBlock } from './arrays.js';
import { openStore } from './store.js';

const fixture = openStore(`file://${FIXTURE_MIRROR_DIR}`);
/** The fixture's land cell at the grid's north-west corner (IC-WBT readCells.test.ts LAND_NW), and its sea cell. */
const LAND = { y0: 309, x0: 300, h: 1, w: 1 };
const SEA = { y0: 304, x0: 307, h: 1, w: 1 };

describe('openFinals / readFinalsBlock on the fixture copy', () => {
	it('opens rnl on D1 from 1981, and reads a store without it as not held', async () => {
		const f = (await openFinals(fixture, 'rnl'))!;
		expect(f).toMatchObject({ firstYear: 1981, region: { w: 10, s: -35.5, e: 41, n: -8 }, grid: { origin: { lat: -35.475, lon: 10.025 }, step: 0.05 } });
		expect(f.arr.shape).toEqual([45, 366, 550, 620]);
		expect(await openFinals(openStore(`file://${FIXTURE_MIRROR_DIR}rnl/`), 'rnl')).toBeNull();
	});

	it('holds 366 values in 2024 and 365 in 2023 (slot 365 NaN) for a land cell; NaN for the sea cell', async () => {
		const f = (await openFinals(fixture, 'rnl'))!;
		const leap = await readFinalsBlock(f, 2024, 0, 365, LAND);
		expect(leap.values.every(Number.isFinite)).toBe(true);
		const plain = await readFinalsBlock(f, 2023, 0, 365, LAND);
		expect(plain.values.subarray(0, 365).every(Number.isFinite)).toBe(true);
		expect(Number.isNaN(plain.values[365]!)).toBe(true);
		expect((await readFinalsBlock(f, 2024, 0, 365, SEA)).values.every(Number.isNaN)).toBe(true);
	});

	it('reads an unwritten chunk, a year before the copy’s data and a year past the array as NaN', async () => {
		const f = (await openFinals(fixture, 'rnl'))!;
		expect((await readFinalsBlock(f, 2024, 0, 30, { y0: 0, x0: 0, h: 2, w: 2 })).values.every(Number.isNaN)).toBe(true);
		expect((await readFinalsBlock(f, 1990, 0, 30, LAND)).values.every(Number.isNaN)).toBe(true);
		expect((await readFinalsBlock(f, 2030, 0, 30, LAND)).values.every(Number.isNaN)).toBe(true);
		await expect(readFinalsBlock(f, 2024, 0, 366, LAND)).rejects.toThrow(RangeError);
		await expect(readFinalsBlock(f, 2024, 0, 1, { y0: 549, x0: 0, h: 2, w: 1 })).rejects.toThrow(/outside the region/);
	});

	it('refuses an array laid out differently (chunks, codecs, grid)', async () => {
		const meta = JSON.parse(readFileSync(join(FIXTURE_MIRROR_DIR, 'rnl/zarr.json'), 'utf8'));
		const tampered = (change: (m: typeof meta) => void) => {
			const m = structuredClone(meta);
			change(m);
			const bytes = new TextEncoder().encode(JSON.stringify(m));
			return { get: (k: AbsolutePath) => (k === '/rnl/zarr.json' ? Promise.resolve(bytes) : fixture.get(k)) };
		};
		await expect(openFinals(tampered((m) => (m.chunk_grid.configuration.chunk_shape = [1, 366, 10, 10])), 'rnl')).rejects.toThrow(MirrorFormatError);
		await expect(openFinals(tampered((m) => (m.codecs[1].configuration.level = 9)), 'rnl')).rejects.toThrow(/codecs/);
		await expect(openFinals(tampered((m) => (m.attributes.grid.origin.lat = -35.5)), 'rnl')).rejects.toThrow(/grid/);
	});
});
