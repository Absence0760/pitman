// Copied from IC-WBT backend/src/delineation/pans.ts at f888e4461 (MIT, same author).
// Pans: the part of a delineated catchment that drains into a closed
// depression (docs/design/delineation.md § Pans; the research behind the
// thresholds, docs/design/pans-research.md). Priority-Flood fills every
// depression so that D8 can route it to the outlet (flow.ts); in South
// Africa's interior many of those depressions are pans, endorheic wetlands
// whose runoff evaporates instead of reaching the river, and WR2012 counts
// their catchments as non-contributing ("endoreic areas"). This module reads
// the fill's output (the elevations before and after it) and reports that
// area beside the routed catchment. It never changes the routing: the
// catchment proposed stays the gross one, and the non-contributing figure
// is the hydrologist's to use or not (the PFRA's gross and effective
// drainage areas, both reported).
//
// A closed depression counts as a pan when all three hold:
//  * it is at least PAN_MIN_DEPTH_M deep below its spill;
//  * its floor (the cells the fill raised) covers at least PAN_MIN_FLOOR_M2;
//  * it holds at least PAN_MIN_STORAGE_MM of its own catchment's runoff
//    below its spill, so an average year's runoff can't fill it: a dam on a
//    river drawn down below its spillway, or the pond behind a road
//    embankment, holds a few millimetres over its catchment and is not a pan.
// A depression holding a point (the outlet, or a unit's point), or spilling
// to one within the snap radius, is that point's own (a dam's basin behind
// the clicked wall), never a pan.
//
// The storage test alone can pass a large dam low in a small catchment (an
// off-channel or pumped-storage dam, a river dam drawn down a long way). So
// a depression that passes it is cross-checked against the river network
// and the dams already loaded (PanReference: the river network's reaches,
// the project's rivers and dams, the register of dams): one a mapped river
// flows through and out of at its spill, or with a dam at its spill or on
// its floor, is storage on a river, listed apart and not counted as a pan
// (docs/design/pans-research.md § Storage on a river). HydroRIVERS is traced
// on a filled DEM, so its lines run through most pans as well: only a reach
// HydroSHEDS routes to the sea counts, and only where the ground below the
// spill drops past the depression's floor within ON_RIVER_WALL_M, as below a
// dam's wall (a pan spills over a low saddle). A river that ends in a
// depression leaves it a pan.
//
// Pure apart from the reference's loader: typed arrays in, a mask and figures out.
import type { Position } from '../geo/geojson.js';
import { DX, DY, OUT } from './flow.js';

/** Shallowest depression counted (m below its spill): about GLO-30's height error over flat land (§ Pans). */
export const PAN_MIN_DEPTH_M = 1;
/** Smallest floor counted (m²): about 90 GLO-30 cells, past which a 1 m hollow is no longer the DEM's noise. */
export const PAN_MIN_FLOOR_M2 = 100_000;
/** Least storage below the spill, as runoff over the depression's own catchment (mm): over twice South Africa's mean annual runoff. */
export const PAN_MIN_STORAGE_MM = 100;
/** Pans listed on a proposal, the largest catchments first. */
export const PANS_LISTED = 5;
/**
 * A raise above this (m) is a filled depression; below it, the fill's ε gradient across a flat (flow.ts nextUp: far under a
 * micrometre even over millions of cells). Terrarium stores heights in 1/256 m steps, so any real filling is at least 0.0039 m.
 */
const RAISED_M = 0.001;
/**
 * A depression is every cell the fill raised (by any amount, its flat margin's ε too) within this (m) of its level: it is
 * filled flat to its spill, plus the ε gradient. Two that touch at different levels (one spilling into the other) stay two,
 * the upper one's water an inflow of the lower. Terrarium's 1/256 m step keeps distinct spill levels further apart than this.
 */
const LEVEL_M = 0.001;

/** A mapped river within this (m) of a depression's floor is in it: HydroRIVERS is traced on a 15″ grid, about 450 m. */
export const ON_RIVER_IN_M = 300;
/** How far down the spill's path (m) a river leaving the depression is looked for. */
export const ON_RIVER_PATH_M = 1500;
/** How near (m) to that path the river must pass, or a dam lie, to be at the spill. */
export const ON_RIVER_NEAR_M = 500;
/**
 * Least a depression must drain (m²) for a river network's reach to flow out of it: HydroRIVERS maps a reach only where 10 km²
 * drains, so a reach "leaving" a hollow that drains less is the river passing beside it, not out of it.
 */
export const ON_RIVER_MIN_DRAINS_M2 = 10e6;
/**
 * How far down the spill's path (m) the ground must fall below the depression's floor for a river leaving it to make it storage
 * on a river: a dam's wall drops to the river bed below it within a few hundred metres, while a pan's spill is a low saddle the
 * land falls away from slowly (measured, docs/design/pans-research.md § Storage on a river).
 */
export const ON_RIVER_WALL_M = 500;
/** Storage on a river listed on a proposal, the largest catchments first. */
export const ON_RIVER_LISTED = 5;

/** The method, as a proposal stores it with the figure. */
export const PAN_METHOD =
	`Non-contributing (pans): the cells draining into a closed depression of the DEM at least ${PAN_MIN_DEPTH_M} m deep below its spill, ` +
	`with a floor of at least ${PAN_MIN_FLOOR_M2 / 1e6} km², holding at least ${PAN_MIN_STORAGE_MM} mm of its own catchment's runoff below the spill ` +
	`(WR2012's endoreic areas; the PFRA's effective drainage area), a depression at the outlet or a unit's point excepted. ` +
	`Reported only: the catchment is routed through the pans, as filled.`;

/** What the method adds when the pans were checked against the river network and the dams (PanReference). */
export const ON_RIVER_METHOD =
	`A depression a mapped river flows through and out of (a river network's reach that reaches the sea, HydroSHEDS' ENDORHEIC 0, with at least ${ON_RIVER_MIN_DRAINS_M2 / 1e6} km² draining into the depression, or the catchment's own drawn river; ` +
	`in within ${ON_RIVER_IN_M} m of its floor, out within ${ON_RIVER_NEAR_M} m of the path ${ON_RIVER_PATH_M / 1000} km down from its spill) where the ground falls below its floor within ${ON_RIVER_WALL_M} m of the spill (a wall), ` +
	`or with a dam (the register's, or the map's) on its floor or within ${ON_RIVER_NEAR_M} m of that path, is storage on a river: listed apart, not counted.`;

/** One pan: where its floor is deepest, its floor's area, its depth below the spill, what drains into it and what it holds over that. */
export interface Pan {
	at: Position;
	floorM2: number;
	depthM: number;
	drainsM2: number;
	storageMm: number;
}

/** A depression that passed the pan tests but is storage on a river: a mapped river flows out of it, or a dam holds it. */
export interface RiverStorage extends Pan {
	by: 'river' | 'dam';
}

/** What a proposal stores: the non-contributing area, the pans' count, the largest few and the method. */
export interface PanReport {
	/** The catchment's area that drains into a pan, the pans' floors included (m²). */
	nonContributingM2: number;
	count: number;
	largest: Pan[];
	/**
	 * The depressions passing the pan tests that the river network or the dams showed to be storage on a river (not counted
	 * above). Absent when they weren't checked (before delineate-12 and start-14, or without the reference).
	 */
	onRiver?: { count: number; largest: RiverStorage[] };
	method: string;
}

/**
 * The rivers and dams a depression is checked against, in longitude and latitude. `rivers`: each line in its flow direction
 * when `directed` (HydroRIVERS draws a reach from its upper end), else either way (a river drawn on the map). `dams`: a dam's
 * point (one position) or its outline (a ring).
 */
export interface PanReference {
	rivers: { line: Position[]; directed: boolean }[];
	dams: Position[][];
}
/** Loads the reference over these boxes ([west, south, east, north]); only asked when a depression passes the pan tests. */
export type PanReferenceLoader = (boxes: [number, number, number, number][]) => Promise<PanReference>;

export interface PanGrid {
	nx: number;
	ny: number;
	/** Elevations before the fill (Float32 is plenty: GLO-30's own heights are float32). */
	before: Float32Array;
	/** Elevations after it (flow.ts fill's output). */
	after: Float64Array;
	dir: Uint8Array;
	/** Upstream cells of every cell, itself included (flow.ts accumulate). */
	acc: Int32Array;
	/** The catchment: only its cells are looked at. */
	mask: Uint8Array;
	/** Each row's cell area (m²). */
	rowM2: Float64Array;
	/** A cell's centre on the map. */
	toPos: (cell: number) => Position;
	/** A position's place on the grid, in cells (fractional: cell (x, y) spans x..x+1); needed with a reference. */
	toGrid?: (p: Position) => [number, number];
}

/** A growable list of cell indices (typed, so a depression of a million cells costs 4 MB, not a JS array's churn). */
class Cells {
	a = new Int32Array(1024);
	length = 0;
	push(c: number) {
		if (this.length === this.a.length) {
			const b = new Int32Array(this.a.length * 2);
			b.set(this.a);
			this.a = b;
		}
		this.a[this.length++] = c;
	}
}

/** A depression that passed the pan tests, before the cross-check: its cells and the path down from its spill. */
interface Candidate extends Pan {
	cells: Int32Array;
	/** The spill and the cells below it, ON_RIVER_PATH_M down. */
	path: number[];
	/** How far down that path (m) the ground first lies below its floor; Infinity when it doesn't. */
	belowM: number;
}

/**
 * The catchment's pans: `nc` marks every cell that drains into one (1),
 * `pans` lists them, the largest catchment first. `points` are the outlet's
 * and the units' cells; a depression at one, or spilling to one within
 * `nearCells` steps, is never a pan. With `load` (and `g.toGrid`), a
 * depression passing the tests is checked against the rivers and dams it
 * loads, and one on a river goes to `onRiver` instead (not counted); without
 * it, `onRiver` is undefined (not checked). One pass over the catchment's
 * filled cells, then one flood up from the pans: linear in the catchment.
 */
export async function findPans(
	g: PanGrid,
	points: readonly number[],
	nearCells: number,
	load?: PanReferenceLoader
): Promise<{ nc: Uint8Array; pans: Pan[]; onRiver?: RiverStorage[] }> {
	const { nx, ny, before, after, dir, acc, mask, rowM2 } = g;
	const n = nx * ny;
	// Bit 1: a filled cell already put in a depression; bit 2: drains into a pan.
	const state = new Uint8Array(n);
	const isPoint = new Set(points);
	/** A depression's seed: raised past the ε. */
	const raised = (i: number) => mask[i] === 1 && after[i]! - before[i]! > RAISED_M;
	/** In the depression at level `L`. */
	const member = (i: number, L: number) => mask[i] === 1 && after[i]! > before[i]! && Math.abs(after[i]! - L) < LEVEL_M;
	const down = (i: number) => {
		const d = dir[i]!;
		return d === OUT ? -1 : i + DY[d]! * nx + DX[d]!;
	};
	const found: Candidate[] = [];
	const list = new Cells();
	for (let i = 0; i < n; i++) {
		if (state[i]! & 1 || !raised(i)) continue;
		// One depression: its filled cells at one level, 8-connected (the list is the breadth-first queue).
		list.length = 0;
		let floorM2 = 0;
		let volumeM3 = 0;
		let depthM = 0;
		let deepest = i;
		let atPoint = false;
		// What drains into it: its own cells, and every cell upstream of a cell outside it that drains into it. Water that
		// reaches a filled cell stays below the spill until it leaves by the spill, so those upstream sets never overlap.
		let drainsM2 = 0;
		const level = after[i]!;
		state[i]! |= 1;
		list.push(i);
		for (let h = 0; h < list.length; h++) {
			const c = list.a[h]!;
			const cx = c % nx;
			const cy = (c - cx) / nx;
			const m2 = rowM2[cy]!;
			const d = after[c]! - before[c]!;
			// The floor: what the fill raised past the ε (a flat margin at the level holds no water).
			if (d > RAISED_M) floorM2 += m2;
			volumeM3 += d * m2;
			drainsM2 += m2;
			if (d > depthM) (depthM = d), (deepest = c);
			if (isPoint.has(c)) atPoint = true;
			for (let k = 0; k < 8; k++) {
				const x = cx + DX[k]!;
				const y = cy + DY[k]!;
				if (x < 0 || y < 0 || x >= nx || y >= ny) continue;
				const j = y * nx + x;
				if (member(j, level)) {
					if (state[j]! & 1) continue;
					state[j]! |= 1;
					list.push(j);
				} else if (dir[j] === (k + 4) % 8) drainsM2 += acc[j]! * rowM2[y]!;
			}
		}
		if (depthM < PAN_MIN_DEPTH_M || floorM2 < PAN_MIN_FLOOR_M2) continue;
		// Its spill: down from the deepest cell to the first cell off its level.
		let spill = deepest;
		while (spill >= 0 && member(spill, level)) spill = down(spill);
		// Spilling into a point close by: the point's own basin (a dam's, behind the wall clicked).
		for (let k = spill, s = 0; !atPoint && k >= 0 && s <= nearCells; k = down(k), s++) if (isPoint.has(k)) atPoint = true;
		if (atPoint) continue;
		const storageMm = (volumeM3 / drainsM2) * 1000;
		if (storageMm < PAN_MIN_STORAGE_MM) continue;
		// The path down from the spill, for the cross-check (a cell's side from its row's area: the grid's cells are square).
		const path: number[] = [];
		// The deepest cell is the lowest before the fill (filled flat to one level): the floor.
		const floorZ = before[deepest]!;
		let belowM = Infinity;
		if (spill >= 0) {
			const cellM = Math.sqrt(rowM2[Math.floor(spill / nx)]!);
			let m = 0;
			for (let k = spill; k >= 0 && m <= ON_RIVER_PATH_M; ) {
				path.push(k);
				if (belowM === Infinity && before[k]! < floorZ) belowM = m;
				const d = dir[k]!;
				if (d === OUT) break;
				m += (d % 2 ? Math.SQRT2 : 1) * cellM;
				k = down(k);
			}
		}
		found.push({ at: g.toPos(deepest), floorM2, depthM, drainsM2, storageMm, cells: list.a.slice(0, list.length), path, belowM });
	}
	// The cross-check: which of them a mapped river flows out of, or a dam holds.
	let onRiver: RiverStorage[] | undefined;
	let pans: Candidate[] = found;
	if (load && g.toGrid) {
		onRiver = [];
		if (found.length) {
			const by = await onRiverBy(g, found, load);
			pans = found.filter((_, j) => by[j] === null);
			for (let j = 0; j < found.length; j++) {
				if (by[j] === null) continue;
				const { cells: _c, path: _p, belowM: _b, ...p } = found[j]!;
				onRiver.push({ ...p, by: by[j]! });
			}
			onRiver.sort((a, b) => b.drainsM2 - a.drainsM2);
		}
	}
	// Everything upstream of a pan's cells drains into it.
	list.length = 0;
	for (const p of pans) {
		for (const c of p.cells) {
			if (state[c]! & 2) continue;
			state[c]! |= 2;
			list.push(c);
		}
	}
	for (let h = 0; h < list.length; h++) {
		const c = list.a[h]!;
		const cx = c % nx;
		const cy = (c - cx) / nx;
		for (let k = 0; k < 8; k++) {
			const x = cx + DX[k]!;
			const y = cy + DY[k]!;
			if (x < 0 || y < 0 || x >= nx || y >= ny) continue;
			const j = y * nx + x;
			if (state[j]! & 2 || dir[j] !== (k + 4) % 8) continue;
			state[j]! |= 2;
			list.push(j);
		}
	}
	for (let i = 0; i < n; i++) state[i] = (state[i]! >> 1) & 1;
	pans.sort((a, b) => b.drainsM2 - a.drainsM2);
	return { nc: state, pans: pans.map(({ cells: _, path: _p, belowM: _b, ...p }) => p), ...(onRiver ? { onRiver } : {}) };
}

/**
 * For each candidate, what shows it to be storage on a river (null: nothing, a pan). Each gets a small raster over its box:
 * 2 on its own cells, 1 within ON_RIVER_IN_M of them (a chamfer distance, 1 and √2 a step). A river line flows out of it when,
 * walked downstream, it is in that raster and then, outside it, within ON_RIVER_NEAR_M of the path down from the spill. A dam
 * holds it when the dam's point lies on its cells or within ON_RIVER_NEAR_M of that path, or its outline crosses its cells.
 */
async function onRiverBy(g: PanGrid, found: readonly Candidate[], load: PanReferenceLoader): Promise<('river' | 'dam' | null)[]> {
	const { nx, ny, rowM2 } = g;
	const toGrid = g.toGrid!;
	const boxes = found.map((p) => {
		const cellM = Math.sqrt(rowM2[Math.floor(p.cells[0]! / nx)]!);
		const kIn = ON_RIVER_IN_M / cellM;
		const kNear = ON_RIVER_NEAR_M / cellM;
		let x0 = Infinity;
		let y0 = Infinity;
		let x1 = -Infinity;
		let y1 = -Infinity;
		const grow = (c: number, k: number) => {
			const x = c % nx;
			const y = (c - x) / nx;
			x0 = Math.min(x0, x - k);
			y0 = Math.min(y0, y - k);
			x1 = Math.max(x1, x + k);
			y1 = Math.max(y1, y + k);
		};
		for (const c of p.cells) grow(c, Math.ceil(kIn) + 1);
		for (const c of p.path) grow(c, Math.ceil(kNear) + 1);
		x0 = Math.max(0, x0);
		y0 = Math.max(0, y0);
		x1 = Math.min(nx - 1, x1);
		y1 = Math.min(ny - 1, y1);
		const w = x1 - x0 + 1;
		const h = y1 - y0 + 1;
		// The distance (cells) from its own cells, inside the box: two chamfer passes, made only when a river or dam reaches the box.
		let zone: Uint8Array | null = null;
		const makeZone = (): Uint8Array => {
			const dist = new Float32Array(w * h).fill(Infinity);
			for (const c of p.cells) {
				const x = c % nx;
				dist[((c - x) / nx - y0) * w + x - x0] = 0;
			}
			const S = Math.SQRT2;
			for (let y = 0; y < h; y++)
				for (let x = 0; x < w; x++) {
					let d = dist[y * w + x]!;
					if (x > 0) d = Math.min(d, dist[y * w + x - 1]! + 1);
					if (y > 0) {
						d = Math.min(d, dist[(y - 1) * w + x]! + 1);
						if (x > 0) d = Math.min(d, dist[(y - 1) * w + x - 1]! + S);
						if (x < w - 1) d = Math.min(d, dist[(y - 1) * w + x + 1]! + S);
					}
					dist[y * w + x] = d;
				}
			for (let y = h - 1; y >= 0; y--)
				for (let x = w - 1; x >= 0; x--) {
					let d = dist[y * w + x]!;
					if (x < w - 1) d = Math.min(d, dist[y * w + x + 1]! + 1);
					if (y < h - 1) {
						d = Math.min(d, dist[(y + 1) * w + x]! + 1);
						if (x < w - 1) d = Math.min(d, dist[(y + 1) * w + x + 1]! + S);
						if (x > 0) d = Math.min(d, dist[(y + 1) * w + x - 1]! + S);
					}
					dist[y * w + x] = d;
				}
			const z = new Uint8Array(w * h);
			for (let i = 0; i < z.length; i++) z[i] = dist[i] === 0 ? 2 : dist[i]! <= kIn ? 1 : 0;
			return (zone = z);
		};
		const path = p.path.map((c) => [(c % nx) + 0.5, Math.floor(c / nx) + 0.5] as const);
		/** 2 on its cells, 1 near them, 0 elsewhere. */
		const zoneAt = (x: number, y: number) => {
			const bx = Math.floor(x) - x0;
			const by = Math.floor(y) - y0;
			return bx < 0 || by < 0 || bx >= w || by >= h ? 0 : (zone ?? makeZone())[by * w + bx]!;
		};
		const nearPath = (x: number, y: number) => {
			if (x < x0 || y < y0 || x > x1 + 1 || y > y1 + 1) return false;
			for (const [px, py] of path) if (Math.hypot(px - x, py - y) <= kNear) return true;
			return false;
		};
		return { x0, y0, x1: x1 + 1, y1: y1 + 1, zoneAt, nearPath };
	});
	// The boxes on the map, for the loader: the corners' cells' centres, half a cell out.
	const corner = (x: number, y: number) => {
		const c = Math.min(ny - 1, Math.max(0, Math.floor(y))) * nx + Math.min(nx - 1, Math.max(0, Math.floor(x)));
		return g.toPos(c);
	};
	const lonLat = boxes.map((b): [number, number, number, number] => {
		const a = corner(b.x0, b.y0);
		const z = corner(b.x1, b.y1);
		const padLon = Math.abs(z[0] - a[0]) / Math.max(1, b.x1 - b.x0);
		const padLat = Math.abs(z[1] - a[1]) / Math.max(1, b.y1 - b.y0);
		return [Math.min(a[0], z[0]) - padLon, Math.min(a[1], z[1]) - padLat, Math.max(a[0], z[0]) + padLon, Math.max(a[1], z[1]) + padLat];
	});
	const ref = await load(lonLat);
	const by: ('river' | 'dam' | null)[] = found.map(() => null);
	/** A line's samples on the grid, half a cell apart at most. */
	const samples = (line: readonly Position[]): [number, number][] => {
		const out: [number, number][] = [];
		let prev: [number, number] | null = null;
		for (const p of line) {
			const q = toGrid(p);
			if (prev) {
				const steps = Math.max(1, Math.ceil(2 * Math.hypot(q[0] - prev[0], q[1] - prev[1])));
				for (let s = 1; s <= steps; s++) out.push([prev[0] + ((q[0] - prev[0]) * s) / steps, prev[1] + ((q[1] - prev[1]) * s) / steps]);
			} else out.push(q);
			prev = q;
		}
		return out;
	};
	/** The samples' own box meets the candidate's. */
	const extent = (pts: readonly [number, number][]) => {
		let x0 = Infinity;
		let y0 = Infinity;
		let x1 = -Infinity;
		let y1 = -Infinity;
		for (const [x, y] of pts) (x0 = Math.min(x0, x)), (y0 = Math.min(y0, y)), (x1 = Math.max(x1, x)), (y1 = Math.max(y1, y));
		return (b: (typeof boxes)[number]) => x1 >= b.x0 && y1 >= b.y0 && x0 <= b.x1 && y0 <= b.y1;
	};
	for (const dam of ref.dams) {
		const pts = dam.length === 1 ? [toGrid(dam[0]!)] : samples(dam);
		const meets = extent(pts);
		for (let j = 0; j < found.length; j++) {
			const b = boxes[j]!;
			if (by[j] || !meets(b)) continue;
			if (pts.some(([x, y]) => b.zoneAt(x, y) === 2 || (dam.length === 1 && b.nearPath(x, y)))) by[j] = 'dam';
		}
	}
	for (const river of ref.rivers) {
		const pts = samples(river.line);
		const meets = extent(pts);
		const ways = river.directed ? [pts] : [pts, [...pts].reverse()];
		for (let j = 0; j < found.length; j++) {
			const b = boxes[j]!;
			const f = found[j]!;
			if (by[j] || !meets(b) || f.belowM > ON_RIVER_WALL_M || (river.directed && f.drainsM2 < ON_RIVER_MIN_DRAINS_M2)) continue;
			for (const way of ways) {
				let entered = false;
				for (const [x, y] of way) {
					const z = b.zoneAt(x, y);
					if (z > 0) entered = true;
					else if (entered && b.nearPath(x, y)) {
						by[j] = 'river';
						break;
					}
				}
				if (by[j]) break;
			}
		}
	}
	return by;
}

/** The non-contributing area (m²) of the cells `of` marks (1), from `nc`. */
export function ncAreaM2(nx: number, nc: Uint8Array, rowM2: Float64Array, of?: (cell: number) => boolean): number {
	let m2 = 0;
	for (let i = 0; i < nc.length; i++) if (nc[i] && (!of || of(i))) m2 += rowM2[(i - (i % nx)) / nx]!;
	return m2;
}

/** The report a proposal stores (the figures rounded to what they're worth); `onRiver` when the pans were cross-checked. */
export function panReport(nonContributingM2: number, pans: readonly Pan[], onRiver?: readonly RiverStorage[]): PanReport {
	const round = (p: Pan): Pan => ({
		at: p.at,
		floorM2: Math.round(p.floorM2),
		depthM: Math.round(p.depthM * 10) / 10,
		drainsM2: Math.round(p.drainsM2),
		storageMm: Math.round(p.storageMm)
	});
	return {
		nonContributingM2: Math.round(nonContributingM2),
		count: pans.length,
		largest: pans.slice(0, PANS_LISTED).map(round),
		...(onRiver ? { onRiver: { count: onRiver.length, largest: onRiver.slice(0, ON_RIVER_LISTED).map((p) => ({ ...round(p), by: p.by })) } } : {}),
		method: onRiver ? `${PAN_METHOD} ${ON_RIVER_METHOD}` : PAN_METHOD
	};
}

const km2Text = (m2: number) => {
	const v = m2 / 1e6;
	return v < 10 ? `${v.toFixed(2)} km²` : `${Math.round(v).toLocaleString('en-ZA')} km²`;
};
const place = ([lon, lat]: Position) => `${Math.abs(lat).toFixed(3)}° ${lat < 0 ? 'S' : 'N'}, ${Math.abs(lon).toFixed(3)}° ${lon < 0 ? 'W' : 'E'}`;

/**
 * The sentence a Start or Divide proposal shows when part of its catchment drains into pans: how much, where the largest is,
 * and which pieces hold it (`pieces`: each with any, by name). Null when none does.
 */
export function panWarning(report: PanReport, catchmentM2: number, pieces: readonly { name: string; ncM2: number }[], effectiveOffered = true): string | null {
	const river = onRiverText(report);
	if (!report.count || !(report.nonContributingM2 > 0)) return river;
	const big = report.largest[0]!;
	const share = catchmentM2 > 0 ? ` (${Math.round((100 * report.nonContributingM2) / catchmentM2)} %)` : '';
	const held = pieces.filter((p) => p.ncM2 >= 0.005e6).map((p) => `${km2Text(p.ncM2)} in ${p.name}’s`);
	return (
		`${km2Text(report.nonContributingM2)} of the catchment above the outlet${share} drains into ` +
		(report.count === 1
			? `a pan (a closed depression on the elevation model, at ${place(big.at)}, ${km2Text(big.drainsM2)} draining into it). `
			: `${report.count} pans (closed depressions on the elevation model; the largest at ${place(big.at)}, ${km2Text(big.drainsM2)} draining into it). `) +
		`WR2012 counts such endoreic areas as non-contributing; the areas here still include them${held.length ? `: ${held.join(', ')} own area` : ''}. ${effectiveOffered ? 'Choose the effective area beside an area’s tick if you model them as non-contributing.' : 'Each unit keeps its boundary’s area (start-16): type a smaller one if you model them as non-contributing.'}` +
		(river ? ` ${river}` : '')
	);
}

/** The sentence for the depressions found to be storage on a river (not counted as pans), or null when there are none. */
export function onRiverText(report: PanReport): string | null {
	const r = report.onRiver;
	if (!r?.count) return null;
	const big = r.largest[0]!;
	const why = (by: RiverStorage['by']) => (by === 'dam' ? 'a dam holds it' : 'a mapped river flows out of it');
	return r.count === 1
		? `A closed depression at ${place(big.at)} holds as much as a pan, but ${why(big.by)}: it is storage on a river, so its ${km2Text(big.drainsM2)} is not counted as non-contributing.`
		: `${r.count} closed depressions hold as much as pans, but a mapped river flows out of each or a dam holds it (the largest at ${place(big.at)}, ${km2Text(big.drainsM2)} draining into it): storage on a river, not counted as non-contributing.`;
}
