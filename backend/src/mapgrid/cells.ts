// POST /map-grid/cells: the finest grid's values over a box, as one block (contract MapGridCells), for
// the map's MAP layer and the MAP-zone threshold. The box is bounded twice, so one request can't ask for
// a whole grid: at most MAP_GRID_BBOX_MAX_DEG a side (IC-WBT's limit) and at most MAP_GRID_MAX_CELLS
// cells. Cells are taken by their centres; the block is trimmed to the grid.
import type { MapGridCells } from '@pitman/wrsm';
import { ApiError } from '../http/errors.js';
import { type IndexedRainMap, rainMapAt } from './rainMap.js';

/** The widest box asked for, degrees a side. */
export const MAP_GRID_BBOX_MAX_DEG = 2;
/**
 * The most cells one answer carries: a ¼°-square quaternary on the ~100 m grid is 62 500, so this leaves
 * room for the largest, and is about 1.5 MB of JSON, well under Lambda's 6 MB.
 */
export const MAP_GRID_MAX_CELLS = 250_000;

export type Bbox = readonly [number, number, number, number];

/** The request body → the box, or an ApiError saying what is wrong: 400 for a malformed one, 422 with `code` for one too wide. */
export function parseBbox(body: unknown): Bbox {
	const bbox = (body as { bbox?: unknown } | null)?.bbox;
	if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every((v) => typeof v === 'number' && Number.isFinite(v))) {
		throw new ApiError(400, 'the body must be { "bbox": [west, south, east, north] } in degrees');
	}
	const [w, s, e, n] = bbox as [number, number, number, number];
	if (w < -180 || e > 180 || s < -90 || n > 90 || w >= e || s >= n) throw new ApiError(400, 'the bbox must be west < east and south < north, in degrees');
	if (e - w > MAP_GRID_BBOX_MAX_DEG || n - s > MAP_GRID_BBOX_MAX_DEG) {
		throw new ApiError(422, `the box is wider than ${MAP_GRID_BBOX_MAX_DEG}° a side; zoom in`, { code: 'too_wide' });
	}
	return [w, s, e, n];
}

/** The rows and columns of `g` whose cell centres lie in the box, inclusive; null when there are none. */
function cellRange(g: IndexedRainMap, [w, s, e, n]: Bbox) {
	const eps = 1e-9;
	const first = (lo: number, origin: number) => Math.ceil((lo - origin) / g.cellDeg - 0.5 - eps);
	const last = (hi: number, origin: number) => Math.floor((hi - origin) / g.cellDeg - 0.5 + eps);
	const col0 = Math.max(first(w, g.originLon), g.col0);
	const col1 = Math.min(last(e, g.originLon), g.col0 + g.cols - 1);
	const row0 = Math.max(first(s, g.originLat), g.row0);
	const row1 = Math.min(last(n, g.originLat), g.row0 + g.rows - 1);
	return col0 > col1 || row0 > row1 ? null : { col0, col1, row0, row1 };
}

/** Whether the grid has a value inside the range. */
function hasValue(g: IndexedRainMap, r: NonNullable<ReturnType<typeof cellRange>>): boolean {
	for (let row = r.row0; row <= r.row1; row++) for (let col = r.col0; col <= r.col1; col++) if (!Number.isNaN(rainMapAt(g, row, col))) return true;
	return false;
}

const round9 = (x: number) => Math.round(x * 1e9) / 1e9;

/** The block over the box, from the finest grid with a value in it (D6: one grid, never a mix). */
export function mapGridCells(grids: readonly IndexedRainMap[], box: Bbox): MapGridCells {
	for (const g of [...grids].sort((a, b) => a.cellDeg - b.cellDeg)) {
		const r = cellRange(g, box);
		if (!r) continue;
		const cols = r.col1 - r.col0 + 1;
		const rows = r.row1 - r.row0 + 1;
		// Before the scan: a box this dense is refused without touching its cells.
		if (rows * cols > MAP_GRID_MAX_CELLS) {
			throw new ApiError(422, `the box holds ${(rows * cols).toLocaleString('en-ZA')} cells of ${g.dataset}; at most ${MAP_GRID_MAX_CELLS.toLocaleString('en-ZA')} are sent, zoom in`, { code: 'too_dense' });
		}
		if (!hasValue(g, r)) continue;
		const values: (number | null)[] = [];
		for (let row = r.row1; row >= r.row0; row--) {
			for (let col = r.col0; col <= r.col1; col++) {
				const v = rainMapAt(g, row, col);
				// One decimal: the file's values are held as float32, which would print ~15 digits for nothing.
				values.push(Number.isNaN(v) ? null : Math.round(v * 10) / 10);
			}
		}
		return {
			dataset: g.dataset,
			source: g.source,
			cellDeg: g.cellDeg,
			originLon: round9(g.originLon + (r.col0 + 0.5) * g.cellDeg),
			originLat: round9(g.originLat + (r.row1 + 0.5) * g.cellDeg),
			cols,
			rows,
			values
		};
	}
	throw new ApiError(422, 'no MAP grid has a value in this box', { code: 'no_coverage' });
}
