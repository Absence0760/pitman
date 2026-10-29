/**
 * Afforestation streamflow reductions (RU L.006–L.010; TT 690 ch.11,
 * TT 689 §6.2.2.1 and §6.2.2.3). Spec: docs/theory/afforestation.md.
 *
 * What the manuals publish, and so what is modelled here:
 *
 * - **Smoothed Gush/Pitman** (FORESTALG 2): target % reductions in MAR and
 *   in low flows from TT 690 p.122 eq. 11.1 and p.123 Table 11.1, weighted by
 *   the pine / eucalyptus / wattle shares of L.009 (R6-F1). Child modules
 *   only (TT 689 p.136).
 * - **User defined** (FORESTALG 4): the targets are L.010 vars 2–3
 *   (`UD_TPRM`, `UD_TPRL`, TT 691 p.52). Child modules only.
 *
 * In a child the targets are not applied to the flows directly: the SFR
 * mechanism (`sfr.ts`) adjusts the child's PI, FF, SL and ST until its own
 * runoff shows them (TT 690 p.126).
 *
 * What the manuals name but do not publish, and so is not modelled:
 *
 * - **Van der Zel** (FORESTALG 0) reduces rain "by the amount that is
 *   intercepted by the afforestation" (TT 689 p.127); its curves are not
 *   given. R6-F3.
 * - **CSIR** (FORESTALG 1) uses Scott & Smith's (1997) lookup tables by
 *   genus, rotation and % optimal area "along with empirical equations"
 *   (TT 689 p.127; TT 691 p.61 RU_FOREST, RU_FRLOSS); the tables are not in
 *   TT 687–691. R6-F2 (child) and R6-F3 (free module).
 * - **LUT Gush** (FORESTALG 3) was never implemented in WRSM2000 (TT 689
 *   p.xvi, p.127, p.136). R6-F4.
 */

import type { Afforestation, PlantationShare, RunMessage, RunoffModule } from '../types.js';
import type { ReductionInput, ReductionOutput, StreamflowReduction } from './contract.js';

// ---------------------------------------------------------------------------
// Smoothed Gush (TT 690 §11.1)
// ---------------------------------------------------------------------------

/** One regression line of TT 690 p.123 Table 11.1: reduction (%) = a − b × MAP, floored at `minimum`. */
export interface GushLine {
	readonly a: number;
	readonly b: number;
	/** "the minimum percentage reductions (averaged for 3 soil types) for all quaternaries" (TT 690 p.122). */
	readonly minimum: number;
}

/** The plantation genera of RU L.009, in file order. */
export const GENERA = ['pine', 'eucalyptus', 'wattle'] as const;
export type Genus = (typeof GENERA)[number];

/**
 * TT 690 p.123 Table 11.1, "Results of Linear Regression Analysis", as
 * printed. "Median" is the MAR line: TT 690 Fig. 11.1 is titled
 * "Reductions in mean flow", and RU_SMGush returns "% reduction (MAR & low
 * flow)" (TT 691 p.62). Eucalypt's low-flow minimum of 36.4 is as printed.
 */
export const SMOOTHED_GUSH_TABLE: Readonly<Record<Genus, { readonly mar: GushLine; readonly lowFlow: GushLine }>> = {
	pine: { mar: { a: 112.92, b: 0.07, minimum: 6.0 }, lowFlow: { a: 119.34, b: 0.078, minimum: 2.9 } },
	eucalyptus: { mar: { a: 120.6, b: 0.064, minimum: 9.6 }, lowFlow: { a: 128.03, b: 0.054, minimum: 36.4 } },
	wattle: { mar: { a: 120.85, b: 0.079, minimum: 8.2 }, lowFlow: { a: 123.02, b: 0.067, minimum: 24.8 } }
};

/**
 * TT 690 p.122 eq. 11.1, `reduction (%) = a − b × MAP`, held between the
 * table's minimum ("used to prevent unrealistically low (or negative)
 * reductions when extrapolating to very high MAP") and 100 % ("the maximum
 * reduction cannot exceed 100%"), TT 690 p.122.
 */
export function gushReductionPercent(line: GushLine, mapMm: number): number {
	return Math.min(100, Math.max(line.minimum, line.a - line.b * mapMm));
}

/** Target % reductions of a child's MAR (TPRM) and low flows (TPRL), TT 691 p.52 / p.55 RU_GetSFReduction. */
export interface SfrTargets {
	/** TPRM, % of the child's virgin MAR. */
	readonly marPercent: number;
	/** TPRL, % of the child's virgin low flow (the mean of the lowest 25 % of months, TT 689 p.138). */
	readonly lowFlowPercent: number;
}

/**
 * R6-F1: how L.009's genus percentages weight the per-genus Table 11.1
 * reductions. `asWritten` (default): Σ (percent / 100) × reduction, so
 * shares that don't add to 100 scale the target. `normalised`: divide by
 * the shares' sum.
 */
export type SpeciesWeighting = 'asWritten' | 'normalised';

/**
 * Smoothed Gush targets for a plantation of the given genus shares at
 * catchment MAP `mapMm` (the parent's MAP, which the child copies with the
 * climate; TT 691 p.53 RU_CopyClimate). TT 690 pp.122–123 eq. 11.1, Table
 * 11.1. Shares of zero contribute nothing; all-zero shares give 0 %.
 */
export function smoothedGushTargets(
	species: Readonly<Record<Genus, PlantationShare>>,
	mapMm: number,
	weighting: SpeciesWeighting = 'asWritten'
): SfrTargets {
	let total = 0;
	let mar = 0;
	let lowFlow = 0;
	for (const genus of GENERA) {
		const w = species[genus].percent / 100;
		total += w;
		mar += w * gushReductionPercent(SMOOTHED_GUSH_TABLE[genus].mar, mapMm);
		lowFlow += w * gushReductionPercent(SMOOTHED_GUSH_TABLE[genus].lowFlow, mapMm);
	}
	if (weighting === 'normalised') {
		if (total <= 0) return { marPercent: 0, lowFlowPercent: 0 };
		return { marPercent: mar / total, lowFlowPercent: lowFlow / total };
	}
	return { marPercent: mar, lowFlowPercent: lowFlow };
}

// ---------------------------------------------------------------------------
// Targets for an SFR child
// ---------------------------------------------------------------------------

/** Options for the afforestation models (each provisional choice has an ID in docs/theory/afforestation.md §7). */
export interface ForestOptions {
	/** R6-F1. Default `asWritten`. */
	readonly speciesWeighting: SpeciesWeighting;
	/**
	 * R6-F2: a CSIR child (FORESTALG 1), whose tables are unpublished.
	 * `smoothedGush` (default): use the Smoothed Gush targets for the same
	 * genus shares, with a warning. `none`: no reduction (the child runs
	 * virgin), with a warning.
	 */
	readonly csirChild: 'smoothedGush' | 'none';
}

export const DEFAULT_FOREST_OPTIONS: ForestOptions = { speciesWeighting: 'asWritten', csirChild: 'smoothedGush' };

/** Whether a module has afforestation that a run would see: a non-empty L.007–L.008 table with some area above zero. */
export function hasAfforestation(module: RunoffModule): boolean {
	return module.afforestation.areaKm2.some((row) => row.value > 0);
}

/** What `forestChildTargets` returns. */
export interface ForestTargetResult {
	/** `null` when the algorithm gives no reduction this run (the child then runs virgin). */
	readonly targets: SfrTargets | null;
	/** The algorithm as the run log names it ("SFR is …", docs/formats.md §14). */
	readonly label: string;
	readonly messages: readonly RunMessage[];
}

const ALGORITHM_NAMES: Readonly<Record<Afforestation['algorithm'], string>> = {
	0: 'Van der Zel',
	1: 'CSIR',
	2: 'Smoothed Gush/Pitman',
	3: 'LUT Gush',
	4: 'User defined'
};

/**
 * The target reductions for an afforestation SFR child, `child` being the
 * child after it has copied its parent's climate (so `child.mapMm` is the
 * parent's MAP, "PMean" in the run log). TT 691 p.55 RU_GetSFReduction.
 */
export function forestChildTargets(child: RunoffModule, options: Partial<ForestOptions> = {}): ForestTargetResult {
	const opt: ForestOptions = { ...DEFAULT_FOREST_OPTIONS, ...options };
	const ref = { type: 'RU', number: child.number } as const;
	const aff = child.afforestation;
	const label = ALGORITHM_NAMES[aff.algorithm];
	const messages: RunMessage[] = [];
	const warn = (text: string) => messages.push({ level: 'warning', module: ref, text: `RU ${child.number}: ${text}` });

	const gush = (): SfrTargets | null => {
		if (!aff.species) {
			warn(`${label} afforestation has no genus shares (L.009); no reduction`);
			return null;
		}
		const sum = aff.species.pine.percent + aff.species.eucalyptus.percent + aff.species.wattle.percent;
		if (Math.abs(sum - 100) > 0.05) warn(`genus shares (L.009) add up to ${sum.toFixed(2)} %, not 100 % (R6-F1: ${opt.speciesWeighting})`);
		return smoothedGushTargets(aff.species, child.mapMm, opt.speciesWeighting);
	};

	switch (aff.algorithm) {
		case 2:
			return { targets: gush(), label, messages };
		case 4: {
			const ud = aff.userDefinedReduction;
			if (!ud) {
				warn('user-defined afforestation has no required reductions (L.010 vars 2–3); no reduction');
				return { targets: null, label, messages };
			}
			return { targets: { marPercent: ud.marPercent, lowFlowPercent: ud.lowFlowPercent }, label, messages };
		}
		case 1:
			if (opt.csirChild === 'smoothedGush') {
				warn('CSIR afforestation tables are not published in TT 687–691; the Smoothed Gush targets for the same genus shares are used instead (R6-F2)');
				return { targets: gush(), label, messages };
			}
			warn('CSIR afforestation tables are not published in TT 687–691; no reduction (R6-F2)');
			return { targets: null, label, messages };
		case 3:
			warn('LUT Gush was never implemented in WRSM2000 (TT 689 p.136); no reduction (R6-F4)');
			return { targets: null, label, messages };
		case 0:
			warn('Van der Zel is a free-module algorithm whose curves are not published (TT 689 p.127); no reduction (R6-F3)');
			return { targets: null, label, messages };
	}
}

// ---------------------------------------------------------------------------
// A free (non-child) module
// ---------------------------------------------------------------------------

/**
 * Afforestation in a free module, in the contract's shape: a reduction of
 * the module's final outflow, as WRSM2000's CSIR routine does in a "normal"
 * catchment (TT 689 p.163 KB article 2, p.165 note 3). Van der Zel works
 * "at source" instead (TT 689 p.165).
 *
 * Neither method's curves or tables are in the manuals, and the child-only
 * algorithms (Smoothed Gush, LUT Gush, user defined) are not available to a
 * free module (TT 689 p.136, p.140). So every case returns a zero reduction
 * and, when afforestation is present in a mode that keeps it, a warning that
 * says why (R6-F3, R6-F5). Natural mode returns zero silently (D1).
 */
export const forestReduction: StreamflowReduction = (input: ReductionInput): ReductionOutput => {
	const { module, mode, unreducedRunoffMm3 } = input;
	const reductionMm3 = { ...unreducedRunoffMm3, values: unreducedRunoffMm3.values.map(() => 0) };
	if (mode.kind === 'natural' || !hasAfforestation(module)) return { reductionMm3, messages: [] };
	const ref = { type: 'RU', number: module.number } as const;
	const alg = module.afforestation.algorithm;
	const text =
		alg === 0 || alg === 1
			? `${ALGORITHM_NAMES[alg]} afforestation in a free module is not modelled: its ${alg === 0 ? 'curves' : 'tables'} are not published in TT 687–691; no reduction (R6-F3)`
			: `${ALGORITHM_NAMES[alg]} afforestation is only available to an SFR child (TT 689 p.136) and this module is not one; no reduction (R6-F5)`;
	return { reductionMm3, messages: [{ level: 'warning', module: ref, text: `RU ${module.number}: ${text}` }] };
};
