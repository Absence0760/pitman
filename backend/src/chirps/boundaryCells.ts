// Copied from IC-WBT (Absence0760/project-water-management, MIT) backend/src/feeds/boundaryCells.ts at f888e4461,
// changed per docs/data.md § Code to copy: the limit is Pitman's 2 000 cells (docs/theory/extend.md § Step 1),
// with no rows limit (IC-WBT's 25 rows bound its per-row TIFF reads, which Pitman doesn't do), and
// CHIRPS_CELL_DEG / WeightedCell come from ./config.ts. The messages name the area, not a feed.
//
// The CHIRPS cells a catchment boundary covers (issue #326 B-rain, WP-2.10 ×
// WP-3.12; docs/maps.md § Rain from the boundary). Pure and dependency-free:
// the from-boundary routes (feeds/fromBoundary.ts) call it on the project's
// `catchment_boundary` map feature.
//
// Each 0.05° cell the boundary touches gets the weight
//     share of the cell inside the boundary × cos(the cell centre's latitude),
// the same weighting bboxCells gives a box (feeds/config.ts), so the feed's
// rainfall is the area-weighted mean over the boundary itself rather than over
// the box around it. Holes are subtracted; the parts of a MultiPolygon add up.
//
// Method: exact clipping, not sampling (geo/clip.ts). Every ring is clipped to each cell
// square with Sutherland–Hodgman (the cell is convex, so clipping a concave
// ring to it still gives a polygon whose signed area is exactly the area of
// the intersection: the extra edges the algorithm leaves along the cell's
// sides run there and back and cancel), and the share is that area over the
// cell's, in degrees. A ring is first clipped to its row of cells, then each
// row's piece to the row's cells, so the work is about (rows + cells) ×
// vertices. The share is exact to floating point; sampling on a fine grid
// would carry an error of the order of the sample spacing along the boundary
// and cost far more points for the same accuracy. Within a 0.05° cell the
// degree-space share and the true (ellipsoidal) share differ by under 1e-4,
// since the cell's width changes by that little from its bottom to its top.
//
// A cell with less than MIN_SHARE of its area inside is left out: its weight
// would move the mean by less than that share of one cell's rain, and every
// listed cell is read on every day (and must have data: a listed sea cell
// fails the fetch).
import { geometryAreaM2 } from '../geo/area.js';
import { eachBand, GRID_WORK_BUDGET, GridWorkExceeded, openRing as open, signedArea2, type SignedPiece } from '../geo/clip.js';
import type { Geometry, Position } from '../geo/geojson.js';
import { CHIRPS_CELL_DEG, CHIRPS_MAX_CELLS, type WeightedCell } from './config.js';

/** A cell with less than this share of its area inside the boundary is left out (0.1 % of a cell, about 0.03 km²). */
export const MIN_SHARE = 1e-3;
/**
 * The most grid rows or columns a boundary's extent may span before the
 * cells are even counted (10°): a bound on the work, far past the API's own
 * limit of CHIRPS_MAX_CELLS cells.
 */
export const MAX_SPAN = 200;
/** The limit, said the same way wherever a boundary is too big. */
const LIMIT = `one request reads at most ${CHIRPS_MAX_CELLS.toLocaleString('en-ZA')} cells (about 50 000 km² at South African latitudes): extend the file over fewer quaternaries`;
/** CHIRPS v3 covers 50° S to 50° N over land; the feed's grid check takes ±60 (config.ts Lat). */
const LAT_LIMIT = 60;

/** A cell the boundary covers: its centre, its weight (as bboxCells), and the share of it inside the boundary. */
export interface BoundaryCell extends WeightedCell {
	share: number;
}

export type BoundaryCellsResult =
	| {
			cells: BoundaryCell[];
			rows: number;
			/** The whole area of the cells read, km² (on the ellipsoid, geo/area.ts). */
			cellsKm2: number;
			/** The part of them inside the boundary, km² (each cell's area × its share): the boundary's area, less the slivers left out. */
			insideKm2: number;
	  }
	| { problem: string };

const EDGE_EPS = 1e-6;
const round = (x: number, places = 9) => Number(x.toFixed(places));

/** The cell indices [first, last) a pair of edges spans along one axis, a bound on a grid line adding no sliver (as config.ts span). */
const span = (lo: number, hi: number): [number, number] => [Math.floor(lo / CHIRPS_CELL_DEG + EDGE_EPS), Math.ceil(hi / CHIRPS_CELL_DEG - EDGE_EPS)];

/** Area of the 0.05° cell with south-west corner (west, south), km², on the ellipsoid. */
const cellKm2 = (west: number, south: number) => {
	const e = west + CHIRPS_CELL_DEG;
	const n = south + CHIRPS_CELL_DEG;
	return geometryAreaM2({ type: 'Polygon', coordinates: [[[west, south], [e, south], [e, n], [west, n], [west, south]]] })! / 1e6;
};

/**
 * The weighted CHIRPS cells of a Polygon or MultiPolygon boundary, or the
 * reason there are none it can use: too big for one feed, outside the grid,
 * or not a polygon. The geometry is one the map stored, so its rings are
 * already checked (closed, simple, holes inside: geo/geojson.ts). `what`
 * names the polygon in a problem (a unit's parcel, feeds/fromUnits.ts).
 */
export function boundaryCells(g: Geometry, what = 'the area'): BoundaryCellsResult {
	if (g.type !== 'Polygon' && g.type !== 'MultiPolygon') return { problem: `${what} is not a polygon` };
	const polygons = (g.type === 'Polygon' ? [g.coordinates] : g.coordinates).map((rings) => rings.map(open));
	let south = Infinity;
	let north = -Infinity;
	let west = Infinity;
	let east = -Infinity;
	for (const rings of polygons) {
		for (const [x, y] of rings[0] ?? []) {
			south = Math.min(south, y);
			north = Math.max(north, y);
			west = Math.min(west, x);
			east = Math.max(east, x);
		}
	}
	if (!(south < north && west < east)) return { problem: `${what} has no area` };
	if (south < -LAT_LIMIT || north > LAT_LIMIT) return { problem: `${what} reaches beyond ${LAT_LIMIT}° of latitude, outside the CHIRPS grid` };
	const [r0, r1] = span(south, north);
	const [c0, c1] = span(west, east);
	if (r1 - r0 > MAX_SPAN || c1 - c0 > MAX_SPAN) {
		return { problem: `${what} spans ${r1 - r0} rows and ${c1 - c0} columns of 0.05° cells; ${LIMIT}` };
	}
	const cellArea = CHIRPS_CELL_DEG * CHIRPS_CELL_DEG;
	const cells: BoundaryCell[] = [];
	const rows = new Set<number>();
	let cellsKm2 = 0;
	let insideKm2 = 0;
	// Each ring split into its rows, then each row's pieces into its cells, by halving (geo/clip.ts eachBand): the work
	// grows with the vertices times log(cells), not vertices × cells, so a crafted many-vertex ring stays cheap.
	const all: SignedPiece[] = polygons.flatMap((rings) => rings.map((ring, i) => ({ ring, sign: i === 0 ? 1 : -1 })));
	const work = { vertices: 0, limit: GRID_WORK_BUDGET };
	try {
		eachBand(all, r0, r1, CHIRPS_CELL_DEG, 'y', (r, pieces) => {
			const bottom = r * CHIRPS_CELL_DEG;
			const lat = round((r + 0.5) * CHIRPS_CELL_DEG);
			const cos = Math.cos((lat * Math.PI) / 180);
			eachBand(pieces, c0, c1, CHIRPS_CELL_DEG, 'x', (c, inCell) => {
				const left = c * CHIRPS_CELL_DEG;
				let area = 0;
				for (const p of inCell) area += (p.sign * Math.abs(signedArea2(p.ring))) / 2;
				const share = Math.min(1, area / cellArea);
				if (!(share >= MIN_SHARE)) return;
				const km2 = cellKm2(left, bottom);
				cellsKm2 += km2;
				insideKm2 += km2 * share;
				rows.add(r);
				cells.push({ lat, lon: round((c + 0.5) * CHIRPS_CELL_DEG), weight: round(share * cos), share: round(share, 6) });
			}, work);
		}, work);
	} catch (err) {
		if (err instanceof GridWorkExceeded) return { problem: `${what}’s outline is too detailed to read the CHIRPS cells under it (more than ${err.limit.toLocaleString('en-ZA')} vertex cuts); simplify it` };
		throw err;
	}
	if (!cells.length) return { problem: `${what} covers no 0.05° cell enough to read` };
	if (cells.length > CHIRPS_MAX_CELLS) {
		return { problem: `${what} covers ${cells.length} of the 0.05° CHIRPS cells in ${rows.size} rows; ${LIMIT}` };
	}
	return { cells, rows: rows.size, cellsKm2: round(cellsKm2, 3), insideKm2: round(insideKm2, 3) };
}
