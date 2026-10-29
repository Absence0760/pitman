// CHIRPS constants the copied reader takes from IC-WBT's feeds/config.ts (CHIRPS_CELL_DEG,
// WeightedCell), local so no feed configuration comes with them, plus Pitman's own cell limit.

/** CHC's grid step, degrees. */
export const CHIRPS_CELL_DEG = 0.05;

/**
 * The most 0.05° cells one area may cover (docs/theory/extend.md § Step 1): about 50 000 km² at South
 * African latitudes, since a rainfall zone can be several quaternaries. IC-WBT's feed limit is 100.
 */
export const CHIRPS_MAX_CELLS = 2_000;

/** A cell centre and its weight (share inside × cos latitude). */
export interface WeightedCell {
	lat: number;
	lon: number;
	weight: number;
}
