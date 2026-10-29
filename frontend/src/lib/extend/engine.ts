/**
 * The extension method (method A, docs/theory/extend.md §§ Steps 4–8) as the
 * screen calls it. The screen never computes a factor or an appended row
 * itself: it calls these three functions, which agent 4.3 writes in
 * `packages/wrsm/src/extend/rain.ts` against the Round 4 contract
 * (`packages/wrsm/src/extend/contract.ts`). Tests pass fakes.
 */

import type { ApplyRainfallExtension, FactorCheck, FitRainfallExtension } from '@pitman/wrsm';

/** How the engine treats one typed factor value (extend.md § Step 6). */
export type CheckFactor = (value: number) => FactorCheck;

export interface ExtensionEngine {
	readonly fit: FitRainfallExtension;
	readonly apply: ApplyRainfallExtension;
	readonly check: CheckFactor;
	/** False until the real method is wired in (see below); the screen says so instead of fitting. */
	readonly available: boolean;
}

/** Thrown by the placeholder below, with a message the screen shows as it is. */
export class EngineUnavailableError extends Error {
	constructor() {
		super('The extension method is not in this build of Pitman yet, so the fit can’t be computed.');
		this.name = 'EngineUnavailableError';
	}
}

const unavailable = (): never => {
	throw new EngineUnavailableError();
};

// ---------------------------------------------------------------------------
// WIRING POINT (Round 4 integration). Replace the placeholder with the
// engine's functions once `src/extend/rain.ts` lands and `@pitman/wrsm`
// exports them:
//
//   import { applyRainfallExtension, checkFactor, fitRainfallExtension } from '@pitman/wrsm';
//   export const extensionEngine: ExtensionEngine = {
//   	fit: fitRainfallExtension,
//   	apply: applyRainfallExtension,
//   	check: checkFactor,
//   	available: true
//   };
//
// Nothing else in the app changes. `frontend/e2e/extend.spec.ts`'s full-flow
// test runs once `available` is true (the page exposes it as `data-engine`).
// ---------------------------------------------------------------------------
export const extensionEngine: ExtensionEngine = {
	fit: unavailable,
	apply: unavailable,
	check: unavailable,
	available: false
};
