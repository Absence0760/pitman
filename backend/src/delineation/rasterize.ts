// Copied from IC-WBT backend/src/delineation/subcatchments.ts at f888e4461 (MIT, same author): `rasterize` only.
import { DelineationRefused } from './delineate.js';
import type { Pt } from './outline.js';

/** Edge crossings one rasterize may find before the outline is refused as too intricate for the grid. */
export const RASTER_MAX_CROSSINGS = 1_000_000;

/**
 * Even–odd scanline fill of polygon rings (grid coordinates, a cell is 1 × 1,
 * centres at +0.5) into a mask. Each edge adds its crossings only to the rows
 * it spans (not every row to every edge), so the work is the edges plus their
 * crossings; past RASTER_MAX_CROSSINGS the outline is refused.
 */
export function rasterize(nx: number, ny: number, rings: readonly (readonly Pt[])[]): Uint8Array {
	const mask = new Uint8Array(nx * ny);
	const rows: number[][] = [];
	let crossings = 0;
	for (const r of rings) {
		for (let i = 0; i + 1 < r.length; i++) {
			const [ax, ay] = r[i]!;
			const [bx, by] = r[i + 1]!;
			if (!(ay !== by)) continue;
			// Rows whose centre cy = y + 0.5 lies in [min, max): exactly those where (ay > cy) !== (by > cy).
			const lo = Math.max(0, Math.ceil(Math.min(ay, by) - 0.5));
			const hi = Math.min(ny - 1, Math.ceil(Math.max(ay, by) - 0.5) - 1);
			if (hi < lo) continue;
			crossings += hi - lo + 1;
			if (crossings > RASTER_MAX_CROSSINGS) throw new DelineationRefused('outline', 'An outline on the map is too intricate to place on the elevation model: simplify it.');
			for (let y = lo; y <= hi; y++) {
				const cy = y + 0.5;
				(rows[y] ??= []).push(ax + ((cy - ay) * (bx - ax)) / (by - ay));
			}
		}
	}
	rows.forEach((xs, y) => {
		xs.sort((a, b) => a - b);
		for (let k = 0; k + 1 < xs.length; k += 2) {
			// Cells whose centre (x + 0.5) lies in [xs[k], xs[k+1]).
			const from = Math.max(0, Math.ceil(xs[k]! - 0.5));
			const to = Math.min(nx - 1, Math.ceil(xs[k + 1]! - 0.5) - 1);
			for (let x = from; x <= to; x++) mask[y * nx + x] = 1;
		}
	});
	return mask;
}
