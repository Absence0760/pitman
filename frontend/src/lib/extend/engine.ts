/**
 * The extension method (method A, docs/theory/extend.md §§ Steps 4–8) as the
 * screen calls it. The screen never computes a factor or an appended row
 * itself: it calls the engine's method A (`packages/wrsm/src/extend/rain.ts`,
 * contract in `contract.ts`) through this interface, so tests can pass fakes.
 */

import {
	applyRainfallExtension,
	checkFactor,
	fitRainfallExtension,
	fitStatistics,
	overlapYears,
	refitFromSidecar,
	type ApplyRainfallExtension,
	type ChirpsMonthly,
	type ExtensionFit,
	type FactorCheck,
	type FitRainfallExtension,
	type FitStatistics,
	type Monthly12,
	type RainfallExtension,
	type RainfallSeries
} from '@pitman/wrsm';

/** How the engine treats one typed factor value (extend.md § Step 6). */
export type CheckFactor = (value: number) => FactorCheck;

export interface ExtensionEngine {
	readonly fit: FitRainfallExtension;
	readonly apply: ApplyRainfallExtension;
	readonly check: CheckFactor;
	/** Fit statistics of `ran` against `fit`'s CHIRPS with `factors` (the screen's "with the factors in use"). */
	readonly statistics: (ran: RainfallSeries, fit: ExtensionFit, factors: Monthly12) => FitStatistics;
	/** Re-extending a file with a sidecar entry (R4-E2): the original record, the fit on the recorded overlap and `MAP_c`, the factors used last time. */
	readonly refit: (series: RainfallSeries, chirps: ChirpsMonthly, extension: RainfallExtension) => { readonly ran: RainfallSeries; readonly fit: ExtensionFit; readonly factors: Monthly12 };
}

/** The engine's method A (`packages/wrsm/src/extend/rain.ts`). Tests pass a fake in its place. */
export const extensionEngine: ExtensionEngine = {
	fit: fitRainfallExtension,
	apply: applyRainfallExtension,
	check: checkFactor,
	statistics: (ran, fit, factors) => fitStatistics(overlapYears(ran, fit), factors),
	refit: refitFromSidecar
};
