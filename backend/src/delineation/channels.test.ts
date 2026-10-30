// Copied from IC-WBT backend/src/delineation/channels.test.ts at f888e4461 (MIT, same author).
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { channelTile, CHANNEL_TILE_DEG, tileBounds, traceChannels } from './channels.js';
import { openDem } from './dem.js';
import { DelineationRefused } from './delineate.js';
import { DAM_CELL, fixtureLonLat } from './fixture.js';
import { accumulate, OUT } from './flow.js';

// D8 codes (flow.ts DX/DY): 0 east, 2 south, 4 west.
const E = 0;
const S = 2;
const W = 4;

/** A 9 × 8 grid: a river south down column 4 to the bottom edge, a tributary joining it from the east along row 3, everything else draining into one of them. */
function grid() {
	const nx = 9;
	const ny = 8;
	const dir = new Uint8Array(nx * ny);
	const edge = new Uint8Array(nx * ny);
	for (let y = 0; y < ny; y++)
		for (let x = 0; x < nx; x++) {
			const i = y * nx + x;
			if (x === 0 || y === 0 || x === nx - 1 || y === ny - 1) {
				edge[i] = 1;
				dir[i] = OUT;
			} else if (x === 4) dir[i] = S;
			else if (y === 3 && x > 4) dir[i] = W;
			else dir[i] = x < 4 ? E : y < 3 ? S : 2;
		}
	return { nx, ny, dir, edge, acc: accumulate(nx, ny, dir) };
}

describe('traceChannels', () => {
	it('splits the network at the confluence: the river above it, the tributary, and the river below', () => {
		const g = grid();
		const lines = traceChannels(g.nx, g.ny, g.dir, g.acc, g.edge, 5, () => true);
		const cells = lines.map((l) => l.cells.map((c) => [c % g.nx, Math.floor(c / g.nx)]));
		// Every line ends where the next begins or at the last channel cell above the edge.
		expect(cells.some((l) => l[0]![0] === 4 && l.at(-1)![1] === 3)).toBe(true); // the river down to the confluence
		expect(cells.some((l) => l.at(-1)![0] === 4 && l.at(-1)![1] === 3 && l[0]![0]! > 4)).toBe(true); // the tributary into it
		expect(cells.some((l) => l[0]![0] === 4 && l[0]![1] === 3 && l.at(-1)![1] === 6)).toBe(true); // below the confluence
		// Each line carries the accumulation at its lower end; the line below the confluence carries the most.
		const below = lines.find((l) => l.cells[0] === 3 * g.nx + 4)!;
		expect(below.acc).toBe(Math.max(...lines.map((l) => l.acc)));
	});

	it('keeps only the steps that start inside the box, so neighbouring tiles meet without overlapping', () => {
		const g = grid();
		const top = traceChannels(g.nx, g.ny, g.dir, g.acc, g.edge, 5, (_, y) => y < 4);
		const bottom = traceChannels(g.nx, g.ny, g.dir, g.acc, g.edge, 5, (_, y) => y >= 4);
		const steps = (ls: typeof top) => ls.flatMap((l) => l.cells.slice(0, -1).map((c, i) => `${c}>${l.cells[i + 1]}`));
		const all = steps(traceChannels(g.nx, g.ny, g.dir, g.acc, g.edge, 5, () => true));
		expect(new Set([...steps(top), ...steps(bottom)])).toEqual(new Set(all));
		expect(steps(top).filter((s) => steps(bottom).includes(s))).toEqual([]);
	});

	it('draws nothing below the threshold', () => {
		const g = grid();
		expect(traceChannels(g.nx, g.ny, g.dir, g.acc, g.edge, 1000, () => true)).toEqual([]);
	});
});

describe('channelTile (synthetic DEM)', () => {
	const dem = openDem(fileURLToPath(new URL('../../fixtures/dem/synthetic-dem.pmtiles', import.meta.url)));
	const [lon, lat] = fixtureLonLat(DAM_CELL.x + 0.5, DAM_CELL.y + 60.5);
	const tile: [number, number] = [Math.floor(lon / CHANNEL_TILE_DEG), Math.floor(lat / CHANNEL_TILE_DEG)];

	it('draws the valley’s river through the tile, the biggest line near the river axis, every line starting inside the tile', async () => {
		const t = await channelTile(dem, tile, { window: 1024 });
		expect(t.bounds).toEqual(tileBounds(tile));
		expect(t.lines.length).toBeGreaterThan(5);
		const big = t.lines.reduce((a, b) => (b.km2 > a.km2 ? b : a));
		expect(big.km2).toBeGreaterThan(100);
		// On the river: its points within a few cells of the valley's axis.
		const axis = fixtureLonLat(DAM_CELL.x + 0.5, DAM_CELL.y)[0];
		for (const [x] of big.coordinates) expect(Math.abs(x - axis)).toBeLessThan(0.005);
		const [w, s, e, n] = t.bounds;
		for (const l of t.lines) {
			const [x, y] = l.coordinates[0]!;
			expect(x >= w - 0.002 && x <= e + 0.002 && y >= s - 0.002 && y <= n + 0.002).toBe(true);
		}
		expect(t.minKm2).toBe(1);
		expect(t.dataset.fingerprint).toMatch(/^[0-9a-f]{16}$/);
	});

	it('refuses a tile outside the DEM', async () => {
		const e = await channelTile(dem, [125, -150]).catch((x: unknown) => x);
		expect(e).toBeInstanceOf(DelineationRefused);
		expect((e as DelineationRefused).code).toBe('outside');
	});
});
