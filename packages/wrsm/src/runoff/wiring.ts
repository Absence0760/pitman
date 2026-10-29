/**
 * The one place the Round 6 parts are wired into the runoff module runner.
 *
 * `runRunoffModule` (and through it `runNetwork` and `run`) uses these
 * defaults when its caller injects nothing. At integration the orchestrator
 * swaps the Sami line below for the real parts:
 *
 *   SAMI_PARTS           → { soilPass: samiSoilPass, interflow: samiInterflow,
 *                            aquiferInit: samiAquiferInit, aquiferStep: samiAquiferStep,
 *                            makeAquiferStep: makeSamiAquiferStep }
 *                          (`groundwater/sami/soil.ts`, agent 6.1; `aquifer.ts`, agent 6.2)
 *   STREAMFLOW_REDUCTIONS   [forestReduction, alienVegetationReduction]  (wired)
 *   SFR_TARGETS             { alien: alienTargetModel() }                (wired)
 *
 * Nothing else needs to change: tests that want fakes inject their own.
 */

import type { SamiRunParts } from '../groundwater/sami/index.js';
import type { StreamflowReduction } from '../landuse/contract.js';
import { forestReduction } from '../landuse/forest.js';
import { alienTargetModel, alienVegetationReduction } from '../landuse/alien.js';
import type { ChildTargetModel } from '../landuse/sfr.js';

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

// Lambdas, not the functions themselves: alien.ts and this file are in an import cycle through
// runoff/pitman.ts, so nothing here may touch an alien.ts binding while modules load.
const alienReduction: StreamflowReduction = (input) => alienVegetationReduction(input);
const alienChildTargets: ChildTargetModel = (input) => alienTargetModel()(input);

/**
 * The streamflow reductions a free module (not in an SFR group) gets when
 * none are injected: afforestation (agent 6.3) and alien vegetation (6.4,
 * TT 689 p.140; it reads the run's evaporation, R6-V10).
 */
export const STREAMFLOW_REDUCTIONS: readonly StreamflowReduction[] = [forestReduction, alienReduction];

/** Child target models for the SFR mechanism (`runSfrGroup`); afforestation defaults inside `landuse/sfr.ts`. */
export const SFR_TARGETS: { readonly forest?: ChildTargetModel; readonly alien?: ChildTargetModel } = { alien: alienChildTargets };
