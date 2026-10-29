/**
 * Invasive alien vegetation: streamflow reduction (spec: docs/theory/alien.md).
 *
 * Sources: TT 690 ch.12 (Le Maitre & Görgens; the CSIR age–biomass and
 * biomass–flow-reduction curves, eqs. 12.3–12.9 pp.133–135; the riparian
 * deduction, eqs. 12.10–12.12 pp.139–140), TT 689 §6.2.2.2 pp.128–129 (the
 * inputs and how they combine) and §6.2.2.3 pp.129–140 (Parent/Child),
 * TT 691 §7.4 pp.40–53 (VEGETATIONALG, APERC, AGE, APOT, RipVegAreaPerc,
 * NSFR = 5 "CSIR Alien Vegetation").
 *
 * Two uses:
 *
 * - **SFR child** (the WRSM2000 way, TT 690 p.125; TT 691 p.56
 *   RU_GetSFReduction): `alienReductionTargets` gives the target % reductions
 *   in MAR and low flow (TPRM, TPRL) that the parent/child mechanism
 *   (`sfr.ts`) reaches by adjusting the child's PI, FF, SL and ST, then
 *   `riparianDeduction` takes the riparian loss off the child's final
 *   outflow (TT 690 p.139: "performed after the effect of alien vegetation is
 *   determined as if all is in the non-riparian zone").
 * - **Free module** (TT 689 p.140: catchments with FT = 0, where a child must
 *   not be used): `alienVegetationReduction`, a `StreamflowReduction`, takes
 *   the targets off the module's runoff month by month (TT 690 p.123: "reduce
 *   the final outflow of the catchment by that amount") and then the riparian
 *   loss.
 *
 * Provisional choices carry IDs R6-V1 … R6-V12 (docs/theory/alien.md § Open
 * questions) and are switchable through `AlienOptions`.
 */

import type { AlienVegetation, HydroYear, MonthlySeries, RunMessage, RunMode, YearTable } from '../types.js';
import { yearTableValue } from '../runoff/pitman.js';
import type { ReductionInput, ReductionOutput } from './contract.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** The three alien vegetation classes (TT 689 p.128; TT 690 Table 12.3). */
export type AlienClass = 'tallTrees' | 'mediumTrees' | 'tallShrubs';

/** Tall-shrub biomass constant printed in TT 690 eq. 12.5 (p.133). */
export const TALL_SHRUB_C_MANUAL = 3.1868;
/**
 * Tall-shrub biomass constant that reproduces WRSM2000's TPRM for every
 * public reference child with tall shrubs (R6-V6; docs/theory/alien.md §7).
 * Fitted to `.ERR` output, not printed in any manual.
 */
export const TALL_SHRUB_C_REFERENCE_FIT = 3.4165;

/** Scaled asymptotes of the flow-reduction curves, % (TT 690 §12.4.7 p.135). */
export const LAG_CURVE_ASYMPTOTES = {
	longLagAnnual: 115,
	longLagLowFlow: 122,
	shortLagAnnual: 103,
	shortLagLowFlow: 102
} as const;

export interface AlienOptions {
	/**
	 * R6-V2: how a class's age enters the curves. `single` (default): the
	 * curves at the given age, as WRSM2000's TPRM shows. `ageClassMean`: the
	 * mean of the curves over ages 1 … round(2 × age), TT 690 §12.4.8 p.135.
	 */
	readonly age: 'single' | 'ageClassMean';
	/** R6-V6: the constant c in eq. 12.5, e^c. Default the manual's 3.1868. */
	readonly tallShrubBiomassC: number;
	/**
	 * R6-V4: TT 690 Table 12.4's "suggested asymptote (%)", the most a
	 * landscape invasion can reduce flow; scales every curve's asymptote.
	 * Default 100 (no extra scaling): no RU field holds it.
	 */
	readonly maxReductionPercent: number;
	/**
	 * R6-V7: TPRL. `curve` (default): the low-flow curves, raised to TPRM when
	 * below it. `tprm`: TPRL = TPRM.
	 */
	readonly lowFlowTarget: 'curve' | 'tprm';
	/**
	 * R6-V9: AREA in eq. 12.11. `active` (default): the alien area in the
	 * month's year (TT 689 p.129 "the current area of alien veg"). `module`:
	 * the module's AREA (L.002).
	 */
	readonly riparianArea: 'active' | 'module';
	/**
	 * R6-V11: free-module distribution over months. `proportional`
	 * (default): every month loses TPRM % of the alien area's runoff.
	 * `lowFlowMonths`: months at or below the run's lowest-quartile flow lose
	 * TPRL % instead.
	 */
	readonly freeModuleMonths: 'proportional' | 'lowFlowMonths';
}

export const DEFAULT_ALIEN_OPTIONS: AlienOptions = {
	age: 'single', // R6-V2
	tallShrubBiomassC: TALL_SHRUB_C_MANUAL, // R6-V6
	maxReductionPercent: 100, // R6-V4
	lowFlowTarget: 'curve', // R6-V7
	riparianArea: 'active', // R6-V9
	freeModuleMonths: 'proportional' // R6-V11
};

// ---------------------------------------------------------------------------
// Age → biomass (TT 690 §12.4.3 p.133), t/ha
// ---------------------------------------------------------------------------

/** Eq. 12.3: tall trees (pine), 300 / (1 + e^3.67947 · age^−1.4109). Age ≤ 0 → 0. */
export function tallTreeBiomass(ageYears: number): number {
	if (!(ageYears > 0)) return 0;
	return 300 / (1 + Math.exp(3.67947) * ageYears ** -1.4109);
}

/** Eq. 12.4: medium trees, 96.0732 · log10(age) − 4.8081, floored at 0 (R6-V5: negative below age ≈ 1.12). */
export function mediumTreeBiomass(ageYears: number): number {
	if (!(ageYears > 0)) return 0;
	return Math.max(0, 96.0732 * Math.log10(ageYears) - 4.8081);
}

/** Eq. 12.5: tall shrubs, 76 / (1 + e^c · age^−1.35973), c = 3.1868 in the manual (R6-V6). Age ≤ 0 → 0. */
export function tallShrubBiomass(ageYears: number, c: number = TALL_SHRUB_C_MANUAL): number {
	if (!(ageYears > 0)) return 0;
	return 76 / (1 + Math.exp(c) * ageYears ** -1.35973);
}

/** Biomass of a class at an age, t/ha (TT 690 Table 12.3: equation 3 tall trees, 2 medium trees, 1 tall shrubs). */
export function alienBiomass(cls: AlienClass, ageYears: number, options: Pick<AlienOptions, 'tallShrubBiomassC'> = DEFAULT_ALIEN_OPTIONS): number {
	switch (cls) {
		case 'tallTrees':
			return tallTreeBiomass(ageYears);
		case 'mediumTrees':
			return mediumTreeBiomass(ageYears);
		case 'tallShrubs':
			return tallShrubBiomass(ageYears, options.tallShrubBiomassC);
	}
}

// ---------------------------------------------------------------------------
// Biomass → flow reduction (TT 690 §12.4.5–12.4.7 pp.134–135), %
// ---------------------------------------------------------------------------

/** Eq. 12.6 (long lag, annual flow), asymptote 115 (§12.4.7): A / (1 + e^14.2216 · B^−2.9194). B ≤ 0 → 0. */
export function longLagAnnualReduction(biomass: number, asymptote: number = LAG_CURVE_ASYMPTOTES.longLagAnnual): number {
	if (!(biomass > 0)) return 0;
	return asymptote / (1 + Math.exp(14.2216) * biomass ** -2.9194);
}

/** Eq. 12.7 (long lag, low flow), asymptote 122 (§12.4.7): A / (1 + e^10.0252 · B^−2.0927). B ≤ 0 → 0. */
export function longLagLowFlowReduction(biomass: number, asymptote: number = LAG_CURVE_ASYMPTOTES.longLagLowFlow): number {
	if (!(biomass > 0)) return 0;
	return asymptote / (1 + Math.exp(10.0252) * biomass ** -2.0927);
}

/** Eq. 12.8 (short lag, annual flow), asymptote 103 (§12.4.7): A / (1 + e^2.2958 · e^(−0.02388 B)). */
export function shortLagAnnualReduction(biomass: number, asymptote: number = LAG_CURVE_ASYMPTOTES.shortLagAnnual): number {
	return asymptote / (1 + Math.exp(2.2958) * Math.exp(-0.02388 * Math.max(0, biomass)));
}

/** Eq. 12.9 (short lag, low flow), asymptote 102 (§12.4.7): A / (1 + e^1.9677 · e^(−0.02474 B)). */
export function shortLagLowFlowReduction(biomass: number, asymptote: number = LAG_CURVE_ASYMPTOTES.shortLagLowFlow): number {
	return asymptote / (1 + Math.exp(1.9677) * Math.exp(-0.02474 * Math.max(0, biomass)));
}

/** A curve value held within 0–100 % (R6-V5). */
function capped(percent: number): number {
	return Math.min(100, Math.max(0, percent));
}

/** Annual and low-flow reduction, %. */
export interface FlowReduction {
	readonly annualPercent: number;
	readonly lowFlowPercent: number;
}

/**
 * Reduction for a dense stand of one class at one age: the optimal share on
 * the short-lag curves, the rest on the long-lag curves (R6-V1; TT 689 p.128;
 * TT 690 p.134), each curve capped at 100 % (R6-V5).
 */
function reductionAtAge(cls: AlienClass, ageYears: number, optimalPercent: number, options: AlienOptions): FlowReduction {
	const b = alienBiomass(cls, ageYears, options);
	const k = options.maxReductionPercent / 100;
	const w = optimalPercent / 100;
	const A = LAG_CURVE_ASYMPTOTES;
	const annual = w * capped(shortLagAnnualReduction(b, k * A.shortLagAnnual)) + (1 - w) * capped(longLagAnnualReduction(b, k * A.longLagAnnual));
	const low = w * capped(shortLagLowFlowReduction(b, k * A.shortLagLowFlow)) + (1 - w) * capped(longLagLowFlowReduction(b, k * A.longLagLowFlow));
	return { annualPercent: annual, lowFlowPercent: low };
}

/**
 * Reduction of one class with a stated age (R6-V2): at that age, or the mean
 * over ages 1 … round(2 × age) as TT 690 §12.4.8 p.135 describes ("if the
 * mean age is 20 years ... the mean of the age-specific ... reductions for
 * stands of 1-40 years of age").
 */
export function alienClassReduction(cls: AlienClass, ageYears: number, optimalPercent: number, options: AlienOptions = DEFAULT_ALIEN_OPTIONS): FlowReduction {
	if (options.age === 'single') return reductionAtAge(cls, ageYears, optimalPercent, options);
	const n = Math.max(1, Math.round(2 * ageYears));
	let annual = 0;
	let low = 0;
	for (let a = 1; a <= n; a++) {
		const r = reductionAtAge(cls, a, optimalPercent, options);
		annual += r.annualPercent;
		low += r.lowFlowPercent;
	}
	return { annualPercent: annual / n, lowFlowPercent: low / n };
}

// ---------------------------------------------------------------------------
// Targets (TT 691 p.56 RU_GetSFReduction, NSFR = 5)
// ---------------------------------------------------------------------------

/** Target reductions, as WRSM2000.ERR prints them for a child. */
export interface ReductionTargets {
	/** "Reduction percentage in MAR (TPRM)", %. */
	readonly tprm: number;
	/** "Reduction percentage in Low (TPRL)", %. */
	readonly tprl: number;
	readonly messages: readonly RunMessage[];
}

const CLASSES: readonly AlienClass[] = ['tallTrees', 'mediumTrees', 'tallShrubs'];
const CLASS_LABEL: Record<AlienClass, string> = { tallTrees: 'tall trees', mediumTrees: 'medium trees', tallShrubs: 'tall shrubs' };

/**
 * TPRM and TPRL for an alien vegetation block: the area-weighted sum of the
 * class reductions (TT 690 §12.3.4 p.132, condensed areas; TT 689 p.128). Age
 * is constant over the run (R6-V3). Algorithm 0 or no composition gives 0.
 */
export function alienReductionTargets(alien: AlienVegetation, options: AlienOptions = DEFAULT_ALIEN_OPTIONS): ReductionTargets {
	const messages: RunMessage[] = [];
	if (alien.algorithm === 0) return { tprm: 0, tprl: 0, messages };
	const comp = alien.composition;
	if (!comp) {
		messages.push({ level: 'warning', text: 'alien vegetation has no class split or ages (L.014); no reduction' });
		return { tprm: 0, tprl: 0, messages };
	}
	const optimal = alien.optimalPercent ?? 0;
	if (!(optimal >= 0 && optimal <= 100)) {
		messages.push({ level: 'error', text: `alien vegetation optimal area ${optimal} % is outside 0–100 (L.015)` });
		return { tprm: 0, tprl: 0, messages };
	}
	if (alien.optimalPercent === undefined) messages.push({ level: 'warning', text: 'alien vegetation optimal area (L.015) missing; taken as 0 %' });

	let shareSum = 0;
	let tprm = 0;
	let tprlCurve = 0;
	for (const cls of CLASSES) {
		const { percent, ageYears } = comp[cls];
		if (!(percent >= 0 && percent <= 100)) {
			messages.push({ level: 'error', text: `alien vegetation ${CLASS_LABEL[cls]} share ${percent} % is outside 0–100 (L.014)` });
			return { tprm: 0, tprl: 0, messages };
		}
		shareSum += percent;
		if (percent === 0) continue;
		if (!(ageYears >= 0)) {
			messages.push({ level: 'error', text: `alien vegetation ${CLASS_LABEL[cls]} age ${ageYears} is negative (L.014)` });
			return { tprm: 0, tprl: 0, messages };
		}
		// TT 691 p.211 change 107: "warning about alien veg of less than 10 years of age producing iteration problems".
		if (ageYears < 10) messages.push({ level: 'warning', text: `alien vegetation ${CLASS_LABEL[cls]} are ${ageYears} years old; under 10 years the SFR iteration may not close (TT 691 p.211)` });
		const r = alienClassReduction(cls, ageYears, optimal, options);
		tprm += (percent / 100) * r.annualPercent;
		tprlCurve += (percent / 100) * r.lowFlowPercent;
	}
	// TT 689 p.128: "the total percentage area should add up to 100%, but the program will check that".
	if (Math.abs(shareSum - 100) > 0.05) messages.push({ level: 'warning', text: `alien vegetation class shares add up to ${shareSum} %, not 100 % (TT 689 p.128); used as given` });
	if (alien.algorithm === 2) messages.push({ level: 'info', text: 'alien vegetation algorithm 2 (riparian) is run as CSIR with the riparian deduction (R6-V8)' });

	tprm = capped(tprm);
	const tprl = options.lowFlowTarget === 'tprm' ? tprm : Math.max(tprm, capped(tprlCurve)); // R6-V7
	return { tprm, tprl, messages };
}

// ---------------------------------------------------------------------------
// Riparian deduction (TT 690 §12.5.2 pp.139–140)
// ---------------------------------------------------------------------------

export interface RiparianInput {
	/** TotalOutflow: the module's (child's) outflow before the deduction, million m³/month. */
	readonly outflowMm3: readonly number[];
	/** PEACT: potential evaporation per month, mm (FF × pan × pan factor of the run). */
	readonly potentialEvaporationMm: readonly number[];
	/** EAVE: actual evaporation per month, mm (interception + soil evaporation, R6-V10). */
	readonly actualEvaporationMm: readonly number[];
	/** RipVegAreaPerc (L.011 v3): % of the alien area in the riparian zone. */
	readonly riparianPercent: number;
	/** AREA per month, km² (R6-V9). */
	readonly areaKm2: readonly number[];
}

export interface RiparianResult {
	/** TotalOutflow after eq. 12.12, million m³/month. */
	readonly outflowMm3: number[];
	/** ETVOL, eq. 12.11: the riparian demand (TT 691 TS_RipVegDemand), million m³/month. */
	readonly demandMm3: number[];
	/** What was taken off: min(ETVOL, TotalOutflow), million m³/month. */
	readonly lossMm3: number[];
}

/** Eq. 12.10: ETDEF = AMAX1(0, PEACT − EAVE), mm. */
export function evaporationDeficit(potentialMm: number, actualMm: number): number {
	return Math.max(0, potentialMm - actualMm);
}

/** Eq. 12.11: ETVOL = 0.001 × ETDEF × PRIP × AREA, million m³ (mm × km² × 10⁻³), PRIP = RipVegAreaPerc / 100. */
export function riparianVolume(etdefMm: number, riparianPercent: number, areaKm2: number): number {
	return 0.001 * etdefMm * (riparianPercent / 100) * areaKm2;
}

/** Eqs. 12.10–12.12 month by month: TotalOutflow = AMAX1(0, TotalOutflow − ETVOL). */
export function riparianDeduction(input: RiparianInput): RiparianResult {
	const n = input.outflowMm3.length;
	for (const [name, xs] of [['potentialEvaporationMm', input.potentialEvaporationMm], ['actualEvaporationMm', input.actualEvaporationMm], ['areaKm2', input.areaKm2]] as const) {
		if (xs.length !== n) throw new RangeError(`riparianDeduction: ${name} has ${xs.length} months, outflow has ${n}`);
	}
	const outflowMm3: number[] = [];
	const demandMm3: number[] = [];
	const lossMm3: number[] = [];
	for (let t = 0; t < n; t++) {
		const q = input.outflowMm3[t]!;
		const etvol = riparianVolume(evaporationDeficit(input.potentialEvaporationMm[t]!, input.actualEvaporationMm[t]!), input.riparianPercent, input.areaKm2[t]!);
		const out = Math.max(0, q - etvol); // eq. 12.12
		outflowMm3.push(out);
		demandMm3.push(etvol);
		lossMm3.push(Math.max(0, q - out));
	}
	return { outflowMm3, demandMm3, lossMm3 };
}

// ---------------------------------------------------------------------------
// Areas and flow statistics
// ---------------------------------------------------------------------------

/**
 * Alien area per month, km², over hydrological years `startYear` … `endYear`
 * (12 per year, October first). Natural mode: 0 (TT 689 p.27). Present day:
 * the table's value in `mode.year` (D1). Historical: the year's value, linear
 * between listed years and flat beyond them (`yearTableValue`, OQ-17; TT 689
 * p.128 "determined for every given year").
 */
export function alienAreaByMonth(table: YearTable, mode: RunMode, startYear: HydroYear, endYear: HydroYear): number[] {
	const out: number[] = [];
	for (let y = startYear; y <= endYear; y++) {
		const a = mode.kind === 'natural' ? 0 : yearTableValue(table, mode.kind === 'presentDay' ? mode.year : y);
		for (let m = 0; m < 12; m++) out.push(a);
	}
	return out;
}

/** Mean annual flow and low flow of a monthly volume series. */
export interface FlowStatistics {
	/** Mean of the hydrological-year totals, million m³/a (the "Virgin MAR" of a natural series). */
	readonly marMm3: number;
	/** Mean of the lowest 25 % of the monthly values (TT 689 p.138), million m³/month. */
	readonly lowFlowMm3: number;
}

/** MAR and low flow (TT 689 p.138: "ranking all monthly flows, selecting the 25% lowest and calculating the mean"; count = round(n / 4), at least 1, R6-V12). */
export function flowStatistics(values: readonly number[]): FlowStatistics {
	const n = values.length;
	if (n === 0) return { marMm3: 0, lowFlowMm3: 0 };
	const total = values.reduce((a, b) => a + b, 0);
	const sorted = [...values].sort((a, b) => a - b);
	const k = Math.max(1, Math.round(n / 4));
	let low = 0;
	for (let i = 0; i < k; i++) low += sorted[i]!;
	return { marMm3: (total / n) * 12, lowFlowMm3: low / k };
}

// ---------------------------------------------------------------------------
// The reduction for one module
// ---------------------------------------------------------------------------

/** `ReductionInput` plus what the riparian deduction needs. */
export interface AlienReductionInput extends ReductionInput {
	/**
	 * Monthly potential (PEACT) and actual (EAVE) evaporation of the module's
	 * run, mm, one per month of `unreducedRunoffMm3`. Without them the
	 * riparian deduction is skipped with a warning.
	 */
	readonly evaporation?: { readonly potentialMm: readonly number[]; readonly actualMm: readonly number[] };
	readonly options?: Partial<AlienOptions>;
}

export interface AlienReductionOutput extends ReductionOutput {
	readonly targets: { readonly tprm: number; readonly tprl: number };
	/** Alien area per month, km². */
	readonly areaKm2: readonly number[];
	/** ETVOL per month (TS_RipVegDemand), million m³/month; zeros when the deduction is off. */
	readonly riparianDemandMm3: MonthlySeries;
}

/**
 * Alien vegetation as a `StreamflowReduction` on one runoff module.
 *
 * - Free module: `unreducedRunoffMm3` is the whole module's runoff. Month t
 *   loses (alien area / AREA) × TPRM % of it (R6-V11), then the riparian loss
 *   (eqs. 12.10–12.12) comes off what is left.
 * - Child (`parent` set): `unreducedRunoffMm3` is the child's virgin run (the
 *   parent's climate and parameters on the child's active area, TT 689
 *   p.140). The returned reduction is TPRM % of it, whose annual mean is
 *   exactly VMAR − QMAR; the WRSM2000 route instead re-runs the child with
 *   adjusted parameters to reach `targets` (TT 690 p.125, `sfr.ts`) and then
 *   applies `riparianDeduction` to that run. `virginMarMm3` is the virgin
 *   series' MAR.
 *
 * Natural mode removes everything (TT 689 p.27). The reduction is ≥ 0 and
 * never more than the unreduced runoff of the month.
 */
export function alienVegetationReduction(input: AlienReductionInput): AlienReductionOutput {
	const options: AlienOptions = { ...DEFAULT_ALIEN_OPTIONS, ...input.options };
	const { module, mode, startYear, endYear } = input;
	const ref = { type: 'RU', number: module.number } as const;
	const messages: RunMessage[] = [];
	const q = input.unreducedRunoffMm3.values;
	const n = q.length;
	if (n !== 12 * (endYear - startYear + 1)) throw new RangeError(`RU ${module.number}: unreduced runoff has ${n} months, the run ${startYear}–${endYear} has ${12 * (endYear - startYear + 1)}`);

	const isChild = input.parent !== null;
	const virgin = isChild ? { virginMarMm3: flowStatistics(q).marMm3 } : {};
	const zeros = (): MonthlySeries => ({ startYear, values: new Array<number>(n).fill(0), unit: 'Mm3' });
	const alien = module.alienVegetation;
	const area = alien ? alienAreaByMonth(alien.areaKm2, mode, startYear, endYear) : new Array<number>(n).fill(0);
	const none = (tprm = 0, tprl = 0): AlienReductionOutput => ({ reductionMm3: zeros(), ...virgin, messages, targets: { tprm, tprl }, areaKm2: area, riparianDemandMm3: zeros() });

	if (!alien || alien.areaKm2.length === 0 || alien.algorithm === 0 || mode.kind === 'natural') return none();

	const targets = alienReductionTargets(alien, options);
	for (const m of targets.messages) messages.push({ ...m, module: ref, text: `RU ${module.number}: ${m.text}` });
	if (targets.messages.some((m) => m.level === 'error')) return none();

	// TT 689 pp.128-129: the alien area can never be greater than the catchment.
	let overArea = false;
	for (let t = 0; t < n; t++) {
		if (area[t]! < 0) {
			messages.push({ level: 'error', module: ref, text: `RU ${module.number}: alien vegetation area ${area[t]} km² is negative` });
			return none(targets.tprm, targets.tprl);
		}
		if (area[t]! > module.areaKm2 + 1e-9) overArea = true;
	}
	if (overArea) messages.push({ level: 'error', module: ref, text: `RU ${module.number}: alien vegetation area exceeds the module's area ${module.areaKm2} km² (TT 689 p.128); held at the module's area` });
	if (!isChild && module.pitman.FT > 0) {
		messages.push({ level: 'info', module: ref, text: `RU ${module.number}: alien vegetation in a free module with FT > 0; TT 689 p.140 models it as an SFR child unless FT = 0` });
	}

	// Month by month: share of the module's runoff that comes off the alien area.
	const share = (t: number): number => (isChild ? (area[t]! > 0 ? 1 : 0) : Math.min(1, area[t]! / module.areaKm2));
	let lowThreshold = -Infinity;
	if (options.freeModuleMonths === 'lowFlowMonths') {
		const sorted = [...q].sort((a, b) => a - b);
		lowThreshold = sorted[Math.max(0, Math.round(n / 4) - 1)]!;
	}
	const afterCsir: number[] = [];
	for (let t = 0; t < n; t++) {
		const qt = q[t]!;
		const pct = qt <= lowThreshold ? targets.tprl : targets.tprm;
		const cut = qt > 0 ? share(t) * (pct / 100) * qt : 0;
		afterCsir.push(qt - cut);
	}

	// Riparian deduction (TT 690 §12.5; on whenever the riparian % > 0, R6-V8).
	let after = afterCsir;
	let demand = zeros().values as number[];
	if (alien.riparianArea > 0) {
		if (!input.evaporation) {
			messages.push({ level: 'warning', module: ref, text: `RU ${module.number}: riparian alien vegetation (${alien.riparianArea} %) needs the run's potential and actual evaporation; deduction skipped` });
		} else {
			const ripArea = options.riparianArea === 'module' ? area.map((a) => (a > 0 ? module.areaKm2 : 0)) : area.map((a) => Math.min(a, module.areaKm2));
			const rip = riparianDeduction({
				outflowMm3: afterCsir.map((v) => Math.max(0, v)),
				potentialEvaporationMm: input.evaporation.potentialMm,
				actualEvaporationMm: input.evaporation.actualMm,
				riparianPercent: alien.riparianArea,
				areaKm2: ripArea
			});
			after = afterCsir.map((v, t) => (v > 0 ? rip.outflowMm3[t]! : v));
			demand = rip.demandMm3;
		}
	}

	const reduction = q.map((qt, t) => Math.min(Math.max(0, qt), Math.max(0, qt - after[t]!)));
	return {
		reductionMm3: { startYear, values: reduction, unit: 'Mm3' },
		...virgin,
		messages,
		targets: { tprm: targets.tprm, tprl: targets.tprl },
		areaKm2: area,
		riparianDemandMm3: { startYear, values: demand, unit: 'Mm3' }
	};
}
