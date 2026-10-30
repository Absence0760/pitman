// Copied from IC-WBT backend/src/delineation/valleyFixture.ts at f888e4461 (MIT, same author).
// An invented valley read straight from a function (no archive), for the
// window tests of Delineate and the sub-catchments (delineate.windows.test.ts,
// subcatchments.windows.test.ts; persona-hydrologist, issue #390, findings
// 1, 2 and 6): a long, narrow valley running north from its outlet, longer
// than half the windows the tests give, so a window centred on the click cuts
// it. 64 px tiles at zoom 11, about 265 m cells at 30° S. Test support only.
import type { Dem, DemInfo } from './dem.js';
import { toLonLat, toPx } from './delineate.js';

const Z = 11;
const TILE = 64;
const W = 2 ** Z * TILE;
export const [OX, OY] = toPx(25, -30, W).map(Math.floor) as [number, number];
/** Half the valley's width (cells). */
export const HW = 6;
/** The tile size, for a hole's tile row. */
export const VALLEY_TILE = TILE;

/**
 * Elevation (m) at (u, v) cells from the outlet (v north is negative): the
 * valley's floor rising 0.2 m a cell up to v = −length and 1 m a cell from
 * its axis, a ridge 10 m above it, falling 2 m a cell away beyond; the river
 * leaves south down column 0.
 */
export function valley(length: number) {
	return (u: number, v: number): number => {
		if (u === 0 && v > 0) return 100 - 0.5 * v;
		const rise = 0.2 * Math.min(length, Math.max(0, -v));
		if (Math.abs(u) <= HW && v <= 0 && v >= -length) return 100 + rise + Math.abs(u);
		const d = Math.hypot(Math.max(0, Math.abs(u) - HW), Math.max(0, v, -length - v));
		return 100 + rise + HW + 10 - 2 * d;
	};
}

/** A DEM of `elevation`, with no tile at all north of tile row `holeAbove` (global, zoom 11) when given: the extract's edge. */
export function functionDem(elevation: (u: number, v: number) => number, holeAbove?: number): Dem {
	const info: DemInfo = { label: 'Invented valley', attribution: '', fingerprint: '0123456789abcdef', tileType: 'png', maxZoom: Z, bounds: [16, -35, 33, -22] };
	return {
		info: async () => info,
		tile: async (z, x, y) => {
			if (z !== Z || (holeAbove !== undefined && y < holeAbove)) return null;
			const t = new Float32Array(TILE * TILE);
			for (let py = 0; py < TILE; py++) for (let px = 0; px < TILE; px++) t[py * TILE + px] = elevation(x * TILE + px - OX, y * TILE + py - OY);
			return { size: TILE, z: t };
		}
	};
}

/** The lon, lat of cell (u, v)'s centre. */
export const at = (u: number, v: number) => toLonLat(OX + u + 0.5, OY + v + 0.5, W);
