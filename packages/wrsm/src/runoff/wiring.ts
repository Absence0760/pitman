/**
 * The one place the Round 6 parts are wired into the runoff module runner.
 *
 * `runRunoffModule` (and through it `runNetwork` and `run`) uses these
 * defaults when its caller injects nothing. At integration the orchestrator
 * swaps the marked lines below for the real parts:
 *
 *   SAMI_PARTS           → { soilPass: samiSoilPass, interflow: samiInterflow,
 *                            aquiferInit: samiAquiferInit, aquiferStep: samiAquiferStep,
 *                            makeAquiferStep: makeSamiAquiferStep }
 *                          (`groundwater/sami/soil.ts`, agent 6.1; `aquifer.ts`, agent 6.2)
 *   STREAMFLOW_REDUCTIONS → [forestReduction (wired), alien free-module reduction]
 *                          (`landuse/forest.ts`, agent 6.3; `landuse/alien.ts`, agent 6.4)
 *   SFR_TARGETS          → { alien: <alien ChildTargetModel> } (agent 6.4)
 *
 * Nothing else needs to change: tests that want fakes inject their own.
 */

import type { SamiRunParts } from '../groundwater/sami/index.js';
import type { StreamflowReduction } from '../landuse/contract.js';
import { forestReduction } from '../landuse/forest.js';
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

/**
 * Placeholder for the free-module alien-vegetation reduction (agent 6.4):
 * no reduction, and a warning when the module has alien vegetation in a mode
 * that keeps it.
 */
export const ALIEN_REDUCTION_NOT_WIRED: StreamflowReduction = ({ module, mode, unreducedRunoffMm3 }) => ({
	reductionMm3: { ...unreducedRunoffMm3, values: unreducedRunoffMm3.values.map(() => 0) },
	messages:
		mode.kind !== 'natural' && module.alienVegetation && module.alienVegetation.areaKm2.length > 0
			? [{ level: 'warning', module: { type: 'RU', number: module.number }, text: `RU ${module.number}: alien vegetation not modelled yet (Round 6 integration); ignored` }]
			: []
});

// WIRING POINT (reductions): replace ALIEN_REDUCTION_NOT_WIRED with agent 6.4's free-module reduction.
/** The streamflow reductions a free module (not in an SFR group) gets when none are injected. */
export const STREAMFLOW_REDUCTIONS: readonly StreamflowReduction[] = [forestReduction, ALIEN_REDUCTION_NOT_WIRED];

// WIRING POINT (SFR alien children): add `alien: <6.4's ChildTargetModel>`.
/** Child target models for the SFR mechanism (`runSfrGroup`); afforestation defaults inside `landuse/sfr.ts`. */
export const SFR_TARGETS: { readonly forest?: ChildTargetModel; readonly alien?: ChildTargetModel } = {};
