/**
 * Which reference routes Round 2 is expected to reproduce, and how closely
 * (issue #3, Round 2 exit criteria).
 *
 * `wrsm compare` fails (exit 1) when a listed route misses either
 * threshold; unlisted routes are reported but never fail the run.
 */

import type { SeriesComparison } from './compare.js';

/** Largest accepted |MAR difference|, % (issue #3 Round 2). */
export const MAR_PCT_DIFF_MAX = 1;

/** Smallest accepted Nash–Sutcliffe efficiency (issue #3 Round 2). */
export const NSE_MIN = 0.99;

/** A route expected to match its reference. */
export interface ExpectedRoute {
	/** The network folder's name (the last path component), compared case-insensitively. */
	readonly network: string;
	/** Route number: the `<net>RQ<route>.ANS` file. */
	readonly route: number;
}

/**
 * Routes expected to match in Round 2. Empty for now: it fills once the
 * classic-groundwater reference run (#21, Round 1) exists and shows which
 * runoff-only routes WRSM2000 produced with the classic model.
 */
export const EXPECTED_TO_MATCH: readonly ExpectedRoute[] = [];

/**
 * Whether a comparison meets the Round 2 thresholds. No common year, or an
 * undefined MAR difference (zero reference MAR, non-zero simulated), fails.
 * When NSE is undefined (a constant reference, e.g. a dry route) the series
 * must agree within the tolerance in every month instead.
 */
export function meetsThresholds(comparison: SeriesComparison | null): boolean {
	if (!comparison || comparison.marPctDiff === null) return false;
	if (Math.abs(comparison.marPctDiff) > MAR_PCT_DIFF_MAX) return false;
	return comparison.nse === null ? comparison.firstDivergingMonth === null : comparison.nse >= NSE_MIN;
}
