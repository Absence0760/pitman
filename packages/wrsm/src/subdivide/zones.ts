/**
 * The geometry of a MAP-zone split, and the vector booleans of method B
 * (docs/theory/subdivide.md §§ Hydrological split step 5, MAP-zone split).
 *
 * Booleans are `polyclip-ts` (docs/data.md); `differenceGeometry` is exported
 * so the delineation can take `Q − T` from here rather than add a second
 * copy of the dependency.
 */

import { difference, intersection, union } from 'polyclip-ts';

import type { AreaGeometry } from '../extend/contract.js';
import type { MapGridCells, SplitByZone, ZoneFromThreshold } from './contract.js';
import { cellAreaKm2, geometryAreaKm2 } from './geodesic.js';
import { insideRing, simplifyRing, traceRings, type Pt } from './outline.js';

/** Regions and pieces under this are dropped or refused: the DEM's channel threshold (subdivide.md). */
const MIN_REGION_KM2 = 1;

type MultiPolygonCoordinates = [number, number][][][];

function asCoordinates(geometry: AreaGeometry): MultiPolygonCoordinates {
	return (geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates) as unknown as MultiPolygonCoordinates;
}

function asGeometry(polygons: MultiPolygonCoordinates): AreaGeometry | null {
	const kept = polygons.filter((p) => p.length > 0);
	if (kept.length === 0) return null;
	return kept.length === 1 ? { type: 'Polygon', coordinates: kept[0]! } : { type: 'MultiPolygon', coordinates: kept };
}

/** `a − b`; `null` when nothing is left. A Polygon, or a MultiPolygon when `b` cuts `a` in two. */
export function differenceGeometry(a: AreaGeometry, b: AreaGeometry): AreaGeometry | null {
	return asGeometry(difference(asCoordinates(a), asCoordinates(b)));
}

/** `a ∩ b`; `null` when they don't meet. */
export function intersectGeometry(a: AreaGeometry, b: AreaGeometry): AreaGeometry | null {
	return asGeometry(intersection(asCoordinates(a), asCoordinates(b)));
}

/** Whether `[lon, lat]` lies in the geometry (inside an outer ring, outside its holes). */
export function pointInGeometry(point: readonly [number, number], geometry: AreaGeometry): boolean {
	const p: Pt = [point[0], point[1]];
	const polygons = asCoordinates(geometry);
	return polygons.some((rings) => rings[0] !== undefined && insideRing(p, rings[0]) && !rings.slice(1).some((hole) => insideRing(p, hole)));
}

/** The cells of the mask 8-connected to one another (the outline keeps cells that touch at a corner as one piece), each a list of `y·nx + x`. */
function regionsOf(nx: number, ny: number, mask: Uint8Array): number[][] {
	const seen = new Uint8Array(mask.length);
	const regions: number[][] = [];
	for (let start = 0; start < mask.length; start++) {
		if (mask[start] !== 1 || seen[start] === 1) continue;
		const cells: number[] = [];
		const stack = [start];
		seen[start] = 1;
		while (stack.length > 0) {
			const c = stack.pop()!;
			cells.push(c);
			const x = c % nx;
			const y = (c - x) / nx;
			for (let dy = -1; dy <= 1; dy++) {
				for (let dx = -1; dx <= 1; dx++) {
					const xx = x + dx;
					const yy = y + dy;
					if (xx < 0 || yy < 0 || xx >= nx || yy >= ny) continue;
					const n = yy * nx + xx;
					if (mask[n] === 1 && seen[n] !== 1) {
						seen[n] = 1;
						stack.push(n);
					}
				}
			}
		}
		regions.push(cells);
	}
	return regions;
}

/**
 * The cells with `MAP ≥ t` (high) or `MAP ≤ t` (low) whose centres lie in
 * `within`, as a polygon: regions under 1 km² dropped, outlined along cell
 * edges, simplified by half a cell (subdivide.md § MAP-zone split). A hole
 * under 1 km² is filled, the same size rule for what isn't zone (R5-E12).
 * `null` when no region survives. The outline follows cells, so it may stand
 * a little outside `within`: `splitByZone` clips it.
 */
export const zoneFromThreshold: ZoneFromThreshold = (cells: MapGridCells, within, thresholdMm, side) => {
	const { cols: nx, rows: ny, cellDeg, originLon, originLat, values } = cells;
	const lonOf = (x: number) => originLon + (x - 0.5) * cellDeg;
	const latOf = (y: number) => originLat - (y - 0.5) * cellDeg;
	const mask = new Uint8Array(nx * ny);
	for (let y = 0; y < ny; y++) {
		for (let x = 0; x < nx; x++) {
			const v = values[y * nx + x];
			if (v === null || v === undefined) continue;
			if (!(side === 'high' ? v >= thresholdMm : v <= thresholdMm)) continue;
			if (pointInGeometry([originLon + x * cellDeg, originLat - y * cellDeg], within)) mask[y * nx + x] = 1;
		}
	}
	const polygons: MultiPolygonCoordinates = [];
	for (const region of regionsOf(nx, ny, mask)) {
		let km2 = 0;
		let x0 = nx;
		let x1 = 0;
		let y0 = ny;
		let y1 = 0;
		for (const c of region) {
			const x = c % nx;
			const y = (c - x) / nx;
			km2 += cellAreaKm2(latOf(y), latOf(y + 1), cellDeg);
			x0 = Math.min(x0, x);
			x1 = Math.max(x1, x);
			y0 = Math.min(y0, y);
			y1 = Math.max(y1, y);
		}
		if (km2 < MIN_REGION_KM2) continue;
		// The region alone on its own bounding box, so many small regions don't each walk the whole grid.
		const w = x1 - x0 + 1;
		const h = y1 - y0 + 1;
		const own = new Uint8Array(w * h);
		for (const c of region) {
			const x = c % nx;
			const y = (c - x) / nx;
			own[(y - y0) * w + (x - x0)] = 1;
		}
		const minHoleCells = Math.max(1, Math.ceil((MIN_REGION_KM2 * region.length) / km2));
		const { outer, holes } = traceRings(w, h, own, minHoleCells);
		const toLonLat = (ring: readonly Pt[]): Pt[] => simplifyRing(ring, 0.5).map(([x, y]) => [lonOf(x + x0), latOf(y + y0)]);
		polygons.push([toLonLat(outer), ...holes.map(toLonLat)]);
	}
	if (polygons.length === 0) return null;
	// Union leaves valid, separate polygons whatever the half-cell simplification did where two regions run close.
	return asGeometry(union(polygons[0]!, ...polygons.slice(1)));
};

/**
 * `Z_q = Z ∩ Q` and `Rest = Q − Z_q`. Areas are geodesic, `A_Rest = area(Q) −
 * A_Z`, so they add up exactly (subdivide.md § MAP-zone split). Refused when
 * either piece is under 1 km².
 */
export const splitByZone: SplitByZone = (within, zone) => {
	const inside = intersectGeometry(within, zone);
	const zoneKm2 = inside ? geometryAreaKm2(inside) : 0;
	if (!inside || zoneKm2 < MIN_REGION_KM2) throw new Error('the zone covers less than 1 km² of the quaternary: there is nothing to split');
	const rest = differenceGeometry(within, zone);
	const restKm2 = geometryAreaKm2(within) - zoneKm2;
	if (!rest || restKm2 < MIN_REGION_KM2) throw new Error('the zone leaves less than 1 km² of the quaternary: there is nothing to split');
	return { zone: inside, rest, zoneKm2, restKm2 };
};
