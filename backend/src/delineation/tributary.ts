// One tributary of a quaternary, from a click (docs/theory/subdivide.md § Hydrological split): delineate
// the catchment `D` draining to the click (delineate.ts), clip it to the piece being split **in raster
// space**, outline what is left and take the remainder by vector difference.
//
// Two deliberate additions to the spec's steps 4–5 (decision R5-D2), both from what a raster edge does to a
// vector difference:
//   - `T` keeps its largest connected piece. A catchment that leaves `Q` and comes back is several pieces;
//     the outline is one polygon, and the pieces dropped are reported with the rest of `D` outside `Q`.
//   - Where `T` reaches `Q`'s boundary its outline steps cell by cell, so `Q − T` alone would leave dozens
//     of slivers along the shared edge. Remainder parts under SLIVER_KM2 are given to the tributary:
//     `R = Q − T_poly` without them, then `T = Q − R`, so the two meet along `R`'s edge and `T`'s outer edge is
//     `Q`'s own. `A_T` is then `area(T)` and `A_R = area(Q) − A_T` as the spec says.
import type { AreaGeometry } from '@pitman/wrsm';
import { geometryAreaM2, polygonAreaM2 } from '../geo/area.js';
import { checkGeometry, pointInRing, type Geometry, type Position } from '../geo/geojson.js';
import { delineate, DelineationRefused, toLonLat, toPx, type CatchmentMask, type Delineation } from './delineate.js';
import type { Dem } from './dem.js';
import { differenceGeometry } from './difference.js';
import { simplifyRing, traceRings, type Pt } from './outline.js';
import { rasterize } from './rasterize.js';

/** `A_T` below this is refused: the DEM's own channel threshold (subdivide.md). */
export const MIN_TRIBUTARY_KM2 = 1;
/** `A_T` above this share of `area(Q)` is refused. */
export const MAX_TRIBUTARY_SHARE = 0.95;
/** More of `D` than this outside `Q` (%) warns. */
export const OUTSIDE_WARNING_PCT = 20;
/** Subdivide.md § Hydrological split, step 3, word for word. */
export const OUTSIDE_WARNING =
	'most of this river’s catchment is outside the quaternary; its flow from upstream already reaches this quaternary by route. Click further down a tributary that rises inside it.';
/** Subdivide.md § Hydrological split, word for word bar the capital and the stop. */
export const WHOLE_QUATERNARY_TEXT = 'The tributary is almost the whole quaternary: there is nothing to split.';
/** The outline's simplification, in cells: about one cell (the spec), less only when that won't make valid polygons. */
export const OUTLINE_TOLERANCES = [1, 0.75, 0.5, 0.25, 0];
/** Remainder parts smaller than this (km², about 100 cells) are the raster edge's slivers, not a piece of the catchment. */
export const SLIVER_KM2 = 0.1;

const tooSmall = (km2: number) =>
	new DelineationRefused(
		'too_small',
		`Only ${km2.toFixed(2)} km² of that catchment is inside the quaternary, under the elevation model’s ${MIN_TRIBUTARY_KM2} km² channel threshold. Click further down the channel.`
	);

const polygonsOf = (g: AreaGeometry) => (g.type === 'Polygon' ? [g.coordinates] : g.coordinates);

/** Whether a point lies in the geometry: in an outer ring and in none of its holes. */
export function pointInArea(p: Position, g: AreaGeometry): boolean {
	return polygonsOf(g).some(([outer, ...holes]) => pointInRing(p, outer as Position[]) && !holes.some((h) => pointInRing(p, h as Position[])));
}

/** The largest 8-connected piece of a mask (D8 joins cells at a corner), as a new mask. */
export function largestPiece(n: number, mask: Uint8Array): Uint8Array {
	const label = new Int32Array(mask.length);
	const stack: number[] = [];
	let best = 0;
	let bestCells = 0;
	let next = 0;
	for (let i = 0; i < mask.length; i++) {
		if (!mask[i] || label[i]) continue;
		next++;
		let cells = 0;
		label[i] = next;
		stack.push(i);
		while (stack.length) {
			const c = stack.pop()!;
			cells++;
			const x = c % n;
			const y = (c - x) / n;
			for (let dy = -1; dy <= 1; dy++) {
				for (let dx = -1; dx <= 1; dx++) {
					const nx = x + dx;
					const ny = y + dy;
					if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
					const k = ny * n + nx;
					if (mask[k] && !label[k]) {
						label[k] = next;
						stack.push(k);
					}
				}
			}
		}
		if (cells > bestCells) {
			bestCells = cells;
			best = next;
		}
	}
	const out = new Uint8Array(mask.length);
	for (let i = 0; i < mask.length; i++) if (label[i] === best && best > 0) out[i] = 1;
	return out;
}

/** The rings' outline as a checked polygon at a simplification tolerance (cells), or null when it isn't valid. */
function outlinePolygon(rings: Pt[][], c: CatchmentMask, tol: number): AreaGeometry | null {
	// Traced with the region on the left in y-down cells, clockwise on the map: reversed, for GeoJSON's counter-clockwise outer ring.
	const coordinates = rings.map((r) => simplifyRing(r, tol).map(([x, y]) => toLonLat(c.x0 + x, c.y0 + y, c.W)).reverse());
	const checked = checkGeometry({ type: 'Polygon', coordinates });
	return 'geometry' in checked ? (checked.geometry as AreaGeometry) : null;
}

/** The parts of a geometry at least `minKm2`, or null when none is. */
function keepParts(g: AreaGeometry | null, minKm2: number): AreaGeometry | null {
	if (!g) return null;
	const parts = polygonsOf(g).filter((p) => polygonAreaM2(p as Position[][]) / 1e6 >= minKm2);
	if (parts.length === 0) return null;
	return parts.length === 1 ? { type: 'Polygon', coordinates: parts[0]! } : { type: 'MultiPolygon', coordinates: parts };
}

/** The geometry through the API's own check (coordinates rounded to 1e-7°), or null: what `/map-grid/mean` will take. */
function checked(g: AreaGeometry): { geometry: AreaGeometry; km2: number } | null {
	const c = checkGeometry(g as unknown as Geometry);
	return 'problem' in c || c.areaM2 === null ? null : { geometry: c.geometry as AreaGeometry, km2: c.areaM2 / 1e6 };
}

/**
 * `Q` split along an outline: the two pieces, checked, or null when the boolean gives up on near-degenerate rings or
 * rounding its new vertices makes a ring touch itself. Both come from a vertex of the outline falling a hair from one of `Q`'s,
 * so another tolerance, which moves the outline's vertices, gets past them. Refuses as the spec says.
 */
function split(within: AreaGeometry, outline: AreaGeometry, areaQ: number): { tributary: AreaGeometry; remainder: AreaGeometry; km2: number } | null {
	let remainderParts: AreaGeometry | null;
	let tributaryParts: AreaGeometry | null;
	try {
		remainderParts = keepParts(differenceGeometry(within, outline), SLIVER_KM2);
		if (!remainderParts) throw new DelineationRefused('whole_quaternary', WHOLE_QUATERNARY_TEXT);
		tributaryParts = keepParts(differenceGeometry(within, remainderParts), SLIVER_KM2);
	} catch (err) {
		if (err instanceof DelineationRefused) throw err;
		console.error('polygon difference failed', err);
		return null;
	}
	if (!tributaryParts) throw tooSmall(0);
	const tributary = checked(tributaryParts);
	const remainder = checked(remainderParts);
	if (!tributary || !remainder) return null;
	if (tributary.km2 < MIN_TRIBUTARY_KM2) throw tooSmall(tributary.km2);
	if (tributary.km2 > MAX_TRIBUTARY_SHARE * areaQ) throw new DelineationRefused('whole_quaternary', WHOLE_QUATERNARY_TEXT);
	return { tributary: tributary.geometry, remainder: remainder.geometry, km2: tributary.km2 };
}

export interface Tributary {
	tributary: AreaGeometry;
	remainder: AreaGeometry;
	tributaryKm2: number;
	remainderKm2: number;
	outsideKm2: number;
	outsidePct: number;
	warning: string | null;
	snapM: number;
	/** What drains into pans inside `D`, reported only (pans.ts). */
	pansKm2: number;
	delineation: Delineation;
}

/** The tributary of `within` draining to `click`. Throws DelineationRefused with a sentence for the user. */
export async function delineateTributary(
	dem: Dem,
	click: Position,
	within: AreaGeometry,
	opts: Parameters<typeof delineate>[2] = {}
): Promise<Tributary> {
	if (!pointInArea(click, within)) throw new DelineationRefused('outside', 'That point is outside the quaternary being split. Click on a terrain channel inside it.');
	const d = await delineate(dem, click, opts);
	const c = d.catchment;
	const { n, mask, rowM2 } = c;
	const toGrid = (p: readonly number[]): Pt => {
		const [px, py] = toPx(p[0]!, p[1]!, c.W);
		return [px - c.x0, py - c.y0];
	};
	const inQ = rasterize(n, n, polygonsOf(within).flatMap((rings) => rings.map((r) => r.map(toGrid))));
	const clipped = new Uint8Array(mask.length);
	for (let i = 0; i < mask.length; i++) clipped[i] = mask[i]! & inQ[i]!;
	const piece = largestPiece(n, clipped);
	let tributaryCells = 0;
	let outsideM2 = 0;
	for (let i = 0; i < mask.length; i++) {
		tributaryCells += piece[i]!;
		if (mask[i] && !piece[i]) outsideM2 += rowM2[Math.floor(i / n)]!;
	}
	if (tributaryCells === 0) throw tooSmall(0);

	const areaQ = geometryAreaM2(within as unknown as { type: string; coordinates: unknown })! / 1e6;
	const { outer, holes } = traceRings(n, n, piece, Math.ceil((SLIVER_KM2 * 1e6) / (d.cellSizeM * d.cellSizeM)));
	let pieces: ReturnType<typeof split> = null;
	for (const tol of OUTLINE_TOLERANCES) {
		const outline = outlinePolygon([outer, ...holes], c, tol);
		pieces = outline && split(within, outline, areaQ);
		if (pieces) break;
	}
	if (!pieces) {
		console.error('tributary outline failed at every tolerance');
		throw new DelineationRefused('outline', 'The tributary’s outline could not be made into a valid polygon. Click a little further along the channel.');
	}
	const outsidePct = (100 * outsideM2) / d.areaM2;
	return {
		tributary: pieces.tributary,
		remainder: pieces.remainder,
		tributaryKm2: pieces.km2,
		remainderKm2: areaQ - pieces.km2,
		outsideKm2: outsideM2 / 1e6,
		outsidePct,
		warning: outsidePct > OUTSIDE_WARNING_PCT ? OUTSIDE_WARNING : null,
		snapM: d.snapDistanceM,
		pansKm2: d.pans.nonContributingM2 / 1e6,
		delineation: d
	};
}
