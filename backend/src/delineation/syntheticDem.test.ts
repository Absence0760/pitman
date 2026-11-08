// The invented terrain and its archive: read back through the real readers, it is the same terrain.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { toLonLat } from './delineate.js';
import { openDem } from './dem.js';
import { SYNTHETIC_DEM, syntheticDem, syntheticDemArchive, syntheticElevation, syntheticTile, syntheticTileRange } from './syntheticDem.js';

describe('the synthetic terrain', () => {
	it('is deterministic, and a plausible height everywhere', () => {
		expect(syntheticElevation(21.3, -33.9)).toBe(syntheticElevation(21.3, -33.9));
		for (let lon = 20.92; lon < 22.02; lon += 0.05) {
			for (let lat = -34.55; lat < -33.43; lat += 0.05) {
				const z = syntheticElevation(lon, lat);
				expect(z).toBeGreaterThan(0);
				expect(z).toBeLessThan(1500);
			}
		}
	});

	it('has a ridge between quaternaries and a river down each column', () => {
		expect(syntheticElevation(21.25, -33.6)).toBeGreaterThan(syntheticElevation(21.2, -33.6));
		expect(syntheticElevation(21.2, -33.6)).toBeGreaterThan(syntheticElevation(21.13, -33.6));
		// The divide at the heads: both sides fall away from it.
		expect(syntheticElevation(21.2, -33.5)).toBeGreaterThan(syntheticElevation(21.2, -33.52));
		expect(syntheticElevation(21.2, -33.5)).toBeGreaterThan(syntheticElevation(21.2, -33.48));
	});

	it('draws a tile exactly as syntheticElevation draws each cell, to the bit', () => {
		const { x0, y0 } = syntheticTileRange();
		const { tile, zoom } = SYNTHETIC_DEM;
		const W = 2 ** zoom * tile;
		// The northern divide and the tributary (x0, y0); the sill at 33.75° S, a river and a ridge between columns (x0 + 2, y0 + 2).
		// Whole rows, since syntheticTile carries state along a row (the river's column), every 4th of them: the sill is 35 rows wide.
		for (const [x, y] of [
			[x0, y0],
			[x0 + 2, y0 + 2]
		] as const) {
			const drawn = syntheticTile(x, y);
			let differing = 0;
			for (let py = 0; py < tile; py += 4) {
				const lat = toLonLat(0, y * tile + py + 0.5, W)[1];
				for (let px = 0; px < tile; px++) {
					const lon = ((x * tile + px + 0.5) / W) * 360 - 180;
					if (drawn[py * tile + px] !== Math.fround(Math.round(syntheticElevation(lon, lat) * 8) / 8)) differing++;
				}
			}
			expect(differing).toBe(0);
		}
	});

	it('covers the same invented block as the CHIRPS copy and the MAP grid, in the real DEM’s tiles', () => {
		expect(SYNTHETIC_DEM.bounds).toEqual([21, -34.5, 22, -33.5]);
		expect([SYNTHETIC_DEM.zoom, SYNTHETIC_DEM.tile]).toEqual([11, 512]);
		const { x0, x1, y0, y1 } = syntheticTileRange();
		expect((x1 - x0 + 1) * (y1 - y0 + 1)).toBe(56);
	});
});

describe('the archive', () => {
	it('reads back through openDem as the terrain, rounded to the stored step', async () => {
		const { x0, y0 } = syntheticTileRange();
		const archive = syntheticDemArchive({ x0, x1: x0, y0, y1: y0 });
		const file = join(mkdtempSync(join(tmpdir(), 'pitman-dem-')), 'one.pmtiles');
		writeFileSync(file, archive);
		const dem = openDem(file);
		const info = await dem.info();
		expect(info).toMatchObject({ label: `${SYNTHETIC_DEM.name} ${SYNTHETIC_DEM.version}`, attribution: 'Synthetic test data', tileType: 'png', maxZoom: 11, bounds: SYNTHETIC_DEM.bounds });
		const tile = await dem.tile(11, x0, y0);
		expect(tile?.size).toBe(512);
		const expected = syntheticTile(x0, y0);
		for (let i = 0; i < expected.length; i += 997) expect(tile!.z[i]).toBeCloseTo(expected[i]!, 2);
		expect(await dem.tile(11, x0 + 1, y0)).toBeNull();
		expect(readFileSync(file).length).toBe(archive.length);
	});

	it('has no tile past the block, as the function-backed DEM has none', async () => {
		const { x1 } = syntheticTileRange();
		expect(await syntheticDem().tile(11, x1 + 1, 1228)).toBeNull();
		expect(await syntheticDem().tile(10, 571, 613)).toBeNull();
	});
});
