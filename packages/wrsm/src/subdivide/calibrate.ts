/**
 * `calibrateMap`: one common factor on the pieces' MAPs so the quaternary's
 * natural MAR meets the target (decision D2; docs/theory/subdivide.md
 * § Calibration). Rain is `%MAP / 100 × MAP` (TT 690 §1.3), so the factor
 * acts through each piece's MAP alone.
 *
 * `solveFactor` is the loop with its guards, pure in a `MAR(maps)` function,
 * so a test can drive it with the spec's toy response. `calibrateMap` gives
 * it the real one: only the pieces' runoff modules, in natural mode, over the
 * `.RAN` years before extension.
 */

import { applyRunMode } from '../network/modes.js';
import { lookupFile } from '../network/modules.js';
import { PitmanRunError, runRunoffModule } from '../runoff/pitman.js';
import type { HydroYear, NetworkBundle, RainfallSeries, RunMode, RunoffModule } from '../types.js';
import { fileRound, scalePieceAreas } from './areas.js';
import type { CalibrateMap, CalibrationIteration, CalibrationResult, IterationStep, SplitPlan, UnsplitNaturalMar } from './contract.js';
import { findRunoff, hughesPieces, plannedModule, rainfallOf, samiPieces, siblingsOf, SubdivisionError } from './pieces.js';

/** D2: within 2 % of the target. */
export const MAR_TOLERANCE = 0.02;
/** B4: at most this many evaluations of `MAR(s)`, the starting one included. */
export const MAX_EVALUATIONS = 12;
/** B4: `s` stays in this range. */
export const FACTOR_BOUNDS = { low: 0.5, high: 2 } as const;
/** The engine's MAP range, mm (subdivide.md § Guards). */
export const MAP_LIMITS_MM = { low: 1, high: 12_000 } as const;

const NO_RUNOFF = 'the natural run gives no runoff, so no factor can be found';
const FACTOR_LIMIT = 'the MAPs would have to change by more than a factor of 2: check the target and the grid';
const MAP_LIMIT = `a piece's MAP would leave ${MAP_LIMITS_MM.low}–${MAP_LIMITS_MM.high} mm: check the target and the grid`;

export interface FactorSearch {
	readonly status: 'converged' | 'not_converged' | 'refused';
	readonly message: string | null;
	readonly iterations: readonly CalibrationIteration[];
	/** The accepted iteration, or the smallest `|e|`; `null` when refused. */
	readonly best: CalibrationIteration | null;
}

/**
 * The loop of subdivide.md § The iteration, over `marOf(s · MAP⁰)`, with
 * every guard. Calls `marOf` at most `MAX_EVALUATIONS` times.
 */
export function solveFactor(mapsAtOne: readonly number[], targetMm3: number, marOf: (mapsMm: readonly number[]) => number): FactorSearch {
	const refused = (message: string, iterations: readonly CalibrationIteration[] = []): FactorSearch => ({ status: 'refused', message, iterations, best: null });
	if (!(targetMm3 > 0)) return refused('the target natural MAR must be above zero');
	if (mapsAtOne.length === 0 || mapsAtOne.some((m) => !(m > 0))) return refused('every piece needs a MAP above zero to start from');

	const low = Math.max(FACTOR_BOUNDS.low, MAP_LIMITS_MM.low / Math.min(...mapsAtOne));
	const high = Math.min(FACTOR_BOUNDS.high, MAP_LIMITS_MM.high / Math.max(...mapsAtOne));
	if (low > high) return refused(MAP_LIMIT);
	const boundMessage = (bound: number) => ((bound === FACTOR_BOUNDS.low || bound === FACTOR_BOUNDS.high) ? FACTOR_LIMIT : MAP_LIMIT);

	const iterations: CalibrationIteration[] = [];
	const errors: number[] = [];
	const evaluate = (s: number, step: IterationStep): CalibrationIteration => {
		const maps = mapsAtOne.map((m) => s * m);
		const marMm3 = marOf(maps);
		const e = marMm3 - targetMm3;
		const iteration: CalibrationIteration = { n: iterations.length, s, maps, marMm3, errorPct: (e / targetMm3) * 100, step };
		iterations.push(iteration);
		errors.push(e);
		return iteration;
	};
	const close = (i: CalibrationIteration) => Math.abs(i.marMm3 - targetMm3) / targetMm3 <= MAR_TOLERANCE;
	const best = () => iterations.reduce((a, b) => (Math.abs(b.marMm3 - targetMm3) < Math.abs(a.marMm3 - targetMm3) ? b : a));
	const failed = (message: string): FactorSearch => ({ status: 'not_converged', message, iterations, best: best() });

	/** The tightest sign change of `e` among the iterates, or `null`. */
	const bracket = (): readonly [number, number] | null => {
		let below = -Infinity; // largest s with e < 0
		let above = Infinity; // smallest s with e > 0
		iterations.forEach((it, k) => {
			if (errors[k]! < 0) below = Math.max(below, it.s);
			else above = Math.min(above, it.s);
		});
		return Number.isFinite(below) && Number.isFinite(above) ? [Math.min(below, above), Math.max(below, above)] : null;
	};

	const clampedAt = new Map<number, number>();
	const start = Math.min(high, Math.max(low, 1));
	if (start !== 1) clampedAt.set(start, 1);
	let current = evaluate(start, start === 1 ? 'start' : 'clamped');
	if (current.marMm3 <= 0) return refused(NO_RUNOFF, iterations);

	while (!close(current)) {
		if (iterations.length >= MAX_EVALUATIONS) return failed(`no factor came within 2 % of the target in ${MAX_EVALUATIONS} runs: change the target, or use the best factor`);
		const k = iterations.length - 1;
		const e = errors[k]!;
		const known = bracket();
		let proposed: number;
		let step: IterationStep;
		if (k === 0) {
			proposed = current.s * (targetMm3 / current.marMm3);
			step = 'ratio';
		} else {
			const previous = iterations[k - 1]!;
			const de = e - errors[k - 1]!;
			const secant = de === 0 ? NaN : current.s - (e * (current.s - previous.s)) / de;
			if (known && !(secant > known[0] && secant < known[1])) {
				proposed = (known[0] + known[1]) / 2;
				step = 'bisect';
			} else if (Number.isFinite(secant)) {
				proposed = secant;
				step = 'secant';
			} else {
				// Flat with no bracket: the secant says nothing, so go to the bound runoff rises or falls towards.
				proposed = e > 0 ? -Infinity : Infinity;
				step = 'secant';
			}
		}
		const next = Math.min(high, Math.max(low, proposed));
		if (next !== proposed) {
			const times = (clampedAt.get(next) ?? 0) + 1;
			if (times >= 2) return failed(boundMessage(next));
			clampedAt.set(next, times);
			step = 'clamped';
		}
		current = evaluate(next, step);
	}
	return { status: 'converged', message: null, iterations, best: current };
}

const NATURAL: RunMode = { kind: 'natural' };

export interface NaturalPeriod {
	readonly startYear: HydroYear;
	readonly endYear: HydroYear;
}

/** WR2012's period: the `.RAN` years before extension (subdivide.md § What is compared; `originalEndYear`, extend.md § Step 8). */
export function naturalPeriod(bundle: NetworkBundle, rainfallFile: string, series: RainfallSeries): NaturalPeriod {
	const extension = bundle.sidecar?.rainfallExtensions ? lookupFile(bundle.sidecar.rainfallExtensions, rainfallFile) : undefined;
	return { startYear: series.rows[0]!.year, endYear: extension?.originalEndYear ?? series.rows[series.rows.length - 1]!.year };
}

/**
 * A module's mean annual natural runoff, Mm³/a: what it generates before any
 * route, with no land use, abstractions or SFR (D1, `applyRunMode`). An SFR
 * parent runs alone, as in natural mode its children have no area.
 */
function naturalMar(module: RunoffModule, series: RainfallSeries, period: NaturalPeriod): number {
	const applied = applyRunMode({ ...module, sfrChildren: [] }, NATURAL);
	const run = runRunoffModule(applied, series, { ...period, mode: NATURAL, parent: null, reductions: [] });
	const years = period.endYear - period.startYear + 1;
	return run.outflow.values.reduce((a, b) => a + b, 0) / years;
}

/** The modules the plan's pieces will be, areas and area-dependent fields set; MAPs are the loop's. */
function plannedPieces(module: RunoffModule, plan: SplitPlan): RunoffModule[] {
	const { areasKm2 } = scalePieceAreas(module.areaKm2, plan.pieces.map((p) => p.polygonKm2));
	const sami = samiPieces(module, areasKm2);
	const hughes = hughesPieces(module, areasKm2);
	return areasKm2.map((areaKm2, i) => ({ ...module, areaKm2, ...(sami ? { sami: sami[i]! } : {}), ...(hughes ? { hughes: hughes[i]! } : {}) }));
}

/** A MAP as the file holds it: RU L.002 is an `I5`, whole mm. */
export const roundMap = (mapMm: number) => fileRound(mapMm, 0);

/**
 * A search's result as the wizard takes it: the final MAPs rounded to whole
 * mm and the MAR recomputed with them. That run is outside the 12 of the
 * search (R5-E6). If rounding takes it past 2 % the result is `not_converged`
 * with the reason: `converged` always means within 2 % as saved (invariant 7).
 */
export function roundedResult(search: FactorSearch, targetMm3: number, marOf: (mapsMm: readonly number[]) => number, period: NaturalPeriod): CalibrationResult {
	if (search.status === 'refused' || !search.best) {
		return { status: 'refused', message: search.message ?? NO_RUNOFF, iterations: search.iterations, best: null, finalMapsMm: [], finalMarMm3: null, period };
	}
	const finalMapsMm = search.best.maps.map(roundMap);
	const finalMarMm3 = marOf(finalMapsMm);
	const roundedOut = search.status === 'converged' && Math.abs(finalMarMm3 - targetMm3) / targetMm3 > MAR_TOLERANCE;
	return {
		status: roundedOut ? 'not_converged' : search.status,
		message: roundedOut ? `rounding the MAPs to whole mm moves the natural MAR to ${finalMarMm3.toFixed(3)} Mm³/a, more than 2 % from the target` : search.message,
		iterations: search.iterations,
		best: search.best,
		finalMapsMm,
		finalMarMm3,
		period
	};
}

/**
 * The D2 loop on the real runoff modules (see `solveFactor`, `roundedResult`).
 * Maps are in the plan's piece order, then the quaternary's other pieces when
 * a piece is being split again.
 */
export const calibrateMap: CalibrateMap = (bundle, plan, target) => {
	let period: NaturalPeriod = { startYear: bundle.network.startYear, endYear: bundle.network.endYear };
	try {
		const module = plannedModule(bundle, plan);
		const siblings = siblingsOf(bundle, plan);
		const series = rainfallOf(bundle, module);
		period = naturalPeriod(bundle, module.rainfallFile, series);
		const members = [...plannedPieces(module, plan), ...siblings.map((s) => s.module)];
		const rain = members.map((m) => rainfallOf(bundle, m));
		const mapsAtOne = [...plan.pieces.map((p) => p.gridMapMm), ...siblings.map((s) => s.gridMapMm)];
		const marOf = (maps: readonly number[]) => members.reduce((sum, m, i) => sum + naturalMar({ ...m, mapMm: maps[i]! }, rain[i]!, period), 0);
		return roundedResult(solveFactor(mapsAtOne, target.marMm3, marOf), target.marMm3, marOf, period);
	} catch (error) {
		if (error instanceof SubdivisionError || error instanceof PitmanRunError) {
			return { status: 'refused', message: error.message, iterations: [], best: null, finalMapsMm: [], finalMarMm3: null, period };
		}
		throw error;
	}
};

/**
 * The module's natural MAR over the same period: the cross-check and the
 * fallback target (D2a). When the module is already a piece of a sub-division
 * the quaternary's MAR is the sum of its pieces, so this answers for all of them.
 */
export const unsplitNaturalMar: UnsplitNaturalMar = (bundle, ref) => {
	const module = ref.type === 'RU' ? findRunoff(bundle.modules, ref.number) : undefined;
	if (!module) throw new SubdivisionError(`${ref.type} ${ref.number} is not a runoff module of this network`);
	const series = rainfallOf(bundle, module);
	const period = naturalPeriod(bundle, module.rainfallFile, series);
	const quaternary = Object.values(bundle.sidecar?.subdivisions ?? {}).find((entry) => entry.pieces.some((p) => p.number === module.number));
	const members = quaternary ? quaternary.pieces.map((p) => findRunoff(bundle.modules, p.number) ?? module) : [module];
	return { marMm3: members.reduce((sum, m) => sum + naturalMar(m, rainfallOf(bundle, m), period), 0), period };
};
