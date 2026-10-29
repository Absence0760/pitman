// Copied from IC-WBT (Absence0760/project-water-management, MIT) backend/src/geo/rainMap.ts (rainMapFromJson,
// RainMapGrid, MAP_MAX_MM, WAAS_MAP) and backend/src/geo/evaporationGrid.ts (originOf, indexOf) at
// f888e4461, stripped per docs/data.md § Code to copy: IC-WBT keeps MAP grids in its database; Pitman has
// none, so it reads the JSON file and indexes it in memory (indexRainMap, Pitman's own).
//
// A grid's cells are keyed by their south-west corner's indices from the dataset's origin (the origin
// being the grid's offset in [0, cellDeg) from whole multiples of the cell size), as IC-WBT's table keys
// them.

/** The Southwestern Cape surface's credit line, as its authors give it (D-4: Pitman's use pending the operator's decision). */
export const WAAS_MAP_ATTRIBUTION =
	'Mean annual rainfall surface for the Southwestern Cape. Prepared for the WAAS project by Beuster Clarke & Associates. March 2007, Version 1.1.';

/** The origin (0 ≤ origin < cell) of the grid whose cells are centred on `centre`. */
export const originOf = (centre: number, cellDeg: number): number => {
	const o = (((centre - cellDeg / 2) % cellDeg) + cellDeg) % cellDeg;
	return o > cellDeg - 1e-9 ? 0 : round9(o);
};
const round9 = (x: number) => Math.round(x * 1e9) / 1e9;

/** A cell centre → its indices in the grid with this origin. */
export const indexOf = (centre: number, origin: number, cellDeg: number) => Math.floor((centre - origin) / cellDeg + 1e-6);

export interface RainMapGrid {
	cellDeg: number;
	originLon: number;
	originLat: number;
	cells: { row: number; col: number; mapMm: number }[];
}

const MAP_MAX_MM = 20_000;
const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

/** The fixture's JSON form → the grid and its own source lines, or why it can't be read. */
export function rainMapFromJson(doc: unknown): { grid: RainMapGrid; meta: { source?: string; version?: string; attribution?: string } } | string {
	const d = doc as { cellDeg?: unknown; cells?: unknown; source?: unknown; version?: unknown; attribution?: unknown };
	const cellDeg = Number(d?.cellDeg);
	if (!(cellDeg > 0 && cellDeg <= 1)) return 'the JSON file has no "cellDeg" between 0 and 1';
	if (!Array.isArray(d.cells) || !d.cells.length || !Array.isArray(d.cells[0])) return 'the JSON file has no "cells" of [lon, lat, mapMm]';
	const [lon0, lat0] = (d.cells[0] as unknown[]).map(Number) as [number, number];
	const grid: RainMapGrid = { cellDeg, originLon: originOf(lon0, cellDeg), originLat: originOf(lat0, cellDeg), cells: [] };
	for (const [i, c] of (d.cells as unknown[]).entries()) {
		const [lon, lat, v] = Array.isArray(c) ? c.map(Number) : [];
		if (!(Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lon!) <= 180 && Math.abs(lat!) <= 90)) return `cell ${i + 1}: not [lon, lat, mapMm]`;
		if (!(Number.isFinite(v) && v! >= 0 && v! <= MAP_MAX_MM)) return `cell ${i + 1}: not a MAP of 0–${MAP_MAX_MM} mm`;
		if (Math.abs(originOf(lon!, cellDeg) - grid.originLon) > 1e-6 || Math.abs(originOf(lat!, cellDeg) - grid.originLat) > 1e-6) return `cell ${i + 1}: its centre isn't on the first cell's ${cellDeg}° grid`;
		grid.cells.push({ row: indexOf(lat!, grid.originLat, cellDeg), col: indexOf(lon!, grid.originLon, cellDeg), mapMm: v! });
	}
	return { grid, meta: { source: text(d.source, 500), version: text(d.version, 100), attribution: text(d.attribution, 500) } };
}

/** A MAP grid held in memory: a dense Float32Array over its cells' bounding rows and columns, NaN for no value. */
export interface IndexedRainMap {
	/** The grid's name, as the sidecar records it (MapGridSample.grid). */
	dataset: string;
	source: string;
	version: string;
	attribution: string;
	cellDeg: number;
	originLon: number;
	originLat: number;
	row0: number;
	col0: number;
	rows: number;
	cols: number;
	values: Float32Array;
	/** Cells with a value. */
	cells: number;
}

/** The most cells (with or without a value) a grid's bounding box may hold in memory: 100 M float32s is 400 MB. */
export const MAX_INDEXED_CELLS = 100_000_000;

/** Index a parsed grid. */
export function indexRainMap(dataset: string, grid: RainMapGrid, meta: { source?: string; version?: string; attribution?: string }): IndexedRainMap {
	let [r0, r1, c0, c1] = [Infinity, -Infinity, Infinity, -Infinity];
	for (const c of grid.cells) (r0 = Math.min(r0, c.row)), (r1 = Math.max(r1, c.row)), (c0 = Math.min(c0, c.col)), (c1 = Math.max(c1, c.col));
	const rows = r1 - r0 + 1;
	const cols = c1 - c0 + 1;
	if (!(rows > 0 && cols > 0)) throw new RangeError('the grid has no cell');
	if (rows * cols > MAX_INDEXED_CELLS) throw new RangeError(`the grid's box holds ${rows * cols} cells, more than the ${MAX_INDEXED_CELLS} the API keeps in memory`);
	const values = new Float32Array(rows * cols).fill(Number.NaN);
	for (const c of grid.cells) values[(c.row - r0) * cols + (c.col - c0)] = c.mapMm;
	return {
		dataset,
		source: meta.source ?? dataset,
		version: meta.version ?? '',
		attribution: meta.attribution ?? '',
		cellDeg: grid.cellDeg,
		originLon: grid.originLon,
		originLat: grid.originLat,
		row0: r0,
		col0: c0,
		rows,
		cols,
		values,
		cells: grid.cells.length
	};
}

/** The MAP of cell (row, col), or NaN where the grid has none. */
export function rainMapAt(g: IndexedRainMap, row: number, col: number): number {
	const r = row - g.row0;
	const c = col - g.col0;
	if (r < 0 || c < 0 || r >= g.rows || c >= g.cols) return Number.NaN;
	return g.values[r * g.cols + c]!;
}
