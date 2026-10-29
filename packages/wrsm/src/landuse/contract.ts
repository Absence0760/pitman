/**
 * Round 6 contract for streamflow reductions on a runoff module: afforestation
 * (TT 690 ch.11, `forest.ts`, agent 6.3) and invasive alien vegetation (TT 690
 * ch.12, `alien.ts`, agent 6.4), called by the runoff module runner. Written
 * by the orchestrator before the round as a **starting shape**: the manuals
 * have not been transcribed for these chapters yet (agents 6.3 and 6.4 write
 * the specs). If the manuals show the shape is wrong (for example, the SFR
 * child's forest-factor adjustment needs the runoff re-run), the agent says
 * so in its report with the shape it needs; the orchestrator changes it here.
 *
 * Paved area (RU L.016–L.018) is already applied inside the Pitman core
 * (`src/runoff/pitman.ts`, impervious fraction); agent 6.4 checks that
 * against the manuals.
 */

import type { HydroYear, MonthlySeries, RunMessage, RunMode, RunoffModule } from '../types.js';

/** What a reduction model is given for one runoff module. */
export interface ReductionInput {
	readonly module: RunoffModule;
	/** The SFR parent when `module` is a child (`RunoffModule.sfrChildren` on the parent), else `null`. */
	readonly parent: RunoffModule | null;
	/** D1: present day holds the year tables at `mode.year`; natural removes every reduction. */
	readonly mode: RunMode;
	readonly startYear: HydroYear;
	readonly endYear: HydroYear;
	/** The module's runoff with no reduction applied, million m³/month, over the run. */
	readonly unreducedRunoffMm3: MonthlySeries;
	/** Catchment rainfall over the run, mm/month (% MAP × MAP). */
	readonly rainfallMm: readonly number[];
}

/** What a reduction model returns. */
export interface ReductionOutput {
	/** Streamflow reduction per month, million m³/month, ≥ 0 and ≤ the unreduced runoff. */
	readonly reductionMm3: MonthlySeries;
	/** "Virgin MAR" as WRSM2000.ERR reports it for an SFR child, million m³/year, when the model computes one. */
	readonly virginMarMm3?: number;
	readonly messages: readonly RunMessage[];
}

/** A streamflow reduction model (afforestation or alien vegetation). */
export type StreamflowReduction = (input: ReductionInput) => ReductionOutput;
