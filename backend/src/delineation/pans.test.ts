// Copied from IC-WBT backend/src/delineation/pans.test.ts at f888e4461 (MIT, same author).
import { describe, expect, it } from 'vitest';
import { accumulate, d8, edgeMask, fill, upstream } from './flow.js';
import {
	findPans,
	ncAreaM2,
	ON_RIVER_METHOD,
	ON_RIVER_MIN_DRAINS_M2,
	PAN_METHOD,
	PAN_MIN_DEPTH_M,
	PAN_MIN_FLOOR_M2,
	PAN_MIN_STORAGE_MM,
	panReport,
	panWarning,
	type PanReference
} from './pans.js';

// A 60 × 60 grid of 100 m cells (10 000 m² each), a plane rising 0.5 m a row northwards and 1 m a column away from the
// middle column, draining south to an outlet on it; and closed depressions cut into it where a test puts them.
const N = 60;
const CELL_M2 = 10_000;
const OUTLET = (N - 2) * N + 30;
const plane = (x: number, y: number) => 100 + 0.5 * (N - y) + Math.abs(x - 30);

/**
 * A disc of radius r round (cx, cy) whose flat floor lies `depth` below the plane's lowest point just outside it. `wall`: every
 * row from `at` southwards `drop` m lower, a scarp across the plane, as the river bed below a dam's wall lies.
 */
function grid(discs: { cx: number; cy: number; r: number; depth: number }[], wall?: { at: number; drop: number }) {
	const z = new Float64Array(N * N);
	for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) z[y * N + x] = plane(x, y) - (wall && y >= wall.at ? wall.drop : 0);
	for (const d of discs) {
		let rim = Infinity;
		for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (Math.hypot(x - d.cx, y - d.cy) >= d.r && Math.hypot(x - d.cx, y - d.cy) < d.r + 1.5) rim = Math.min(rim, plane(x, y));
		for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (Math.hypot(x - d.cx, y - d.cy) < d.r) z[y * N + x] = rim - d.depth;
	}
	const before = new Float32Array(z);
	const g = { nx: N, ny: N, z };
	const edge = edgeMask(g);
	fill(g, edge);
	const dir = d8(g, edge);
	const acc = accumulate(N, N, dir);
	const mask = upstream(N, N, dir, OUTLET);
	const rowM2 = new Float64Array(N).fill(CELL_M2);
	const inDisc = (i: number, d: (typeof discs)[number]) => Math.hypot((i % N) - d.cx, Math.floor(i / N) - d.cy) < d.r;
	// On the map a cell is its column and row; a position's place on the grid is that cell's centre.
	const toPos = (c: number): [number, number] => [c % N, Math.floor(c / N)];
	const toGrid = (p: readonly number[]): [number, number] => [p[0]! + 0.5, p[1]! + 0.5];
	return { pg: { nx: N, ny: N, before, after: z, dir, acc, mask, rowM2, toPos, toGrid }, dir, acc, inDisc };
}

/** Cells whose D8 path enters the disc (the disc's own included): what drains into it, counted independently of pans.ts. */
function drainsInto(dir: Uint8Array, inside: (i: number) => boolean): number {
	let n = 0;
	for (let i = 0; i < N * N; i++) {
		for (let c = i, guard = 0; c >= 0 && guard < N * N; guard++) {
			if (inside(c)) {
				n++;
				break;
			}
			const d = dir[c]!;
			if (d === 255) break;
			const dx = [1, 1, 0, -1, -1, -1, 0, 1][d]!;
			const dy = [0, 1, 1, 1, 0, -1, -1, -1][d]!;
			c = c + dy * N + dx;
		}
	}
	return n;
}

describe('findPans', () => {
	it('marks a pan and everything draining into it, nothing below it, and measures it', async () => {
		const pan = { cx: 30, cy: 12, r: 4, depth: 3 };
		const { pg, dir } = grid([pan]);
		const { nc, pans } = await findPans(pg, [OUTLET], 3);
		expect(pans).toHaveLength(1);
		const p = pans[0]!;
		const expected = drainsInto(dir, (i) => Math.hypot((i % N) - pan.cx, Math.floor(i / N) - pan.cy) < pan.r);
		expect(ncAreaM2(N, nc, pg.rowM2)).toBe(expected * CELL_M2);
		expect(p.drainsM2).toBe(expected * CELL_M2);
		// The disc's floor: the 45 cells inside radius 4, all raised.
		expect(p.floorM2).toBe(45 * CELL_M2);
		expect(p.depthM).toBeGreaterThanOrEqual(pan.depth);
		expect(p.storageMm).toBeGreaterThan(PAN_MIN_STORAGE_MM);
		// North of the pan drains into it; the river below it doesn't.
		expect(nc[2 * N + 30]).toBe(1);
		expect(nc[40 * N + 30]).toBe(0);
		expect(nc[OUTLET]).toBe(0);
	});

	it('is not a pan when shallower than PAN_MIN_DEPTH_M, smaller than PAN_MIN_FLOOR_M2, or holding under PAN_MIN_STORAGE_MM of its catchment', async () => {
		// Positive control first: the same disc, deep enough, is one.
		expect((await findPans(grid([{ cx: 30, cy: 12, r: 4, depth: 3 }]).pg, [OUTLET], 3)).pans).toHaveLength(1);
		const shallow = await findPans(grid([{ cx: 30, cy: 12, r: 4, depth: PAN_MIN_DEPTH_M / 3 }]).pg, [OUTLET], 3);
		expect(shallow.pans).toHaveLength(0);
		expect(shallow.nc.every((v) => v === 0)).toBe(true);
		// Radius 1.5: 9 cells, 0.09 km², under the 0.1 km² floor.
		expect(9 * CELL_M2).toBeLessThan(PAN_MIN_FLOOR_M2);
		expect((await findPans(grid([{ cx: 30, cy: 12, r: 1.5, depth: 5 }]).pg, [OUTLET], 3)).pans).toHaveLength(0);
		// Low on the river, 1.5 m deep: it holds a few mm over the valley above it, as a dam drawn down below its spillway does.
		const low = grid([{ cx: 30, cy: 45, r: 4, depth: 1.5 }]);
		// Deep and wide enough: only its storage keeps it out.
		let floor = 0;
		let deepest = 0;
		low.pg.after.forEach((v, i) => {
			const d = v - low.pg.before[i]!;
			if (d > 0.001) (floor += CELL_M2), (deepest = Math.max(deepest, d));
		});
		expect(deepest).toBeGreaterThanOrEqual(PAN_MIN_DEPTH_M);
		expect(floor).toBeGreaterThanOrEqual(PAN_MIN_FLOOR_M2);
		expect((await findPans(low.pg, [OUTLET], 3)).pans).toHaveLength(0);
	});

	it('never counts a depression at a point, or spilling into one close by: the point’s own basin', async () => {
		const pan = { cx: 30, cy: 12, r: 4, depth: 3 };
		const { pg, dir, acc } = grid([pan]);
		const inside = 12 * N + 30;
		expect((await findPans(pg, [OUTLET, inside], 3)).pans).toHaveLength(0);
		// Its spill: the cell below the disc's most-drained cell. A point there takes the pan as its own basin; one far down doesn't.
		let exit = inside;
		for (let i = 0; i < N * N; i++) if (Math.hypot((i % N) - pan.cx, Math.floor(i / N) - pan.cy) < pan.r && acc[i]! > acc[exit]!) exit = i;
		const below = exit + N * [0, 1, 1, 1, 0, -1, -1, -1][dir[exit]!]! + [1, 1, 0, -1, -1, -1, 0, 1][dir[exit]!]!;
		expect((await findPans(pg, [OUTLET, below], 3)).pans).toHaveLength(0);
		expect((await findPans(pg, [OUTLET, below + 20 * N], 3)).pans).toHaveLength(1);
	});

	it('counts two pans once each, the larger catchment first, and a pan above another inside the lower one’s', async () => {
		const { pg } = grid([
			{ cx: 30, cy: 8, r: 3, depth: 3 },
			{ cx: 30, cy: 22, r: 4, depth: 4 }
		]);
		const { nc, pans } = await findPans(pg, [OUTLET], 3);
		expect(pans).toHaveLength(2);
		expect(pans[0]!.drainsM2).toBeGreaterThan(pans[1]!.drainsM2);
		// The lower pan's catchment holds the upper one's: the non-contributing area is the lower's.
		expect(ncAreaM2(N, nc, pg.rowM2)).toBe(pans[0]!.drainsM2);
	});
});

describe('findPans: storage on a river (the cross-check)', () => {
	// Low on the river (the middle column), 5 m deep and 11 cells across: it drains over 10 km² and holds over 100 mm of it, so
	// it passes every pan test, as a large dam low in its catchment does. With `wall`, the river bed below its spill drops past
	// its floor within ON_RIVER_WALL_M, as below a dam's wall; without it, the ground below falls 0.5 m a row, as past a pan's
	// low saddle.
	const DAM = { cx: 30, cy: 30, r: 5.5, depth: 5 };
	const WALL = { at: DAM.cy + 8, drop: 8 };
	/** The river down the middle column, from the top row to the outlet: in its flow direction. */
	const RIVER = Array.from({ length: N - 1 }, (_, y) => [30, y] as [number, number]);
	const ref = (r: Partial<PanReference>) => async () => ({ rivers: [], dams: [], ...r });

	it('passes every pan test on its own (positive control): without a reference it is a pan, and onRiver is not said', async () => {
		const { pg } = grid([DAM], WALL);
		const found = await findPans(pg, [OUTLET], 3);
		expect(found.pans).toHaveLength(1);
		expect(found.pans[0]!.drainsM2).toBeGreaterThanOrEqual(ON_RIVER_MIN_DRAINS_M2);
		expect(found.pans[0]!.storageMm).toBeGreaterThanOrEqual(PAN_MIN_STORAGE_MM);
		expect(found.onRiver).toBeUndefined();
	});

	it('is storage on a river when a mapped river flows through it and out over a wall: listed apart, its area not counted', async () => {
		const { pg } = grid([DAM], WALL);
		const found = await findPans(pg, [OUTLET], 3, ref({ rivers: [{ line: RIVER, directed: true }] }));
		expect(found.pans).toHaveLength(0);
		expect(found.onRiver).toHaveLength(1);
		expect(found.onRiver![0]).toMatchObject({ by: 'river' });
		// Its deepest point is on the disc.
		const [x, y] = found.onRiver![0]!.at;
		expect(Math.hypot(x - DAM.cx, y - DAM.cy)).toBeLessThan(DAM.r);
		expect(found.nc.every((v) => v === 0)).toBe(true);
	});

	it('stays a pan when the river flows out over a low saddle (no wall): HydroRIVERS runs through pans too, being traced on a filled DEM', async () => {
		const { pg } = grid([DAM]);
		const found = await findPans(pg, [OUTLET], 3, ref({ rivers: [{ line: RIVER, directed: true }] }));
		expect(found.pans).toHaveLength(1);
		expect(found.onRiver).toEqual([]);
	});

	it('stays a pan when the river ends in it, or only runs upstream into it, or passes far off', async () => {
		const { pg } = grid([DAM], WALL);
		const ending = RIVER.filter(([, y]) => y <= DAM.cy);
		expect((await findPans(pg, [OUTLET], 3, ref({ rivers: [{ line: ending, directed: true }] }))).pans).toHaveLength(1);
		// The same line drawn the wrong way round, as a network's reach: it flows uphill into it, so not out.
		expect((await findPans(pg, [OUTLET], 3, ref({ rivers: [{ line: [...RIVER].reverse(), directed: true }] }))).pans).toHaveLength(1);
		const far = RIVER.map(([, y]) => [50, y] as [number, number]);
		expect((await findPans(pg, [OUTLET], 3, ref({ rivers: [{ line: far, directed: true }] }))).pans).toHaveLength(1);
	});

	it('takes a drawn river either way round', async () => {
		const { pg } = grid([DAM], WALL);
		const found = await findPans(pg, [OUTLET], 3, ref({ rivers: [{ line: [...RIVER].reverse(), directed: false }] }));
		expect(found.onRiver).toMatchObject([{ by: 'river' }]);
	});

	it('ignores a network reach out of a hollow draining under 10 km² (the reach passes beside it), not a drawn river', async () => {
		// The small disc high up: it drains a few km², under what HydroRIVERS maps a reach for.
		const small = { cx: 30, cy: 12, r: 4, depth: 3 };
		const { pg } = grid([small], { at: small.cy + 7, drop: 6 });
		const network = await findPans(pg, [OUTLET], 3, ref({ rivers: [{ line: RIVER, directed: true }] }));
		expect(network.pans).toHaveLength(1);
		expect(network.pans[0]!.drainsM2).toBeLessThan(ON_RIVER_MIN_DRAINS_M2);
		expect((await findPans(pg, [OUTLET], 3, ref({ rivers: [{ line: RIVER, directed: false }] }))).onRiver).toMatchObject([{ by: 'river' }]);
	});

	it('is a dam’s when a dam lies at its spill or on its floor, or its outline crosses it; not when the dam is elsewhere', async () => {
		const { pg } = grid([DAM]);
		const atSpill = await findPans(pg, [OUTLET], 3, ref({ dams: [[[30, DAM.cy + 7]]] }));
		expect(atSpill.onRiver).toMatchObject([{ by: 'dam' }]);
		expect(atSpill.pans).toHaveLength(0);
		expect((await findPans(pg, [OUTLET], 3, ref({ dams: [[[29, DAM.cy]]] }))).onRiver).toMatchObject([{ by: 'dam' }]);
		const outline: [number, number][] = [[27, DAM.cy - 2], [33, DAM.cy - 2], [33, DAM.cy + 2], [27, DAM.cy + 2], [27, DAM.cy - 2]];
		expect((await findPans(pg, [OUTLET], 3, ref({ dams: [outline] }))).onRiver).toMatchObject([{ by: 'dam' }]);
		expect((await findPans(pg, [OUTLET], 3, ref({ dams: [[[50, 10]]] }))).pans).toHaveLength(1);
	});

	it('asks for the reference only over the depressions that passed, and never when none did', async () => {
		const boxes: [number, number, number, number][][] = [];
		const load = async (b: [number, number, number, number][]) => {
			boxes.push(b);
			return { rivers: [], dams: [] };
		};
		const none = await findPans(grid([]).pg, [OUTLET], 3, load);
		expect(boxes).toHaveLength(0);
		expect(none.onRiver).toEqual([]);
		await findPans(grid([DAM]).pg, [OUTLET], 3, load);
		expect(boxes).toHaveLength(1);
		const [w, s, e, n] = boxes[0]![0]!;
		// The disc and its path down, with their margins, on the test's map (a cell is its column and row).
		expect(w).toBeLessThan(DAM.cx - DAM.r);
		expect(e).toBeGreaterThan(DAM.cx + DAM.r);
		expect(s).toBeLessThan(DAM.cy - DAM.r);
		expect(n).toBeGreaterThan(DAM.cy + DAM.r);
	});
});

describe('panReport and panWarning', () => {
	const pans = [
		{ at: [26.15, -28.29] as [number, number], floorM2: 2_000_123.4, depthM: 4.46, drainsM2: 30_000_000.4, storageMm: 297.6 },
		{ at: [26.2, -28.3] as [number, number], floorM2: 150_000, depthM: 1.2, drainsM2: 2_000_000, storageMm: 120 }
	];
	it('rounds the figures, lists at most five, and carries the method', async () => {
		const r = panReport(31_999_999.6, [...pans, ...pans, ...pans]);
		expect(r.nonContributingM2).toBe(32_000_000);
		expect(r.count).toBe(6);
		expect(r.largest).toHaveLength(5);
		expect(r.largest[0]).toEqual({ at: [26.15, -28.29], floorM2: 2_000_123, depthM: 4.5, drainsM2: 30_000_000, storageMm: 298 });
		expect(r.method).toBe(PAN_METHOD);
		expect(PAN_METHOD).toMatch(/at least 1 m deep .* at least 0\.1 km², .* at least 100 mm/);
	});

	it('lists storage on a river apart, rounded, at most five, and adds the cross-check to the method only when it ran', () => {
		const onRiver = [{ ...pans[0]!, by: 'river' as const }, ...Array.from({ length: 5 }, () => ({ ...pans[1]!, by: 'dam' as const }))];
		const r = panReport(0, [], onRiver);
		expect(r.onRiver!.count).toBe(6);
		expect(r.onRiver!.largest).toHaveLength(5);
		expect(r.onRiver!.largest[0]).toEqual({ at: [26.15, -28.29], floorM2: 2_000_123, depthM: 4.5, drainsM2: 30_000_000, storageMm: 298, by: 'river' });
		expect(r.method).toBe(`${PAN_METHOD} ${ON_RIVER_METHOD}`);
		expect(ON_RIVER_METHOD).toMatch(/ENDORHEIC 0, with at least 10 km² .* within 500 m of the spill \(a wall\)/);
		expect(panReport(0, [], [])).toMatchObject({ onRiver: { count: 0, largest: [] }, method: `${PAN_METHOD} ${ON_RIVER_METHOD}` });
		expect(panReport(0, []).onRiver).toBeUndefined();
	});

	it('says how much drains into pans, where the largest is and which pieces hold it; nothing when none', async () => {
		const r = panReport(32_000_000, pans);
		expect(panWarning(r, 320_000_000, [{ name: 'Upper dam', ncM2: 30_000_000 }, { name: 'Rest of the catchment', ncM2: 2_000_000 }, { name: 'Weir', ncM2: 0 }])).toBe(
			'32 km² of the catchment above the outlet (10 %) drains into 2 pans (closed depressions on the elevation model; the largest at 28.290° S, 26.150° E, 30 km² draining into it). WR2012 counts such endoreic areas as non-contributing; the areas here still include them: 30 km² in Upper dam’s, 2.00 km² in Rest of the catchment’s own area. Choose the effective area beside an area’s tick if you model them as non-contributing.'
		);
		expect(panWarning(panReport(8_500_000, pans.slice(0, 1)), 0, [])).toBe(
			'8.50 km² of the catchment above the outlet drains into a pan (a closed depression on the elevation model, at 28.290° S, 26.150° E, 30 km² draining into it). WR2012 counts such endoreic areas as non-contributing; the areas here still include them. Choose the effective area beside an area’s tick if you model them as non-contributing.'
		);
		expect(panWarning(panReport(0, []), 1e8, [])).toBeNull();
		expect(panWarning(panReport(0, [], []), 1e8, [])).toBeNull();
	});

	it('names storage on a river after the pans, or alone when there are none', () => {
		const one = panReport(0, [], [{ ...pans[0]!, by: 'river' }]);
		expect(panWarning(one, 1e8, [])).toBe(
			'A closed depression at 28.290° S, 26.150° E holds as much as a pan, but a mapped river flows out of it: it is storage on a river, so its 30 km² is not counted as non-contributing.'
		);
		const both = panReport(8_500_000, pans.slice(1), [{ ...pans[0]!, by: 'dam' }, { ...pans[1]!, by: 'river' }]);
		expect(panWarning(both, 0, [])).toMatch(
			/drains into a pan .* Choose the effective area beside an area’s tick if you model them as non-contributing\. 2 closed depressions hold as much as pans, but a mapped river flows out of each or a dam holds it \(the largest at 28\.290° S, 26\.150° E, 30 km² draining into it\): storage on a river, not counted as non-contributing\.$/
		);
	});
});
