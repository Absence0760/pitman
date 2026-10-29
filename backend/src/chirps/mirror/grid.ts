// Copied from IC-WBT (Absence0760/project-water-management, MIT) backend/src/mirror/grid.ts at f888e4461,
// stripped (docs/data.md § Code to copy): the 0.05° CHIRPS grid only. Dropped: the 0.1° products, the
// forecast grids and PRODUCT_GRIDS; `@water-management/engine/calendar` replaced by ./calendar.ts;
// GridCell and chcCell brought in from feeds/cellCache.ts (with feeds/sources/tiff.ts pixelOf's edge rule).
//
// The mirror's grid and its D2 index maths (issue #604). Pure: no store, no I/O.
//
// The copy holds the D1 region (10–41° E, 35.5–8° S) on CHC's 0.05° grid (620 columns × 550 rows,
// index [0, 0] the south-west cell centred at 35.475° S, 10.025° E). Rows grow northwards, as in CHC's
// NetCDF, and columns eastwards. Cells are named on the global grid of the same step (row 0 at 60° N,
// column 0 at 180° W, rows growing southwards: 2400 × 7200 cells), so every index here is computed from
// origin and step in whole cells, never by matching float coordinates.
import { fromEpochDay, toEpochDay } from './calendar.js';
import { FeedFormatError } from '../errors.js';

/** Degrees per cell, CHC's grid. */
export const MIRROR_STEP = 0.05;

/** D1: the region the copy holds, in degrees. */
export interface Region {
	w: number;
	s: number;
	e: number;
	n: number;
}
export const MIRROR_REGION: Region = { w: 10, s: -35.5, e: 41, n: -8 };

/** The grid attributes every mirror array carries, and every manifest. */
export interface MirrorGrid {
	origin: { lat: number; lon: number };
	step: number;
}

/** The centre of the south-west cell of `region`. */
export const gridOf = (region: Region, step = MIRROR_STEP): MirrorGrid => ({
	origin: { lat: round9(region.s + step / 2), lon: round9(region.w + step / 2) },
	step
});

/** Rows (south to north) and columns (west to east) of `region`, in whole cells. */
export function regionSize(region: Region, step = MIRROR_STEP): { rows: number; cols: number } {
	return { rows: Math.round((region.n - region.s) / step), cols: Math.round((region.e - region.w) / step) };
}

const round9 = (x: number) => Number(x.toFixed(9));

/** The global grid, as IC-WBT's cell cache names cells: its north-west corner. */
const CHC_TOP = 60;
const CHC_LEFT = -180;
const CHC_ROWS = Math.round(120 / MIRROR_STEP);
const CHC_COLS = Math.round(360 / MIRROR_STEP);

/** A cell of the global 0.05° grid: row from 60° N southwards, column from 180° W eastwards. */
export interface GridCell {
	row: number;
	col: number;
}

/**
 * The global grid cell holding a point (feeds/cellCache.ts chcCell over tiff.ts pixelOf): a point on a
 * cell edge belongs to the cell east / south of it, except on the grid's own east / south edge.
 */
export function chcCell(lat: number, lon: number): GridCell {
	const EPS = 1e-6;
	const index = (x: number, n: number) => {
		const i = Math.floor(x + EPS);
		return i === n && x - n < EPS ? n - 1 : i;
	};
	const col = index((lon - CHC_LEFT) / MIRROR_STEP, CHC_COLS);
	const row = index((CHC_TOP - lat) / MIRROR_STEP, CHC_ROWS);
	if (!(row >= 0 && col >= 0 && row < CHC_ROWS && col < CHC_COLS)) throw new RangeError(`the point ${lat}, ${lon} is outside the CHIRPS grid`);
	return { row, col };
}

/**
 * A cell the region doesn't hold. A FeedFormatError: asking again won't help until the region grows.
 */
export class MirrorOutsideRegionError extends FeedFormatError {
	constructor(lat: number, lon: number, region: Region) {
		super(
			`the point ${lat}, ${lon} is outside the region the rain data copy holds (${region.w}–${region.e}° E, ${-region.n}–${-region.s}° S)`
		);
	}
}

/** The mirror's (y, x) of a global grid cell: y counted north from the region's south edge, x east from its west edge. */
export interface MirrorCell {
	y: number;
	x: number;
}

/**
 * The mirror cell of a cell of the global grid, or a MirrorOutsideRegionError for a cell the region
 * doesn't hold. Whole-cell arithmetic: the offsets are rounded once from origin and step.
 */
export function mirrorCell(cell: GridCell, region: Region = MIRROR_REGION, step = MIRROR_STEP): MirrorCell {
	const { rows, cols } = regionSize(region, step);
	// The CHC row of the region's southernmost cell, and the CHC column of its westernmost.
	const southRow = Math.round((CHC_TOP - region.s) / step) - 1;
	const westCol = Math.round((region.w - CHC_LEFT) / step);
	const y = southRow - cell.row;
	const x = cell.col - westCol;
	if (y < 0 || y >= rows || x < 0 || x >= cols) {
		const lat = round9(CHC_TOP - (cell.row + 0.5) * step);
		const lon = round9(CHC_LEFT + (cell.col + 0.5) * step);
		throw new MirrorOutsideRegionError(lat, lon, region);
	}
	return { y, x };
}

/** The inverse of mirrorCell: the global grid cell of a mirror (y, x). */
export function chcCellOf(m: MirrorCell, region: Region = MIRROR_REGION, step = MIRROR_STEP): GridCell {
	const southRow = Math.round((CHC_TOP - region.s) / step) - 1;
	const westCol = Math.round((region.w - CHC_LEFT) / step);
	return { row: southRow - m.y, col: m.x + westCol };
}

/** The centre of a global grid cell. */
export const cellCentre = (c: GridCell): { lat: number; lon: number } => ({
	lat: round9(CHC_TOP - (c.row + 0.5) * MIRROR_STEP),
	lon: round9(CHC_LEFT + (c.col + 0.5) * MIRROR_STEP)
});

/** Whether `year` has a 29 February. */
export const isLeapYear = (year: number) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

/** The finals layout's day-of-year index of an ISO date: days since 1 January, 0–365 (365 only in a leap year). */
export const doyIndex = (iso: string) => toEpochDay(iso) - toEpochDay(`${iso.slice(0, 4)}-01-01`);

/** The date of a day-of-year index in `year`, or null for index 365 of a year with no such day. */
export function dateOfDoy(year: number, doy: number): string | null {
	if (doy < 0 || doy > 365 || (doy === 365 && !isLeapYear(year))) return null;
	return fromEpochDay(toEpochDay(`${year}-01-01`) + doy);
}

/**
 * The cells' chunks along (y, x) for a chunk shape (ch, cw), each with the bounding box (inclusive) of
 * the cells it holds: one read per chunk, never a box across the region between scattered cells.
 */
export function cellsByChunk(cells: readonly MirrorCell[], ch: number, cw: number): { y0: number; y1: number; x0: number; x1: number; cells: number[] }[] {
	const groups = new Map<string, { y0: number; y1: number; x0: number; x1: number; cells: number[] }>();
	cells.forEach((c, i) => {
		const key = `${Math.floor(c.y / ch)},${Math.floor(c.x / cw)}`;
		const g = groups.get(key);
		if (!g) groups.set(key, { y0: c.y, y1: c.y, x0: c.x, x1: c.x, cells: [i] });
		else {
			g.y0 = Math.min(g.y0, c.y);
			g.y1 = Math.max(g.y1, c.y);
			g.x0 = Math.min(g.x0, c.x);
			g.x1 = Math.max(g.x1, c.x);
			g.cells.push(i);
		}
	});
	return [...groups.values()];
}
