// Copied from IC-WBT backend/src/delineation/place.test.ts at f888e4461 (MIT, same author).
import { describe, expect, it } from 'vitest';
import { CHANNEL_MIN_KM2 } from './channels.js';
import { GUARD_RADIUS_M, LARGER_FACTOR, ON_CHANNEL_KM2, place, type PlaceGrid } from './place.js';

// Hand-made accumulation grids with 100 m cells (0.01 km² each, so a terrain
// channel, ON_CHANNEL_KM2, is 100 cells or more): a river down column 20 whose
// upstream cells grow southward, everything else a slope draining one cell.

const N = 41;
const CELL = 100;
function grid(): PlaceGrid & { at: (x: number, y: number) => number } {
	const acc = new Int32Array(N * N).fill(1);
	const at = (x: number, y: number) => y * N + x;
	// The river: 10 000 cells (100 km²) at row 0, growing by 100 a row.
	for (let y = 0; y < N; y++) acc[at(20, y)] = 10_000 + 100 * y;
	const edge = new Uint8Array(N * N);
	for (let i = 0; i < N; i++) edge[at(i, 0)] = edge[at(i, N - 1)] = edge[at(0, i)] = edge[at(N - 1, i)] = 1;
	return { nx: N, ny: N, acc, edge, cellSizeM: CELL, at };
}

describe('place: on the terrain channel nearest the click (issue #472)', () => {
	it('keeps a click on the channel on its own cell', () => {
		const g = grid();
		const p = place(g, 20.5, 20.5, { snapRadiusM: 150 })!;
		expect(p).toEqual({ cell: g.at(20, 20), distanceM: 0, larger: null });
	});

	it('moves a click beside the channel straight across onto it, not down it to a more-drained cell', () => {
		const g = grid();
		const p = place(g, 21.5, 20.5, { snapRadiusM: 150 })!;
		expect(p.cell).toBe(g.at(20, 20));
		expect(p.distanceM).toBeCloseTo(100, 6);
	});

	it('takes the nearest channel, not the most-drained one: a click on a tributary beside the river stays on the tributary', () => {
		const g = grid();
		// A 1.5 km² tributary at column 22, 200 m from the river; the click 80 m from it and 120 m from the river.
		g.acc[g.at(22, 20)] = 150;
		const p = place(g, 21.7, 20.5, { snapRadiusM: 150 })!;
		expect(p.cell).toBe(g.at(22, 20));
	});

	it('refuses a point with no terrain channel within the radius, however much a slope or gully there drains', () => {
		const g = grid();
		// A gully of 0.99 km² at the click, under the channel threshold; the river 400 m off.
		g.acc[g.at(24, 20)] = 99;
		expect(place(g, 24.5, 20.5, { snapRadiusM: 150 })).toBeNull();
	});

	it('takes a gully as soon as it drains the threshold', () => {
		const g = grid();
		g.acc[g.at(24, 20)] = 100;
		expect(place(g, 24.5, 20.5, { snapRadiusM: 150 })!.cell).toBe(g.at(24, 20));
	});

	it('of two channel cells as near, takes the one that drains more', () => {
		const g = grid();
		// The click exactly between the river (column 20) and a tributary at column 22.
		g.acc[g.at(22, 20)] = 150;
		const p = place(g, 21.5, 20.5, { snapRadiusM: 150 })!;
		expect(p.cell).toBe(g.at(20, 20));
	});

	it('never takes an edge cell', () => {
		const g = grid();
		g.edge.fill(1);
		expect(place(g, 20.5, 20.5, { snapRadiusM: 150 })).toBeNull();
	});

	it('the channel threshold is the Map’s red lines’ (channels.ts)', () => {
		expect(ON_CHANNEL_KM2).toBe(CHANNEL_MIN_KM2);
	});
});

describe('place: the larger-channel guard (the DEM alone)', () => {
	it('names a channel with 100× the placed cell’s cells within 1 km', () => {
		const g = grid();
		// A 1.2 km² stream at column 25; the click 200 m east of it (off the line), the river 600 m west.
		g.acc[g.at(25, 20)] = 120;
		const p = place(g, 27.5, 20.5, { snapRadiusM: 250 })!;
		expect(p.cell).toBe(g.at(25, 20));
		expect(p.larger).not.toBeNull();
		// The river's cell nearest the click, straight across, not its most-drained one 1 km downstream.
		expect(p.larger!.cell).toBe(g.at(20, 20));
		expect(p.larger!.distanceM).toBeCloseTo(700, 6);
		expect(g.acc[p.larger!.cell]!).toBeGreaterThanOrEqual(LARGER_FACTOR * 120);
		expect(p.larger!.distanceM).toBeLessThanOrEqual(GUARD_RADIUS_M);
	});

	it('names it for a click right on the small channel too, never moving there by itself', () => {
		const g = grid();
		g.acc[g.at(25, 20)] = 120;
		const p = place(g, 25.5, 20.5, { snapRadiusM: 250 })!;
		expect(p.cell).toBe(g.at(25, 20));
		expect(p.larger!.cell).toBe(g.at(20, 20));
	});

	it('names nothing for a click on the big channel itself', () => {
		expect(place(grid(), 20.5, 20.5, { snapRadiusM: 150 })!.larger).toBeNull();
	});

	it('names nothing when the channel nearby is under 100× larger', () => {
		const g = grid();
		g.acc[g.at(25, 20)] = 200; // 200 × 100 = 20 000 > the river's ~12 000
		expect(place(g, 27.5, 20.5, { snapRadiusM: 250 })!.larger).toBeNull();
	});
});

describe('place: brute force at the DEM’s cell sizes', () => {
	// Cell sizes the DEM is read at: zoom 11 with 512 px tiles (TARGET_ZOOM, GLO-30 via Mapterhorn) at the equator and across
	// South Africa's latitudes, and the synthetic fixture's 128 m (zoom 10, 256 px).
	const W11 = 2 ** 11 * 512;
	const cellAt = (lat: number) => (2 * Math.PI * 6378137 * Math.cos((lat * Math.PI) / 180)) / W11;
	const SIZES = [...[0, -22, -28, -34.5].map((lat) => [`zoom 11 at ${lat}°`, cellAt(lat)] as const), ['the fixture’s 128 m', 127.6] as const];

	/** A deterministic pseudo-random sequence (mulberry32). */
	function rng(seed: number) {
		return () => {
			seed |= 0;
			seed = (seed + 0x6d2b79f5) | 0;
			let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	}

	it.each(SIZES)('%s: the nearest terrain-channel cell within 150 m of the exact click, or none', (_, cellSizeM) => {
		const n = 31;
		const rand = rng(Math.round(cellSizeM * 1000));
		const minCells = (ON_CHANNEL_KM2 * 1e6) / (cellSizeM * cellSizeM);
		let placed = 0;
		let refused = 0;
		for (let k = 0; k < 400; k++) {
			const acc = new Int32Array(n * n);
			// About one cell in eight a channel cell: some clicks have one in reach, some don't.
			for (let i = 0; i < acc.length; i++) acc[i] = rand() < 0.04 ? Math.ceil(minCells * (1 + rand() * 100)) : 1 + Math.floor(rand() * minCells * 0.99);
			const edge = new Uint8Array(n * n);
			const cx = 15 + rand();
			const cy = 15 + rand();
			const p = place({ nx: n, ny: n, acc, edge, cellSizeM }, cx, cy, { snapRadiusM: 150 });
			let best = Infinity;
			for (let j = 0; j < acc.length; j++) {
				const jx = j % n;
				const jy = (j - jx) / n;
				const d = Math.hypot(jx + 0.5 - cx, jy + 0.5 - cy) * cellSizeM;
				if (acc[j]! >= minCells && d <= 150) best = Math.min(best, d);
			}
			if (best === Infinity) {
				expect(p).toBeNull();
				refused++;
				continue;
			}
			placed++;
			expect(p).not.toBeNull();
			expect(acc[p!.cell]!).toBeGreaterThanOrEqual(minCells);
			expect(p!.distanceM).toBeCloseTo(best, 9);
			expect(p!.distanceM).toBeLessThanOrEqual(150);
		}
		// Both outcomes exercised.
		expect(placed).toBeGreaterThan(20);
		expect(refused).toBeGreaterThan(20);
	});
});
