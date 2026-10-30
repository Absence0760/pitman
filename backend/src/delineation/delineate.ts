// Copied from IC-WBT backend/src/delineation/delineate.ts at f888e4461 (MIT, same author).
// Kept: delineate, the windows, the refusals, readWindow, the method text. Stripped: the background
// worker's windows and aim, the mapped-reach wording, and the outline of the whole catchment: Pitman
// clips the cell mask to the quaternary first (tributary.ts, subdivide.md § Hydrological split, step 3),
// so delineate returns the mask and the window it lies on.
//
// Delineate the catchment upstream of a clicked point. Reads a square window of the DEM around the click
// at one zoom, fills its depressions, routes flow with D8, places the outlet on the terrain channel
// nearest the click (place.ts) and collects the cells upstream of it. When the catchment reaches the
// window's edge, the window grows over the catchment, up to a cap; past the cap (or the time budget) the
// request is refused rather than answered with a cut-off catchment.
import type { Position } from '../geo/geojson.js';
import type { Dem, DemInfo } from './dem.js';
import { accumulate, BORDER, d8, edgeMask, fill, NO_DATA_EDGE, openFlags, upstream, type Grid } from './flow.js';
import { GUARD_RADIUS_M, LARGER_FACTOR, ON_CHANNEL_KM2, place } from './place.js';
import { findPans, ncAreaM2, panReport, type PanReport } from './pans.js';
import { cellRowAreaM2, mercatorLat } from '../geo/area.js';

/** Bump when the method changes what a click proposes; recorded on every proposal. */
/**
 * delineate-2 (issue #374): the outlet matched to a nearby river reach's upstream area, and a much larger channel nearby refused unless kept;
 * delineate-3: at a confluence the river is asked for and its outlet put at the DEM's own junction; delineate-4 (issue #387): the snap radius
 * measured from the exact click to each cell's centre, so the snap distance never exceeds it (it counted whole cells from the clicked cell);
 * delineate-5 (the hydrologist persona's findings 4, 7 and 13): a click on the DEM's own channel stays on it, the reach's matching channel
 * offered rather than taken; a gully snap offers the reach's channel out to 2.5 km; the reach's area is taken at the click (reach.ts).
 * delineate-6 (issue #390, findings 1, 2 and 6): a river the window cuts grows the window instead of falling back to a gully, each larger
 * window is placed over the catchment rather than centred on the click, and no data is the data's edge (flow.ts edgeMask), not a sink.
 * delineate-7 (issue #390, the hydrologist persona's findings 5 and 12): a click within JUNCTION_SIDE_M of a mapped junction kept on its
 * river's side of the DEM's junction without asking, and every junction placement on the river's own channel nearest the click, not at
 * the junction itself; one moved over JUNCTION_FLAG_M is flagged.
 * delineate-8: delineate-5's and delineate-7's rules together (one merge of the two).
 * delineate-9 (the hydrologist's review, finding 8): the area draining into pans (closed depressions the fill routed onward) reported
 * beside the catchment, as non-contributing, with its method (pans.ts); the catchment itself unchanged.
 * delineate-10: delineate-6's windows and data's edge with delineate-9's rules (one merge of the two).
 * delineate-11: a head reach's area at the click from the DEM's own area at its upper end, where the window reads it, rather than
 * HydroRIVERS' 10 km² threshold (expectedOnGrid, removed in delineate-13).
 * delineate-12 (the follow-up "Cross-check a pan against the river network"): a depression passing the pan tests that a mapped
 * river flows out of over a wall, or a dam holds, is storage on a river, listed apart and not counted (pans.ts onRiverBy).
 * delineate-13 (issue #472): the outlet on the terrain channel (ON_CHANNEL_KM2 or more) nearest the click, within the snap radius,
 * else refused (`off_channel`); the mapped river network no longer matches, moves or chooses it (delineate-2 to -11's rules gone); the
 * much larger channel (the DEM alone) is still offered, never taken.
 */
export const METHOD_VERSION = 'delineate-13';
/** Web Mercator zoom the DEM is read at: 512 px tiles at zoom 11 are about 33 m a cell over South Africa, GLO-30's own resolution. */
export const TARGET_ZOOM = 11;
/** How far the click may be from the terrain channel it goes on (docs/design/delineation.md § Method, step 6). */
export const SNAP_RADIUS_M = 150;
/**
 * The windows a request tries, in cells a side; the last is its cap (about 100 km at zoom 11). The first is centred on the click; each
 * larger one is placed over the catchment the last one cut (windowOrigin), so a catchment reaches up to about 95 km from its outlet.
 */
export const WINDOWS = [1024, 2048, 3072] as const;
/** Fewest cells a proposal may have: less is a click on a ridge or a slope, not a catchment. */
export const MIN_CELLS = 9;
/** Wall-clock budget for one delineation, under the API Lambda's 30 s timeout. */
export const TIME_BUDGET_MS = 20_000;

export const EARTH_RADIUS_M = 6378137;

/** IC-WBT's codes; `outline` is Pitman's one failure that isn't in the contract's `DelineateRefusal` (routes.ts answers it with no `reason`). */
export type RefusalCode = 'outside' | 'no_data' | 'off_channel' | 'too_large' | 'too_small' | 'outline' | 'larger_channel' | 'whole_quaternary';

/** With `larger_channel`: the channel the point probably meant, to offer (place.ts). */
export interface LargerChannel {
	/** Its cell's centre. */
	at: Position;
	/** How far it is from the click (m). */
	distanceM: number;
	/** What drains through it inside the routed window (km²; a lower bound when its catchment runs past the window). */
	km2: number;
	/** What drains through the cell the point snapped to (km²). */
	pointKm2: number;
}

export class DelineationRefused extends Error {
	constructor(
		readonly code: RefusalCode,
		message: string,
		readonly larger?: LargerChannel
	) {
		super(message);
	}
}

/** Which way `to` lies from `from`, in words (eight points). */
export function bearingWord(from: Position, to: Position): string {
	const dx = (to[0] - from[0]) * Math.cos((from[1] * Math.PI) / 180);
	const dy = to[1] - from[1];
	const deg = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
	return ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][Math.round(deg / 45) % 8]!;
}

const km2Text = (v: number) => `${v < 10 ? v.toFixed(2) : Math.round(v).toLocaleString('en-ZA')} km²`;

/**
 * The refusal for a point beside a much larger channel: the sentence and the channel to offer. `larger.km2` counts only what drains
 * through it inside the routed window, so it isn't an "about" (the hydrologist's review, finding 10): `context.open`, its catchment
 * runs past the window (`windowKm` a side), so the figure is a floor.
 */
export function largerChannelRefusal(click: Position, larger: LargerChannel, what = 'your point', context: { open?: boolean; windowKm?: number } = {}): DelineationRefused {
	const drains = context.open
		? `at least ${km2Text(larger.km2)} drains through it inside the ${context.windowKm ?? '–'} km routed around ${what}, and more from beyond`
		: `${km2Text(larger.km2)} drains through it`;
	return new DelineationRefused(
		'larger_channel',
		`A much larger terrain channel runs ${Math.round(larger.distanceM)} m ${bearingWord(click, larger.at)} of ${what}: ${drains}, against ${km2Text(larger.pointKm2)} on the terrain channel nearest ${what}. Use that channel, or keep ${what} if you meant the small one.`,
		larger
	);
}

/** The `off_channel` sentence: no terrain channel within the snap radius of the point (place.ts). */
export function offChannelText(what: string, snapRadiusM: number): string {
	return `No terrain channel runs within ${snapRadiusM} m of ${what}. Zoom in until the terrain channels show, and click on one: they are the elevation model's rivers, which the outline follows.`;
}

/** The `too_large` sentence; IC-WBT's advice to use its Sub-catchments screen dropped, Pitman has none. */
export function tooLargeText(km: number): string {
	return `The catchment above that point reaches beyond the ${km} km the app delineates around a click, so it can’t be proposed whole. Click further upstream for a smaller catchment.`;
}

/** The cell mask of a delineation and the window it lies on, for clipping (tributary.ts). */
export interface CatchmentMask {
	/** n × n, row-major, 1 = drains to the outlet. */
	mask: Uint8Array;
	n: number;
	/** The window's top-left, global pixels at zoom `zoom`. */
	x0: number;
	y0: number;
	/** The world's width in pixels at that zoom. */
	W: number;
	/** Each row's cell area (m²): ellipsoidal, by row. */
	rowM2: Float64Array;
}

export interface Delineation {
	click: Position;
	/** The outlet: the centre of the terrain-channel cell nearest the click (place.ts). */
	outlet: Position;
	snapDistanceM: number;
	/** `D`: the cells upstream of the outlet, the outlet included. */
	catchment: CatchmentMask;
	/** Cells in `D`, and their ellipsoidal area. */
	cells: number;
	areaM2: number;
	cellSizeM: number;
	zoom: number;
	windowCells: number;
	dataset: DemInfo;
	method: string;
	methodVersion: string;
	/** The part of it that drains into pans (pans.ts): reported, not taken out of `areaM2` or the mask. */
	pans: PanReport;
}

const deg = (v: number, pos: string, neg: string) => `${Math.abs(v).toFixed(2)}° ${v < 0 ? neg : pos}`;
/** A dataset's bounds in words for a refusal: "20.39° E to 21.09° E, 33.72° S to 33.14° S" (not "-33.7243397° … N"). */
export const boundsText = ([w, s, e, n]: readonly [number, number, number, number]) => `${deg(w, 'E', 'W')} to ${deg(e, 'E', 'W')}, ${deg(s, 'N', 'S')} to ${deg(n, 'N', 'S')}`;

export const worldPx = (z: number, size: number) => 2 ** z * size;
export const toPx = (lon: number, lat: number, W: number): [number, number] => {
	const s = Math.sin((Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI) / 180);
	return [((lon + 180) / 360) * W, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * W];
};
export const toLonLat = (x: number, y: number, W: number): Position => [
	Math.round(((x / W) * 360 - 180) * 1e7) / 1e7,
	Math.round(((Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / W))) * 180) / Math.PI) * 1e7) / 1e7
];

/** The DEM's elevations over [x0, x0+n) × [y0, y0+n) global pixels at zoom z (NaN where it has no tile). */
export async function readWindow(dem: Dem, z: number, size: number, x0: number, y0: number, n: number): Promise<Grid> {
	const grid: Grid = { nx: n, ny: n, z: new Float64Array(n * n).fill(Number.NaN) };
	const tiles = 2 ** z;
	const tx0 = Math.floor(x0 / size);
	const ty0 = Math.floor(y0 / size);
	const tx1 = Math.floor((x0 + n - 1) / size);
	const ty1 = Math.floor((y0 + n - 1) / size);
	const jobs: Promise<void>[] = [];
	for (let ty = ty0; ty <= ty1; ty++) {
		for (let tx = tx0; tx <= tx1; tx++) {
			if (ty < 0 || ty >= tiles) continue;
			const wx = ((tx % tiles) + tiles) % tiles;
			jobs.push(
				dem.tile(z, wx, ty).then((t) => {
					if (!t) return;
					if (t.size !== size) throw new Error(`a DEM tile of ${t.size} px among ${size} px tiles`);
					for (let py = 0; py < size; py++) {
						const gy = ty * size + py - y0;
						if (gy < 0 || gy >= n) continue;
						for (let px = 0; px < size; px++) {
							const gx = tx * size + px - x0;
							if (gx < 0 || gx >= n) continue;
							grid.z[gy * n + gx] = t.z[py * size + px]!;
						}
					}
				})
			);
		}
	}
	await Promise.all(jobs);
	return grid;
}

/** The box (global pixels, inclusive) of a catchment a window cut, and the window sides it reached. */
export interface Aim {
	box: [number, number, number, number];
	/** It reached the west, north, east, south border (a cell beside it). */
	cut: [boolean, boolean, boolean, boolean];
}

/** Where `mask` (a catchment in the window at x0, y0) lies, for placing the next window. */
export function aimAt(mask: Uint8Array, n: number, x0: number, y0: number): Aim {
	let bx0 = n;
	let by0 = n;
	let bx1 = -1;
	let by1 = -1;
	for (let y = 0; y < n; y++) {
		const row = y * n;
		for (let x = 0; x < n; x++) {
			if (!mask[row + x]) continue;
			if (x < bx0) bx0 = x;
			if (x > bx1) bx1 = x;
			if (y < by0) by0 = y;
			if (y > by1) by1 = y;
		}
	}
	return { box: [x0 + bx0, y0 + by0, x0 + bx1, y0 + by1], cut: [bx0 <= 1, by0 <= 1, bx1 >= n - 2, by1 >= n - 2] };
}

/**
 * The top-left (global pixels) of an n-cell window: centred on the click
 * (gx, gy) without an aim; else, on each axis, starting just short of the
 * catchment's end that the last window held when it was cut at the other end
 * only, so the catchment gets the whole window in the direction it runs
 * (persona-hydrologist finding 6: centred, the 3 072-cell cap held only about
 * 50 km upstream of the outlet, and half the window lay downstream of it), or
 * centred on the catchment's box when cut at both ends or neither. Either
 * way the click stays `keep` cells inside, so the outlet's placement sees
 * all it would in a centred window.
 */
export function windowOrigin(n: number, gx: number, gy: number, keep: number, aim: Aim | null): [number, number] {
	const cx = Math.floor(gx);
	const cy = Math.floor(gy);
	if (!aim) return [cx - n / 2, cy - n / 2];
	const axis = (c: number, lo: number, hi: number, cutLo: boolean, cutHi: boolean) => {
		const o = cutHi && !cutLo ? lo - keep : cutLo && !cutHi ? hi + 1 + keep - n : Math.floor((lo + hi + 1 - n) / 2);
		return Math.min(c - keep, Math.max(c + 1 + keep - n, o));
	};
	const [bx0, by0, bx1, by1] = aim.box;
	return [axis(cx, bx0, bx1, aim.cut[0], aim.cut[2]), axis(cy, by0, by1, aim.cut[1], aim.cut[3])];
}

/** What ran for one delineation, for its method sentence. */
export interface DelineationMethodFacts {
	cellM: number;
	zoom: number;
	snapRadiusM: number;
	/** The editor kept the point beside the much larger channel offered. */
	kept: boolean;
}

/** The method sentence a delineation stores. Pure. */
export function delineationMethod(f: DelineationMethodFacts): string {
	const placement = f.kept
		? `outlet placed on the terrain channel (at least ${ON_CHANNEL_KM2} km² draining through it) nearest the point, within ${f.snapRadiusM} m, and kept there by the editor though a channel with ${LARGER_FACTOR}× its upstream cells within ${GUARD_RADIUS_M} m was offered; `
		: `outlet placed on the terrain channel (at least ${ON_CHANNEL_KM2} km² draining through it) nearest the point, within ${f.snapRadiusM} m; no mapped river network used to place it; `;
	return (
		`D8 steepest descent on the DEM after Priority-Flood+ε depression filling (Barnes, Lehman & Mulla 2014), ${f.cellM} m cells (zoom ${f.zoom}); ` +
		placement +
		`the mask clipped to the quaternary, its outline traced on the cells’ edges and simplified (Douglas–Peucker, about ${f.cellM} m); ` +
		`the area draining into pans (closed depressions) reported beside it as non-contributing, not taken out`
	);
}

/** Delineate the catchment upstream of (lon, lat). Throws DelineationRefused with a sentence for the user. */
export async function delineate(
	dem: Dem,
	click: Position,
	opts: {
		windows?: readonly number[];
		snapRadiusM?: number;
		budgetMs?: number;
		now?: () => number;
		/** Keep the point even beside a much larger channel (otherwise refused with `larger_channel`). */
		keepPoint?: boolean;
	} = {}
): Promise<Delineation> {
	const now = opts.now ?? (() => performance.now());
	const started = now();
	const budget = opts.budgetMs ?? TIME_BUDGET_MS;
	const windows = opts.windows ?? WINDOWS;
	const snapRadiusM = opts.snapRadiusM ?? SNAP_RADIUS_M;
	const info = await dem.info();
	const [lon, lat] = click;
	const [w, s, e, n] = info.bounds;
	if (lon < w || lon > e || lat < s || lat > n) {
		throw new DelineationRefused('outside', `That point is outside the elevation model (${info.label} covers ${boundsText(info.bounds)}).`);
	}
	const z = Math.min(TARGET_ZOOM, info.maxZoom);
	// The tile under the click gives the tile size, and says whether there is data there at all.
	const probe = toPx(lon, lat, 2 ** z);
	const here = await dem.tile(z, Math.floor(probe[0]), Math.floor(probe[1]));
	if (!here) throw new DelineationRefused('no_data', 'The elevation model has no data at that point.');
	const size = here.size;
	const W = worldPx(z, size);
	const [gx, gy] = toPx(lon, lat, W);
	const cellSizeM = (2 * Math.PI * EARTH_RADIUS_M * Math.cos((lat * Math.PI) / 180)) / W;
	// Cells around the click the placement and its larger-channel guard look at: every window keeps them inside.
	const keepCells = Math.ceil(GUARD_RADIUS_M / cellSizeM) + 2;
	const cellKm2 = (cellSizeM * cellSizeM) / 1e6;
	/** Where the last window cut the catchment: the next window is placed over it. */
	let aim: Aim | null = null;
	for (let wi = 0; wi < windows.length; wi++) {
		const nCells = windows[wi]!;
		const [x0, y0] = windowOrigin(nCells, gx, gy, keepCells, aim);
		const grid = await readWindow(dem, z, size, x0, y0, nCells);
		const edge = edgeMask(grid);
		// The elevations before the fill, to tell its pans (pans.ts): 4 bytes a cell.
		const before = new Float32Array(grid.z);
		fill(grid, edge);
		const dir = d8(grid, edge);
		const acc = accumulate(nCells, nCells, dir);
		const open = openFlags(nCells, nCells, dir, edge);
		/** Grow into the next window, aimed at `mask`; refused `too_large` past the last one or the budget. */
		const grow = (mask: Uint8Array): void => {
			const last = wi === windows.length - 1;
			const elapsed = now() - started;
			// The next window costs about (its cells / these cells)² times this one; stop before it would break the budget.
			const next = windows[wi + 1];
			if (last || (next !== undefined && elapsed * (1 + (next / nCells) ** 2) > budget)) {
				const km = Math.round((nCells * cellSizeM) / 1000);
				throw new DelineationRefused('too_large', tooLargeText(km));
			}
			aim = aimAt(mask, nCells, x0, y0);
		};
		const placed = place({ nx: nCells, ny: nCells, acc, edge, cellSizeM }, gx - x0, gy - y0, { snapRadiusM });
		if (placed === null) throw new DelineationRefused('off_channel', offChannelText('that point', snapRadiusM));
		if (placed.larger && !opts.keepPoint) {
			const lx = placed.larger.cell % nCells;
			const ly = (placed.larger.cell - lx) / nCells;
			throw largerChannelRefusal(
				click,
				{
					at: toLonLat(x0 + lx + 0.5, y0 + ly + 0.5, W),
					distanceM: placed.larger.distanceM,
					km2: acc[placed.larger.cell]! * cellKm2,
					pointKm2: acc[placed.cell]! * cellKm2
				},
				undefined,
				{
					// The channel's catchment runs past this window (or the data's edge): its area here is only a floor.
					open: open[placed.larger.cell]! !== 0,
					windowKm: Math.round((nCells * cellSizeM) / 1000)
				}
			);
		}
		const outlet = placed.cell;
		const mask = upstream(nCells, nCells, dir, outlet);
		if (open[outlet]! & NO_DATA_EDGE) {
			throw new DelineationRefused('no_data', 'The catchment above that point runs past the edge of the elevation model’s data, so it can’t be delineated whole.');
		}
		if (open[outlet]! & BORDER) {
			grow(mask);
			continue;
		}
		let cells = 0;
		for (let i = 0; i < mask.length; i++) cells += mask[i]!;
		if (cells < MIN_CELLS) {
			throw new DelineationRefused('too_small', 'Almost nothing drains to that point: click on a terrain channel at the outlet or the dam wall.');
		}
		const rowM2 = new Float64Array(nCells);
		for (let y = 0; y < nCells; y++) rowM2[y] = cellRowAreaM2(mercatorLat(y0 + y, W), mercatorLat(y0 + y + 1, W), W);
		const toCell = (c: number) => toLonLat(x0 + (c % nCells) + 0.5, y0 + Math.floor(c / nCells) + 0.5, W);
		const toGrid = (p: Position): [number, number] => {
			const [px, py] = toPx(p[0], p[1], W);
			return [px - x0, py - y0];
		};
		const found = await findPans({ nx: nCells, ny: nCells, before, after: grid.z, dir, acc, mask, rowM2, toPos: toCell, toGrid }, [outlet], Math.ceil(snapRadiusM / cellSizeM) + 1);
		const pans = panReport(ncAreaM2(nCells, found.nc, rowM2), found.pans, found.onRiver);
		let areaM2 = 0;
		for (let i = 0; i < mask.length; i++) if (mask[i]) areaM2 += rowM2[Math.floor(i / nCells)]!;
		const ox = outlet % nCells;
		const oy = (outlet - ox) / nCells;
		const outletPos = toLonLat(x0 + ox + 0.5, y0 + oy + 0.5, W);
		const snapDistanceM = Math.hypot(x0 + ox + 0.5 - gx, y0 + oy + 0.5 - gy) * cellSizeM;
		const cellM = Math.round(cellSizeM);
		return {
			click,
			outlet: outletPos,
			snapDistanceM,
			catchment: { mask, n: nCells, x0, y0, W, rowM2 },
			cells,
			areaM2,
			cellSizeM,
			zoom: z,
			windowCells: nCells,
			dataset: info,
			pans,
			method: delineationMethod({ cellM, zoom: z, snapRadiusM, kept: !!placed.larger }),
			methodVersion: METHOD_VERSION
		};
	}
	// Unreachable: the last window either returns or throws.
	throw new DelineationRefused('too_large', 'The catchment above that point is too large to delineate.');
}
