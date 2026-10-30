/**
 * The MAP-grid threshold tool's numbers (subdivide.md § MAP-zone split): the
 * grid values inside the piece, what range `t` can move over, and how much of
 * the piece a `t` proposes. The zone itself is the engine's
 * (`zoneFromThreshold`); these only tell the user what they're moving.
 */

import type { AreaGeometry, MapGridCells } from '@pitman/wrsm';
import { formatNumber } from '#lib/results/format.js';
import { pointInGeometry } from '#lib/subdivide/geometry.js';

/** `t` moves in steps of this, mm. */
export const THRESHOLD_STEP_MM = 10;

export type ZoneSide = 'high' | 'low';

/** The grid's values whose cell centres lie inside `within`, ascending. */
export function valuesInside(cells: MapGridCells, within: AreaGeometry): number[] {
	const values: number[] = [];
	for (let row = 0; row < cells.rows; row++) {
		const lat = cells.originLat - row * cells.cellDeg;
		for (let col = 0; col < cells.cols; col++) {
			const value = cells.values[row * cells.cols + col];
			if (value === null || value === undefined) continue;
			if (pointInGeometry(cells.originLon + col * cells.cellDeg, lat, within)) values.push(value);
		}
	}
	return values.sort((a, b) => a - b);
}

export interface ThresholdRange {
	/** Slider ends, on whole steps, outside the values. */
	readonly minMm: number;
	readonly maxMm: number;
	/** Where `t` starts: the median, on a step. */
	readonly startMm: number;
}

/** The slider for these values; `null` when the grid holds none or a single value (nothing to separate). */
export function thresholdRange(sorted: readonly number[]): ThresholdRange | null {
	const first = sorted[0];
	const last = sorted[sorted.length - 1];
	if (first === undefined || last === undefined || first === last) return null;
	const step = THRESHOLD_STEP_MM;
	const minMm = Math.floor(first / step) * step;
	const maxMm = Math.ceil(last / step) * step;
	const median = sorted[Math.floor(sorted.length / 2)] as number;
	return { minMm, maxMm, startMm: Math.min(maxMm, Math.max(minMm, Math.round(median / step) * step)) };
}

/** First index whose value passes `before` no longer holds. */
function firstIndex(sorted: readonly number[], before: (value: number) => boolean): number {
	let lo = 0;
	let hi = sorted.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (before(sorted[mid] as number)) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

export interface SideSummary {
	/** Cells on the zone's side. */
	readonly cells: number;
	readonly sharePct: number;
	/** Plain mean of the cells, mm: a guide, not the area-weighted MAP the pieces get. */
	readonly zoneMeanMm: number | null;
	readonly restMeanMm: number | null;
}

const mean = (values: readonly number[]) => (values.length === 0 ? null : values.reduce((s, v) => s + v, 0) / values.length);

/** How the values divide at `t`: `≥ t` for a high zone, `≤ t` for a low one. */
export function sideSummary(sorted: readonly number[], t: number, side: ZoneSide): SideSummary {
	const cut = firstIndex(sorted, side === 'high' ? (v) => v < t : (v) => v <= t);
	const low = sorted.slice(0, cut);
	const high = sorted.slice(cut);
	const [zone, rest] = side === 'high' ? [high, low] : [low, high];
	return { cells: zone.length, sharePct: sorted.length === 0 ? 0 : (100 * zone.length) / sorted.length, zoneMeanMm: mean(zone), restMeanMm: mean(rest) };
}

/** Why `t` as typed can't be used, or `null`. */
export function thresholdProblem(t: number | null, range: ThresholdRange): string | null {
	if (t === null || !Number.isFinite(t)) return 'Type the threshold in mm.';
	if (t < range.minMm || t > range.maxMm) return `The grid runs from ${range.minMm} to ${range.maxMm} mm over this piece: choose a threshold inside that.`;
	return null;
}

/** Why no zone came back. */
export function noZoneMessage(t: number, side: ZoneSide): string {
	return `No part of this piece over 1 km² has MAP ${side === 'high' ? 'at or above' : 'at or below'} ${formatNumber(t, 0)} mm. Move the threshold.`;
}
