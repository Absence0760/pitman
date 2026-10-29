// The mean MAP over an area from a MAP grid (POST /map-grid/mean (/api/map-grid/mean through CloudFront); docs/data.md § MAP grids, D6), as
// IC-WBT's geo/unitMap.ts takes a unit's: the area-weighted mean of the grid's cells,
//     Σ over the cells with a value: cell area on the ellipsoid × share of the cell inside × MAP
//     ÷ Σ over the same cells: cell area × share inside,
// with the shares from geo/gridShares.ts (exact clipping). Below MIN_MAP_COVERAGE of the area with a
// value, the grid doesn't describe the area.
//
// D6: with several grids configured, the finest one covering the area answers; one grid, never a mix.
import type { MapGridSample } from '@pitman/wrsm';
import type { Geometry } from '../geo/geojson.js';
import { cellAreaM2, gridShares, toGrid } from '../geo/gridShares.js';
import { type IndexedRainMap, rainMapAt } from './rainMap.js';

/** Below this share of the area with values, the grid doesn't cover it (IC-WBT's MIN_UNIT_COVERAGE). */
export const MIN_MAP_COVERAGE = 0.9;
/** The most grid cells an area's bounding box may span on one grid (1° × 1° at ~100 m), a bound on the clipping. */
export const MAX_AREA_MAP_CELLS = 1_000_000;

/** What the API answers: MapGridSample plus the grid's provenance (rule 8). */
export interface MapGridMean extends MapGridSample {
	cellDeg: number;
	/** Share of the area with a grid value, %. */
	coveragePct: number;
	version: string;
	attribution: string;
	/** Which store the grid came from (local-first). */
	source: 'local' | 's3';
}

export type GridOver = { ok: true; meanMapMm: number; cells: number; coverage: number; cellM2: number } | { ok: false; reason: string };

/** The area over one grid. Pure. */
export function areaOverGrid(g: Geometry, grid: IndexedRainMap, maxCells = MAX_AREA_MAP_CELLS): GridOver {
	const shares = gridShares(toGrid(g, grid), grid.cellDeg, maxCells, undefined, 'MAP grid');
	if ('problem' in shares) return { ok: false, reason: shares.problem };
	let total = 0;
	let covered = 0;
	let sum = 0;
	let n = 0;
	let cellM2 = 0;
	for (const s of shares.cells) {
		// The cell's area where it really is (the shift only aligned the grid).
		const area = cellAreaM2(s.col * grid.cellDeg + grid.originLon, s.row * grid.cellDeg + grid.originLat, grid.cellDeg);
		const w = area * s.share;
		total += w;
		const v = rainMapAt(grid, s.row, s.col);
		if (Number.isNaN(v)) continue;
		covered += w;
		sum += w * v;
		cellM2 += area;
		n++;
	}
	const coverage = total > 0 ? Math.min(1, covered / total) : 0;
	if (!(covered > 0)) return { ok: false, reason: `${grid.dataset} has no value inside the area` };
	if (coverage < MIN_MAP_COVERAGE) {
		return { ok: false, reason: `${grid.dataset} has values for only ${Math.round(coverage * 100)} % of the area (at least ${Math.round(MIN_MAP_COVERAGE * 100)} % is needed)` };
	}
	return { ok: true, meanMapMm: Math.round(sum / covered), cells: n, coverage, cellM2: cellM2 / n };
}

/** The area's mean MAP from the finest grid covering it, or every grid's reason it doesn't. */
export function mapGridMean(g: Geometry, grids: readonly { grid: IndexedRainMap; source: 'local' | 's3' }[], today: string): MapGridMean | { reasons: string[] } {
	const reasons: string[] = [];
	for (const { grid, source } of [...grids].sort((a, b) => a.grid.cellDeg - b.grid.cellDeg)) {
		const r = areaOverGrid(g, grid);
		if (!r.ok) {
			reasons.push(r.reason);
			continue;
		}
		return {
			grid: grid.dataset,
			cellSizeM: Math.round(Math.sqrt(r.cellM2)),
			cellCount: r.cells,
			meanMapMm: r.meanMapMm,
			fetchedOn: today,
			cellDeg: grid.cellDeg,
			coveragePct: Math.round(r.coverage * 1000) / 10,
			version: grid.version,
			attribution: grid.attribution,
			source
		};
	}
	return { reasons };
}
