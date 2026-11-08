// CHIRPS constants the copied reader takes from IC-WBT's feeds/config.ts (CHIRPS_CELL_DEG,
// WeightedCell), local so no feed configuration comes with them, plus Pitman's own cell limit.

/** CHC's grid step, degrees. */
export const CHIRPS_CELL_DEG = 0.05;

/**
 * The most 0.05° cells one area may cover (docs/theory/extend.md § Step 1): about 50 000 km² at South
 * African latitudes, since a rainfall zone can be several quaternaries. IC-WBT's feed limit is 100.
 */
export const CHIRPS_MAX_CELLS = 2_000;

/**
 * The most of the copy's chunks one area may touch (decision R4-D6). A chunk is 20 × 20 cells (1° × 1°,
 * mirror/arrays.ts FINALS_CHUNK) and a read costs one GET per chunk per year, so 16 chunks × 45 years is
 * about 720 GETs on IC-WBT's bucket. 16 is the smallest cap that refuses no compact area under the cell
 * limit: 2 000 cells is at most 45 cells a side, which straddles at most 4 chunks each way (4 × 4). A real
 * quaternary (under ~10 000 km², about 1° a side) touches at most 4, the six synthetic ones 1 together.
 * Without it a thin 2 000-cell strip across the 200-cell span could touch 11 × 11 = 121 chunks, ~5 400 GETs.
 */
export const CHIRPS_MAX_CHUNKS = 16;

/** A cell centre and its weight (share inside × cos latitude). */
export interface WeightedCell {
	lat: number;
	lon: number;
	weight: number;
}
