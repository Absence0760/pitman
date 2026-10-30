/**
 * Scaling polygon areas to a runoff module, and sharing a total out so the
 * rounded parts add back to it (docs/theory/subdivide.md § Areas, § Fields).
 *
 * A file holds a value only to its own precision (docs/formats.md §§5.1, 6,
 * 8): RU areas and land-use tables to 0.1 km² (`F7.1`, `F0.1`), RV capacity
 * tables to 0.01 (`F0.2`), and so on. The parts are worked out in whole file
 * units, so a sum never depends on how decimals add in binary.
 */

import type { PieceAreas, ScalePieceAreas } from './contract.js';

/**
 * A value as the file will hold it: float32, then rounded half away from
 * zero to `decimals` (docs/formats.md §2, as the writers do).
 */
export function fileRound(value: number, decimals: number): number {
	return Number(Math.fround(value).toFixed(decimals));
}

/**
 * `total` shared in proportion to `shares`, in steps of `10^-decimals`, by
 * the largest-remainder rule: each part is rounded down, then the units left
 * go to the largest remainders (a tie to the larger share, then the earlier
 * part). The parts add to `total` as the file holds it, in whole units.
 */
export function largestRemainder(total: number, shares: readonly number[], decimals: number): number[] {
	const sum = shares.reduce((a, b) => a + b, 0);
	if (!(sum > 0) || shares.some((s) => !(s >= 0))) throw new Error(`shares must be non-negative and not all zero (got ${shares.join(', ')})`);
	const unit = 10 ** decimals;
	const units = Math.round(Math.abs(fileRound(total, decimals)) * unit);
	const exact = shares.map((s) => (units * s) / sum);
	const parts = exact.map(Math.floor);
	const left = units - parts.reduce((a, b) => a + b, 0);
	const order = exact
		.map((x, i) => ({ i, remainder: x - Math.floor(x), share: shares[i]! }))
		.filter((p) => p.share > 0)
		.sort((a, b) => b.remainder - a.remainder || b.share - a.share || a.i - b.i);
	for (let k = 0; k < left; k++) parts[order[k % order.length]!.i]! += 1;
	const sign = total < 0 ? -1 : 1;
	return parts.map((p) => (sign * p) / unit);
}

/** RU L.002 AREA is `F7.1`. */
const AREA_DECIMALS = 1;

/** Outside this range of `A_module / Σ polygon`, the screen warns (B2). */
const SCALE_WARNING = { low: 0.95, high: 1.05 } as const;

/** `A_i = A_module · area_i / Σ area_j`, rounded so they sum to `A_module` (subdivide.md § Areas). */
export const scalePieceAreas: ScalePieceAreas = (moduleKm2, polygonKm2): PieceAreas => {
	const total = polygonKm2.reduce((a, b) => a + b, 0);
	if (!(total > 0)) throw new Error('the pieces have no area');
	const scale = moduleKm2 / total;
	const percent = Math.round(Math.abs(scale - 1) * 100);
	return {
		areasKm2: largestRemainder(moduleKm2, polygonKm2, AREA_DECIMALS),
		scale,
		warning:
			scale < SCALE_WARNING.low || scale > SCALE_WARNING.high
				? `the network's area for this module differs from its boundary by ${percent} %: check you picked the right quaternary`
				: null
	};
};
