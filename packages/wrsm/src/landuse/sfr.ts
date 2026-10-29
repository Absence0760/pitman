/**
 * The SFR (streamflow reduction) Parent/Child mechanism: TT 690 §11.2
 * (pp.124–127), TT 689 §6.2.2.3 (pp.128–141) and TT 691 §7.4.2 (pp.52–53).
 * Spec: docs/theory/afforestation.md §4–6. Shared by afforestation
 * (`forest.ts`) and alien vegetation (`alien.ts`, which supplies a
 * `ChildTargetModel`).
 *
 * In one sentence: each child copies its parent's climate and parameters,
 * runs virgin over its active (afforested / invaded) area to give "Virgin
 * MAR", gets target % reductions from its algorithm, then has PI, FF, SL
 * and ST (and HGSL) adjusted until its own runoff shows those reductions;
 * the parent runs on its area less the children's active areas, and adds
 * the children's flows to its own.
 *
 * Pure: the runoff model itself is injected (`SfrSimulator`), so the same
 * code drives classic Pitman, Hughes and Sami modules.
 */

import { yearTableValue } from '../runoff/pitman.js';
import type {
	HydroYear,
	MonthlySeries,
	PitmanParameters,
	RunMessage,
	RunMode,
	RunoffDiagnostics,
	RunoffModule,
	YearTable
} from '../types.js';
import { forestChildTargets, hasAfforestation, type ForestOptions, type SfrTargets } from './forest.js';

// ---------------------------------------------------------------------------
// What the runner supplies
// ---------------------------------------------------------------------------

/** One run of a runoff module, as the runner's model returns it. */
export interface SfrRun {
	/** Generated runoff, million m³/month, for `module.areaKm2`, over the group's run period; no RTIN inflow added. */
	readonly outflow: MonthlySeries;
	readonly diagnostics?: RunoffDiagnostics;
	readonly messages: readonly RunMessage[];
}

/**
 * The runoff model (classic, Hughes or Sami, whichever `module.groundwaterModel`
 * selects), with the rainfall and run period already bound. It must not
 * apply SFR children itself, and must run the module's afforestation and
 * alien vegetation as absent (a child's land use acts through its
 * parameters; a parent may not have any, TT 689 p.140).
 */
export type SfrSimulator = (module: RunoffModule) => SfrRun;

/** What a child's target model is given. */
export interface ChildTargetInput {
	/** The child after it has copied its parent's climate and parameters (`inheritFromParent`). */
	readonly child: RunoffModule;
	readonly parent: RunoffModule;
	readonly mode: RunMode;
	readonly startYear: HydroYear;
	readonly endYear: HydroYear;
	/** The child's active area in each hydrological year of the run, km². */
	readonly areaKm2ByYear: readonly number[];
	/** The child's virgin run over its active area. */
	readonly virgin: { readonly outflowMm3: readonly number[]; readonly marMm3: number; readonly lowFlowMm3: number; readonly run: SfrRun | null };
}

/** The final calibrated run of a child, for a target model's after-calibration step. */
export interface ChildFinalRun {
	readonly child: RunoffModule;
	readonly areaKm2ByYear: readonly number[];
	/** The calibrated child's runoff, million m³/month. */
	readonly outflowMm3: readonly number[];
	/** The unscaled run (for `areaKm2 = max active area`), with its diagnostics. */
	readonly run: SfrRun | null;
}

/** What a child's target model returns. */
export interface ChildTargetResult {
	/** TPRM and TPRL; `null` for no reduction (the child runs virgin). */
	readonly targets: SfrTargets | null;
	/** The algorithm, as the run log's "SFR is …" names it. */
	readonly label: string;
	readonly messages: readonly RunMessage[];
	/**
	 * An optional step after calibration that changes the child's flows, for
	 * the riparian alien-vegetation deduction, which is "subtracted from the
	 * residual runoff" of the child (TT 689 p.129, p.139 example 1).
	 */
	readonly adjustOutflow?: (final: ChildFinalRun) => { readonly outflowMm3: readonly number[]; readonly messages: readonly RunMessage[] };
}

/** Target reductions for one kind of SFR child (afforestation, alien vegetation). TT 691 p.55 RU_GetSFReduction. */
export type ChildTargetModel = (input: ChildTargetInput) => ChildTargetResult;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Options for the child calibration. Each has an ID in docs/theory/afforestation.md §7. */
export interface SfrOptions {
	/**
	 * R6-F6: the "predetermined relationship between ΔPI and ΔFF" (TT 690
	 * p.126), ΔPI = k·ΔFF. The manual doesn't give k; 34 is inferred from the
	 * public WR2012 run logs (`WRSM2000.ERR` DPI/DFF lines).
	 */
	readonly piPerFf: number;
	/**
	 * R6-F7: the factor on ΔSL (= ΔST) at update `n` (0 = the pre-iteration
	 * solve, n = after iteration n). Inferred from the run logs: 0.7 up to
	 * update 10, 0.35 after.
	 */
	readonly slStepFactor: (update: number) => number;
	/**
	 * R6-F8: what happens when SL would go below 0. `reflect` (default,
	 * inferred from the run logs): SL = 0 and ST grows by twice the overshoot.
	 * `clamp`: SL = 0 and ST moves by the same ΔSL.
	 */
	readonly slFloor: 'reflect' | 'clamp';
	/**
	 * R6-F9: the closing error at iteration i, in % points of the virgin MAR /
	 * low flow, both |ERRM| and |ERRL| must be within it. TT 689 p.139: "within
	 * 1% … if this is not reached within 10 iterations, it increases the
	 * closing error until closure is achieved". Default 1 for i ≤ 10, then 2,
	 * 4, 8, 16 at iterations 11, 17, 25, 33 (the steps the run logs show).
	 */
	readonly tolerance: (iteration: number) => number;
	/** TT 689 p.139: "40 iterations allowed in total". */
	readonly maxIterations: number;
	/**
	 * R6-F10: the published constants A, B, C, X, Y, Z of eqs. 11.2–11.3
	 * "depend on MAP and ST" but their formulas are not given (TT 690 p.126).
	 * They are estimated from two extra runs at the start: one with ΔFF =
	 * `ff` (and ΔPI = k·ΔFF), one with ΔSL = ΔST = `sl` mm.
	 */
	readonly jacobianStep: { readonly ff: number; readonly sl: number };
	/** Options for the default afforestation target model. */
	readonly forest: Partial<ForestOptions>;
}

/** R6-F9 default schedule. */
export function defaultTolerance(iteration: number): number {
	if (iteration <= 10) return 1;
	return 2 ** (1 + Math.floor((iteration - 9) / 8));
}

export const DEFAULT_SFR_OPTIONS: SfrOptions = {
	piPerFf: 34,
	slStepFactor: (update) => (update <= 10 ? 0.7 : 0.35),
	slFloor: 'reflect',
	tolerance: defaultTolerance,
	maxIterations: 40,
	jacobianStep: { ff: 0.1, sl: 10 },
	forest: {}
};

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

/** Mean annual volume of a monthly series, million m³/year (12 months a year). */
export function meanAnnual(values: readonly number[]): number {
	if (values.length === 0) return 0;
	let sum = 0;
	for (const v of values) sum += v;
	return (sum / values.length) * 12;
}

/**
 * Low flow, "the average of the 25% lowest monthly flows … ranking all
 * monthly flows, selecting the 25% lowest and calculating the mean of this
 * set" (TT 689 p.138), in the series' unit. The count is ⌊N/4⌋ (at least 1);
 * N is a multiple of 12, so it is exact.
 */
export function lowFlow(values: readonly number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const n = Math.max(1, Math.floor(sorted.length / 4));
	let sum = 0;
	for (let i = 0; i < n; i++) sum += sorted[i]!;
	return sum / n;
}

/** The kind of SFR a child carries (TT 691 p.52 NSFR, collapsed to the two model families). */
export type SfrKind = 'forest' | 'alien' | 'none';

/** Whether a module has alien vegetation a run would see: a CSIR or riparian algorithm and some area above zero. */
export function hasAlienVegetation(module: RunoffModule): boolean {
	const av = module.alienVegetation;
	return !!av && av.algorithm !== 0 && av.areaKm2.some((row) => row.value > 0);
}

/**
 * The child's SFR kind. A child holds one SFR (TT 691 p.52 NSFR is a single
 * code); when a file has both, afforestation wins and the alien vegetation
 * is ignored with a warning from `runSfrGroup` (R6-F11).
 */
export function sfrKind(child: RunoffModule): SfrKind {
	if (hasAfforestation(child)) return 'forest';
	if (hasAlienVegetation(child)) return 'alien';
	return 'none';
}

/** The child's active-area year table for its SFR kind. */
export function activeAreaTable(child: RunoffModule, kind: SfrKind): YearTable {
	if (kind === 'forest') return child.afforestation.areaKm2;
	if (kind === 'alien') return child.alienVegetation?.areaKm2 ?? [];
	return [];
}

/**
 * Active area in each hydrological year of the run, km² (TT 689 p.140:
 * "only that area that is afforested … as specified by means of the
 * year/area pairs"). The year table is interpolated as every RU year table
 * is (OQ-17, R3-N10), and held for the whole hydrological year (R6-F12).
 * Present day holds it at the mode's year (D1); natural removes it.
 */
export function activeAreaByYear(table: YearTable, mode: RunMode, startYear: HydroYear, endYear: HydroYear): number[] {
	const out: number[] = [];
	for (let y = startYear; y <= endYear; y++) {
		if (mode.kind === 'natural') out.push(0);
		else out.push(Math.max(0, yearTableValue(table, mode.kind === 'presentDay' ? mode.year : y)));
	}
	return out;
}

/** The Pitman parameter set the module's groundwater model runs with (L.003, L.023 or L.035). */
export function activePitman(module: RunoffModule): PitmanParameters {
	switch (module.groundwaterModel ?? 0) {
		case 1:
			return module.hughes?.pitman ?? module.pitman;
		case 2:
			return module.sami?.pitman ?? module.pitman;
		default:
			return module.pitman;
	}
}

/** HGSL of the active groundwater model (Hughes L.022 v2, Sami L.032 v6); 0 for classic Pitman, which has none. */
export function activeHGSL(module: RunoffModule): number {
	switch (module.groundwaterModel ?? 0) {
		case 1:
			return module.hughes?.HGSL ?? 0;
		case 2:
			return module.sami?.HGSL ?? 0;
		default:
			return 0;
	}
}

/**
 * The child as it runs: "the Parent will overwrite all the Climate data and
 * the Simulation Parameters of the Children with the values that it (the
 * Parent) has" (TT 689 p.138; TT 691 p.53–54 RU_CopyClimate,
 * RU_CopyParameters), including the groundwater model (TT 689 p.138).
 *
 * Kept from the child: number, name, L.002 area (a check only, TT 689
 * p.139), its land-use tables and its outflow route. Not inherited: paved
 * area (children may not have any, TT 689 p.140), the RTIN inflow and the
 * upstream groundwater link (the parent's), and Sami groundwater
 * abstractions, which are volumes for the parent's catchment (R6-F13).
 */
export function inheritFromParent(parent: RunoffModule, child: RunoffModule): RunoffModule {
	const next: { -readonly [K in keyof RunoffModule]: RunoffModule[K] } = {
		...child,
		mapMm: parent.mapMm,
		rainfallFile: parent.rainfallFile,
		pitman: parent.pitman,
		sPanMm: parent.sPanMm,
		panFactors: parent.panFactors
	};
	delete next.paved;
	delete next.inflowRoute;
	delete next.upstreamGroundwaterModule;
	delete next.sfrChildren;
	delete next.groundwaterModel;
	delete next.hughes;
	delete next.sami;
	delete next.aPanFactors;
	if (parent.aPanFactors) next.aPanFactors = parent.aPanFactors;
	if (parent.groundwaterModel !== undefined) next.groundwaterModel = parent.groundwaterModel;
	if (parent.hughes) next.hughes = parent.hughes;
	if (parent.sami) next.sami = { ...parent.sami, abstractions: [] };
	return next;
}

/** The parameters the calibration adjusts (TT 690 p.126; HGSL from TT 689 p.138). */
export interface SfrParameters {
	readonly PI: number;
	readonly FF: number;
	readonly SL: number;
	readonly ST: number;
	readonly HGSL: number;
}

export function sfrParameters(module: RunoffModule): SfrParameters {
	const p = activePitman(module);
	return { PI: p.PI, FF: p.FF, SL: p.SL, ST: p.ST, HGSL: activeHGSL(module) };
}

/** The module with `params` written into its active Pitman set (and HGSL into its groundwater set). */
export function withSfrParameters(module: RunoffModule, params: SfrParameters): RunoffModule {
	const set = (p: PitmanParameters): PitmanParameters => ({ ...p, PI: params.PI, FF: params.FF, SL: params.SL, ST: params.ST });
	switch (module.groundwaterModel ?? 0) {
		case 1:
			if (!module.hughes) return { ...module, pitman: set(module.pitman) };
			return module.hughes.pitman
				? { ...module, hughes: { ...module.hughes, pitman: set(module.hughes.pitman), HGSL: params.HGSL } }
				: { ...module, pitman: set(module.pitman), hughes: { ...module.hughes, HGSL: params.HGSL } };
		case 2:
			if (!module.sami) return { ...module, pitman: set(module.pitman) };
			return { ...module, sami: { ...module.sami, pitman: set(module.sami.pitman), HGSL: params.HGSL } };
		default:
			return { ...module, pitman: set(module.pitman) };
	}
}

/**
 * One parameter update: ΔFF = u, ΔPI = k·u, ΔSL = ΔST = v (TT 690 p.126:
 * "a predetermined relationship between ΔPI and ΔFF … ΔSL and ΔST were the
 * same"); HGSL moves with SL (R6-F14). SL floors at 0 by `slFloor` (R6-F8).
 * PI floors at 0 and FF at 0.01 (R6-F15).
 */
export function applySfrStep(p: SfrParameters, u: number, v: number, k: number, slFloor: SfrOptions['slFloor']): SfrParameters {
	const PI = Math.max(0, p.PI + k * u);
	const FF = Math.max(0.01, p.FF + u);
	const rawSL = p.SL + v;
	let SL: number;
	let ST: number;
	if (rawSL >= 0) {
		SL = rawSL;
		ST = p.ST + v;
	} else {
		SL = 0;
		ST = slFloor === 'reflect' ? p.ST - 2 * rawSL : p.ST + v;
		if (ST <= SL) ST = p.ST;
	}
	const HGSL = Math.max(0, p.HGSL + (SL - p.SL));
	return { PI, FF, SL, ST, HGSL };
}

// ---------------------------------------------------------------------------
// Running one child
// ---------------------------------------------------------------------------

/** One iteration of the child calibration, as the run log prints it. */
export interface SfrIteration {
	readonly iteration: number;
	readonly parameters: SfrParameters;
	/** "Iteration QMAR", million m³/year. */
	readonly marMm3: number;
	/** "Iteration QLQT", million m³/month (the log's unit is not stated, U-17). */
	readonly lowFlowMm3: number;
	/** "ERRM": TPRM − achieved MAR reduction, % points. */
	readonly errMar: number;
	/** "ERRL": TPRL − achieved low-flow reduction, % points. */
	readonly errLowFlow: number;
}

/** A child's result. */
export interface SfrChildResult {
	readonly number: number;
	readonly kind: SfrKind;
	/** "SFR is …". */
	readonly label: string;
	readonly areaKm2ByYear: readonly number[];
	/** The child's flow, million m³/month: what its own outflow route carries and what it adds to the parent. */
	readonly outflowMm3: MonthlySeries;
	/** "Virgin MAR", million m³/year; `null` when the child was not run (natural mode). */
	readonly virginMarMm3: number | null;
	/** "Virgin LQT", million m³/month (U-17). */
	readonly virginLowFlowMm3: number | null;
	/** TPRM / TPRL as used (0 when the virgin MAR is 0); `null` when the algorithm gives none. */
	readonly targets: SfrTargets | null;
	/** Reductions achieved by the final run, % of virgin MAR / low flow. */
	readonly achieved: SfrTargets | null;
	readonly initialParameters: SfrParameters | null;
	readonly finalParameters: SfrParameters | null;
	readonly iterations: readonly SfrIteration[];
	readonly converged: boolean;
	/** The final run, unscaled (for `areaKm2` = the largest active area), for diagnostics. */
	readonly run: SfrRun | null;
}

interface Scaled {
	readonly run: SfrRun | null;
	readonly values: number[];
}

/** Run `module` over a year-varying area: once at the largest area, scaled per year (R6-F16). */
function runOverArea(simulate: SfrSimulator, module: RunoffModule, areaByYear: readonly number[], months: number, startYear: HydroYear): Scaled {
	const aRef = Math.max(0, ...areaByYear);
	if (!(aRef > 0)) return { run: null, values: new Array<number>(months).fill(0) };
	const run = simulate({ ...module, areaKm2: aRef });
	if (run.outflow.startYear !== startYear || run.outflow.values.length !== months) {
		throw new Error(`RU ${module.number}: the simulator returned ${run.outflow.values.length} months from ${run.outflow.startYear}, expected ${months} from ${startYear}`);
	}
	const values = run.outflow.values.map((v, i) => {
		const a = areaByYear[Math.floor(i / 12)]!;
		return a === aRef ? v : (v * a) / aRef;
	});
	return { run, values };
}

function reductionPercent(achieved: number, virgin: number): number {
	return virgin > 0 ? 100 * (1 - achieved / virgin) : 0;
}

/** Solve [a b; c d]·[u v] = [e f]; null when singular. */
function solve2(a: number, b: number, c: number, d: number, e: number, f: number): [number, number] | null {
	const det = a * d - b * c;
	const scale = Math.max(Math.abs(a * d), Math.abs(b * c), 1e-300);
	if (!Number.isFinite(det) || Math.abs(det) <= 1e-12 * scale) return null;
	return [(e * d - b * f) / det, (a * f - e * c) / det];
}

interface ChildContext {
	readonly parent: RunoffModule;
	readonly mode: RunMode;
	readonly startYear: HydroYear;
	readonly endYear: HydroYear;
	readonly simulate: SfrSimulator;
	readonly targetModel: ChildTargetModel | undefined;
	readonly options: SfrOptions;
}

function runChild(rawChild: RunoffModule, kind: SfrKind, ctx: ChildContext, messages: RunMessage[]): SfrChildResult {
	const { parent, mode, startYear, endYear, simulate, options } = ctx;
	const ref = { type: 'RU', number: rawChild.number } as const;
	const months = 12 * (endYear - startYear + 1);
	const series = (values: number[]): MonthlySeries => ({ startYear, values, unit: 'Mm3' });
	const child = inheritFromParent(parent, rawChild);
	const areaKm2ByYear = activeAreaByYear(activeAreaTable(rawChild, kind), mode, startYear, endYear);
	const zero = (label: string): SfrChildResult => ({
		number: rawChild.number,
		kind,
		label,
		areaKm2ByYear,
		outflowMm3: series(new Array<number>(months).fill(0)),
		virginMarMm3: null,
		virginLowFlowMm3: null,
		targets: null,
		achieved: null,
		initialParameters: null,
		finalParameters: null,
		iterations: [],
		converged: true,
		run: null
	});

	// D1 natural: "child modules have no effect as afforestation and alien vegetation are ignored" (TT 689 p.13).
	if (mode.kind === 'natural') return zero('none (natural)');

	const maxArea = Math.max(0, ...areaKm2ByYear);
	if (maxArea > rawChild.areaKm2 + 1e-9) {
		messages.push({ level: 'warning', module: ref, text: `RU ${rawChild.number}: SFR area reaches ${maxArea.toFixed(2)} km², more than the child's own area ${rawChild.areaKm2} km² (TT 689 p.139)` });
	}

	// Virgin run (the "Virgin MAR" / "Virgin LQT" lines).
	const virgin = runOverArea(simulate, child, areaKm2ByYear, months, startYear);
	if (virgin.run) for (const m of virgin.run.messages) messages.push(m);
	const vmar = meanAnnual(virgin.values);
	const vlqt = lowFlow(virgin.values);

	const target: ChildTargetResult = ctx.targetModel
		? ctx.targetModel({ child, parent, mode, startYear, endYear, areaKm2ByYear, virgin: { outflowMm3: virgin.values, marMm3: vmar, lowFlowMm3: vlqt, run: virgin.run } })
		: {
				targets: null,
				label: kind === 'none' ? 'none' : `${kind} (no model)`,
				messages:
					kind === 'none'
						? []
						: [{ level: 'warning', module: ref, text: `RU ${rawChild.number}: no ${kind === 'alien' ? 'alien vegetation' : 'afforestation'} model was supplied; the child runs virgin` }]
			};
	for (const m of target.messages) messages.push(m);

	// A zero virgin MAR zeroes both targets (the run logs, "Reduction percentage … = 0.0000" after "Naturalised MAR (VMAR) = 0.0000").
	const targets: SfrTargets | null = target.targets && vmar > 0 ? target.targets : target.targets ? { marPercent: 0, lowFlowPercent: 0 } : null;
	const initial = sfrParameters(child);

	let final: Scaled = virgin;
	let finalParams = initial;
	const iterations: SfrIteration[] = [];
	let converged = true;

	const needsCalibration = targets !== null && (targets.marPercent !== 0 || targets.lowFlowPercent !== 0);
	if (needsCalibration) {
		const { piPerFf: k, slFloor } = options;
		const reductions = (values: number[]): [number, number] => [reductionPercent(meanAnnual(values), vmar), vlqt > 0 ? reductionPercent(lowFlow(values), vlqt) : 0];
		const runAt = (p: SfrParameters) => runOverArea(simulate, withSfrParameters(child, p), areaKm2ByYear, months, startYear);

		// R6-F10: estimate A·k + B, X·k + Y (per unit ΔFF) and C, Z (per unit ΔSL) from two runs.
		const du = options.jacobianStep.ff;
		const dv = options.jacobianStep.sl;
		const [mu, lu] = reductions(runAt(applySfrStep(initial, du, 0, k, 'clamp')).values);
		const [mv, lv] = reductions(runAt(applySfrStep(initial, 0, dv, k, 'clamp')).values);
		const J = { mu: mu / du, lu: lu / du, mv: mv / dv, lv: lv / dv };
		const step = (errM: number, errL: number): [number, number] => {
			const both = solve2(J.mu, J.mv, J.lu, J.lv, errM, errL);
			if (both) return both;
			// Singular (e.g. SL has no effect): steer MAR with FF/PI alone.
			return J.mu !== 0 ? [errM / J.mu, 0] : [0, 0];
		};

		// Pre-iteration: from no reduction to the targets.
		let params = initial;
		let [u, v] = step(targets.marPercent, targets.lowFlowPercent);
		params = applySfrStep(params, u, v * options.slStepFactor(0), k, slFloor);
		converged = false;
		for (let i = 1; i <= options.maxIterations; i++) {
			const r = runAt(params);
			const [rm, rl] = reductions(r.values);
			const errMar = targets.marPercent - rm;
			const errLowFlow = vlqt > 0 ? targets.lowFlowPercent - rl : 0;
			iterations.push({ iteration: i, parameters: params, marMm3: meanAnnual(r.values), lowFlowMm3: lowFlow(r.values), errMar, errLowFlow });
			final = r;
			finalParams = params;
			const tol = options.tolerance(i);
			if (Math.abs(errMar) <= tol && Math.abs(errLowFlow) <= tol) {
				converged = true;
				break;
			}
			if (i === options.maxIterations) break;
			[u, v] = step(errMar, errLowFlow);
			params = applySfrStep(params, u, v * options.slStepFactor(i), k, slFloor);
		}
		if (!converged) {
			const last = iterations[iterations.length - 1]!;
			messages.push({
				level: 'warning',
				module: ref,
				text: `RU ${rawChild.number}: the SFR iteration did not converge after ${options.maxIterations} iterations (required MAR reduction ${targets.marPercent.toFixed(2)} %, error in MAR ${last.errMar.toFixed(2)}, in low flow ${last.errLowFlow.toFixed(2)})`
			});
		}
		if (final.run) for (const m of final.run.messages) if (!messages.some((x) => x.text === m.text)) messages.push(m);
	}

	let outflow = final.values;
	if (target.adjustOutflow) {
		const adjusted = target.adjustOutflow({ child: withSfrParameters(child, finalParams), areaKm2ByYear, outflowMm3: outflow, run: final.run });
		outflow = [...adjusted.outflowMm3];
		for (const m of adjusted.messages) messages.push(m);
	}

	const achieved: SfrTargets | null = targets ? { marPercent: reductionPercent(meanAnnual(final.values), vmar), lowFlowPercent: reductionPercent(lowFlow(final.values), vlqt) } : null;
	return {
		number: rawChild.number,
		kind,
		label: target.label,
		areaKm2ByYear,
		outflowMm3: series(outflow),
		virginMarMm3: vmar,
		virginLowFlowMm3: vlqt,
		targets,
		achieved,
		initialParameters: initial,
		finalParameters: finalParams,
		iterations,
		converged,
		run: final.run
	};
}

// ---------------------------------------------------------------------------
// A parent and its children
// ---------------------------------------------------------------------------

/** What `runSfrGroup` needs. Modules as `applyRunMode` returns them for `mode`. */
export interface SfrGroupInput {
	readonly parent: RunoffModule;
	/** The modules `parent.sfrChildren` names, in that order. */
	readonly children: readonly RunoffModule[];
	readonly mode: RunMode;
	readonly startYear: HydroYear;
	readonly endYear: HydroYear;
	readonly simulate: SfrSimulator;
	/** Target models by SFR kind. Afforestation defaults to `forestTargetModel(options.forest)`; alien vegetation has no default (agent 6.4's `alien.ts`). */
	readonly targets?: { readonly forest?: ChildTargetModel; readonly alien?: ChildTargetModel };
}

/** What `runSfrGroup` returns. */
export interface SfrGroupResult {
	/** The parent's generated runoff, its own plus every child's, million m³/month: the series RTIN is added to and L.020 splits (TT 689 p.140). */
	readonly outflowMm3: MonthlySeries;
	/** The parent's own runoff over its reduced area. */
	readonly parentOwnMm3: MonthlySeries;
	/** The parent's area per hydrological year, km²: L.002 less the children's active areas (TT 689 p.140). */
	readonly parentAreaKm2ByYear: readonly number[];
	/** The parent's run, unscaled (for `areaKm2` = its largest area). */
	readonly parentRun: SfrRun | null;
	/** Each child's result, in `children` order. */
	readonly children: readonly SfrChildResult[];
	/** "Virgin MAR" per child module number, million m³/year (absent in natural mode). For `RunResult.virginMarMm3`. */
	readonly virginMarMm3: Readonly<Record<number, number>>;
	readonly messages: readonly RunMessage[];
}

/** `forestChildTargets` as a `ChildTargetModel`. */
export function forestTargetModel(options: Partial<ForestOptions> = {}): ChildTargetModel {
	return ({ child }) => forestChildTargets(child, options);
}

/**
 * Run an SFR parent with its children (TT 689 p.140: "When a Parent Module
 * is run, it first instructs all of its Child Modules to run their
 * simulation … When the Parent catchment is simulated, its area is reduced
 * by the active Child areas … Once the simulation is complete, we add the
 * outflows from the SFR Child catchments to the flows from the Parent
 * catchment, and that is the final outflow of the catchment").
 */
export function runSfrGroup(input: SfrGroupInput, options: Partial<SfrOptions> = {}): SfrGroupResult {
	const opt: SfrOptions = { ...DEFAULT_SFR_OPTIONS, ...options };
	const { parent, mode, startYear, endYear, simulate } = input;
	const ref = { type: 'RU', number: parent.number } as const;
	const messages: RunMessage[] = [];
	const months = 12 * (endYear - startYear + 1);
	const years = endYear - startYear + 1;
	const series = (values: number[]): MonthlySeries => ({ startYear, values, unit: 'Mm3' });

	if (!(Number.isInteger(startYear) && Number.isInteger(endYear) && endYear >= startYear)) {
		throw new Error(`RU ${parent.number}: bad run period ${startYear}–${endYear}`);
	}
	if (mode.kind !== 'natural' && activePitman(parent).FT === 0 && input.children.length > 0) {
		messages.push({ level: 'warning', module: ref, text: `RU ${parent.number}: FT = 0 in an SFR parent; the parameter-adjustment equations "definitely do not apply" (TT 690 p.127)` });
	}
	if (hasAfforestation(parent) || hasAlienVegetation(parent)) {
		messages.push({ level: 'warning', module: ref, text: `RU ${parent.number}: an SFR parent may not have afforestation or alien vegetation of its own (TT 689 p.134, p.140); ignored` });
	}

	const targets = { forest: input.targets?.forest ?? forestTargetModel(opt.forest), alien: input.targets?.alien };
	const children: SfrChildResult[] = [];
	for (const child of input.children) {
		const cref = { type: 'RU', number: child.number } as const;
		if (child.sfrChildren && child.sfrChildren.length > 0) {
			messages.push({ level: 'warning', module: cref, text: `RU ${child.number}: a child cannot be a parent (TT 689 p.141); its own children are ignored` });
		}
		if (child.paved && child.paved.fraction.some((r) => r.value > 0)) {
			messages.push({ level: 'warning', module: cref, text: `RU ${child.number}: a child may not have paved area (TT 689 p.140); ignored` });
		}
		const kind = sfrKind(child);
		if (kind === 'forest' && hasAlienVegetation(child)) {
			messages.push({ level: 'warning', module: cref, text: `RU ${child.number}: has both afforestation and alien vegetation; one SFR per child, so the alien vegetation is ignored (R6-F11)` });
		}
		children.push(
			runChild(child, kind, { parent, mode, startYear, endYear, simulate, targetModel: kind === 'none' ? undefined : targets[kind], options: opt }, messages)
		);
	}

	// The parent's area, year by year.
	const parentAreaKm2ByYear: number[] = [];
	for (let y = 0; y < years; y++) {
		let a = parent.areaKm2;
		for (const c of children) a -= c.areaKm2ByYear[y]!;
		if (a < -1e-9) {
			messages.push({
				level: 'error',
				module: ref,
				at: { year: startYear + y, month: 0 },
				text: `RU ${parent.number}: the children's active areas exceed the parent's area ${parent.areaKm2} km² in ${startYear + y} (TT 689 p.127); the parent's own area is taken as 0`
			});
		}
		parentAreaKm2ByYear.push(Math.max(0, a));
	}
	const own = runOverArea(simulate, parent, parentAreaKm2ByYear, months, startYear);
	if (own.run) for (const m of own.run.messages) messages.push(m);

	const total = own.values.slice();
	for (const c of children) for (let i = 0; i < months; i++) total[i]! += c.outflowMm3.values[i]!;

	const virginMarMm3: Record<number, number> = {};
	for (const c of children) if (c.virginMarMm3 !== null) virginMarMm3[c.number] = c.virginMarMm3;

	return {
		outflowMm3: series(total),
		parentOwnMm3: series(own.values),
		parentAreaKm2ByYear,
		parentRun: own.run,
		children,
		virginMarMm3,
		messages
	};
}
