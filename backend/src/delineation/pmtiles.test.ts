// Copied from IC-WBT backend/src/delineation/pmtiles.test.ts at f888e4461 (MIT, same author).
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { PmtilesReader, tileId, writePmtiles, type ByteSource } from './pmtiles.js';

const memory =
	(b: Uint8Array): ByteSource =>
	async (o, l) =>
		b.subarray(o, o + l);

describe('PMTiles', () => {
	it('numbers tiles as the spec does (zoom offset, then the Hilbert curve)', () => {
		// The spec's examples: 0/0/0 → 0, 1/0/0 → 1, 1/0/1 → 2, 1/1/1 → 3, 1/1/0 → 4; 2/0/0 → 5.
		expect([tileId(0, 0, 0), tileId(1, 0, 0), tileId(1, 0, 1), tileId(1, 1, 1), tileId(1, 1, 0), tileId(2, 0, 0)]).toEqual([0, 1, 2, 3, 4, 5]);
		expect(tileId(12, 0, 0)).toBe((4 ** 12 - 1) / 3);
		expect(() => tileId(3, 8, 0)).toThrow(/outside/);
	});

	it('reads back what it writes: header, metadata, every tile, and null for a missing one', async () => {
		const tiles = [
			{ z: 10, x: 570, y: 612, data: new Uint8Array([1, 2, 3]) },
			{ z: 10, x: 571, y: 612, data: new Uint8Array([4]) },
			{ z: 10, x: 570, y: 613, data: new Uint8Array([5, 6]) }
		];
		const archive = writePmtiles(tiles, { tileType: 2, bounds: [20, -34, 21, -33], metadata: { name: 'x', version: '2' } });
		const r = new PmtilesReader(memory(archive));
		const h = await r.getHeader();
		expect(h).toMatchObject({ tileType: 2, minZoom: 10, maxZoom: 10, bounds: [20, -34, 21, -33] });
		expect(await r.getMetadata()).toEqual({ name: 'x', version: '2' });
		for (const t of tiles) expect(Array.from((await r.getTile(t.z, t.x, t.y))!)).toEqual(Array.from(t.data));
		expect(await r.getTile(10, 571, 613)).toBeNull();
		expect(await r.getTile(3, 1, 1)).toBeNull();
	});

	it('writes the same bytes on every platform: its gzip parts say Unix, not the OS zlib ran on (macOS wrote 19)', async () => {
		const archive = writePmtiles([{ z: 10, x: 570, y: 612, data: new Uint8Array([1]) }], { tileType: 2, bounds: [20, -34, 21, -33], metadata: { name: 'x' } });
		const h = await new PmtilesReader(memory(archive)).getHeader();
		for (const at of [h.rootOffset, h.metadataOffset]) {
			expect([archive[at], archive[at + 1]]).toEqual([0x1f, 0x8b]);
			expect(archive[at + 9]).toBe(3);
		}
	});

	it('refuses a file that is not PMTiles v3', async () => {
		const r = new PmtilesReader(memory(new Uint8Array(200)));
		await expect(r.getHeader()).rejects.toThrow(/not a PMTiles archive/);
	});

	it('reads the committed synthetic DEM', async () => {
		const b = new Uint8Array(await readFile(new URL('../../fixtures/dem/synthetic-dem.pmtiles', import.meta.url)));
		const r = new PmtilesReader(memory(b));
		expect((await r.getHeader()).tileType).toBe(2);
		expect((await r.getMetadata()).name).toMatch(/Synthetic DEM/);
	});
});
