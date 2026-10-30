/**
 * The target natural MAR (D2a, subdivide.md § The target): the WR2012 value
 * the user types with its citation, or, with none typed, the unsplit module's
 * own natural run, labelled as such. Both are always shown side by side.
 */

import type { CalibrationTarget, HydroYear } from '@pitman/wrsm';
import { parseFactor } from '#lib/extend/factors.js';
import { formatNumber, hydroYearLabel } from '#lib/results/format.js';

/** The contract's wording for the fallback (rule 8): it goes into the sidecar. */
export const UNSPLIT_TARGET_SOURCE = 'natural MAR of the unsplit module (no WR2012 value entered)';

/** Above this the two numbers are a warning (subdivide.md § The target). */
export const CROSS_CHECK_LIMIT_PCT = 5;

export interface UnsplitNatural {
	readonly marMm3: number;
	readonly period: { readonly startYear: HydroYear; readonly endYear: HydroYear };
}

export function periodLabel(period: UnsplitNatural['period']): string {
	return `${hydroYearLabel(period.startYear)} to ${hydroYearLabel(period.endYear)}`;
}

export function crossCheckOf(unsplit: UnsplitNatural): CalibrationTarget {
	return { marMm3: unsplit.marMm3, source: `unsplit module, natural run, ${periodLabel(unsplit.period)}` };
}

export type ResolvedTarget =
	| { readonly ok: true; readonly target: CalibrationTarget; readonly fallback: boolean }
	| { readonly ok: false; readonly field: 'mar' | 'citation'; readonly error: string };

/** The target from the two typed fields. A typed value needs its citation; no value falls back to the unsplit run. */
export function resolveTarget(marText: string, citation: string, unsplit: UnsplitNatural): ResolvedTarget {
	if (marText.trim() === '') {
		return { ok: true, fallback: true, target: { marMm3: unsplit.marMm3, source: UNSPLIT_TARGET_SOURCE } };
	}
	const value = parseFactor(marText);
	if (!Number.isFinite(value) || value <= 0) return { ok: false, field: 'mar', error: 'Type the natural MAR as a positive number, in million m³/year.' };
	if (citation.trim() === '') return { ok: false, field: 'citation', error: 'Say where the value comes from: the WR2012 volume and table.' };
	return { ok: true, fallback: false, target: { marMm3: value, source: `hand-entered: ${citation.trim().replace(/\s+/g, ' ')}` } };
}

/** How far the target is from the cross-check, % of the cross-check. */
export function differencePct(target: number, crossCheck: number): number {
	return crossCheck === 0 ? Infinity : (100 * (target - crossCheck)) / crossCheck;
}

/** The sentence for a difference over 5 %, else `null`. */
export function crossCheckWarning(target: number, crossCheck: number): string | null {
	const pct = Math.abs(differencePct(target, crossCheck));
	if (pct <= CROSS_CHECK_LIMIT_PCT) return null;
	const size = Number.isFinite(pct) ? `${formatNumber(pct, 1)} %` : `more than ${CROSS_CHECK_LIMIT_PCT} %`;
	return `The value you entered and the unsplit natural run differ by ${size}. Either the value is mistyped, or Pitman’s natural run of this module departs from WRSM2000’s.`;
}

/** The same for the value as typed, as it is typed; nothing until it reads as a positive number. */
export function typedCrossCheckWarning(marText: string, crossCheck: number): string | null {
	const value = parseFactor(marText);
	return Number.isFinite(value) && value > 0 ? crossCheckWarning(value, crossCheck) : null;
}
