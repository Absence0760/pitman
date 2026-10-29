/**
 * The one place the Round 6 parts are wired into the runoff module runner.
 *
 * `runRunoffModule` (and through it `runNetwork` and `run`) uses these
 * defaults when its caller injects nothing. At integration the orchestrator
 * swaps the two marked lines below for the real parts:
 *
 *   SAMI_PARTS           → { soilPass: samiSoilPass, interflow: samiInterflow,
 *                            aquiferInit: samiAquiferInit, aquiferStep: samiAquiferStep,
 *                            makeAquiferStep: makeSamiAquiferStep }
 *                          (`groundwater/sami/soil.ts`, agent 6.1; `aquifer.ts`, agent 6.2)
 *   STREAMFLOW_REDUCTIONS → [afforestation, alienVegetation]
 *                          (`landuse/forest.ts`, agent 6.3; `landuse/alien.ts`, agent 6.4)
 *
 * Nothing else needs to change: tests that want fakes inject their own.
 */

import type { SamiRunParts } from '../groundwater/sami/index.js';
import type { StreamflowReduction } from '../landuse/contract.js';

function notWired(part: string): never {
	throw new Error(`Sami ${part} is not wired yet (Round 6 integration: src/runoff/wiring.ts)`);
}

/**
 * Placeholder Sami parts. `runRunoffModule` recognises this object and
 * refuses a Sami module with a `PitmanRunError` naming it (R2-2) before any
 * part is called; the functions throw too, for a caller that uses them
 * directly.
 */
export const SAMI_PARTS_NOT_WIRED: SamiRunParts = Object.freeze({
	soilPass: () => notWired('soilPass'),
	interflow: () => notWired('interflow'),
	aquiferInit: () => notWired('aquiferInit'),
	aquiferStep: () => notWired('aquiferStep')
});

// WIRING POINT (Sami): replace SAMI_PARTS_NOT_WIRED with the real parts.
/** The Sami parts a run uses when none are injected. */
export const SAMI_PARTS: SamiRunParts = SAMI_PARTS_NOT_WIRED;

// WIRING POINT (reductions): replace `undefined` with [afforestation, alienVegetation].
/**
 * The streamflow reductions a run applies when none are injected.
 * `undefined` means "not modelled yet": land-use data is ignored with a
 * warning, as before Round 6. An array (even empty) means they are modelled.
 */
export const STREAMFLOW_REDUCTIONS: readonly StreamflowReduction[] | undefined = undefined;
