/**
 * The classic Pitman runoff module (groundwater model 0): monthly catchment
 * rain in, monthly runoff volume out.
 *
 * Spec: docs/theory/pitman.md (TT 690 ch.1, pp.1–8), with the TT 690
 * errata and the OQ-1 … OQ-28 defaults accepted in docs/decisions.md.
 * §3.2 of the spec is the algorithm coded here. Every provisional choice is
 * a field of `PitmanOptions`, so the Round 2 comparison can flip it without
 * touching the code.
 *
 * `runRunoffModule` also runs Sami modules (groundwater model 2) through
 * `groundwater/sami/index.ts`, and applies injected streamflow reductions
 * (`landuse/contract.ts`); the defaults are in `runoff/wiring.ts`. Out of
 * scope here: Hughes groundwater, splitting the outflow over exit routes
 * (the network run).
 */

import type {
	HydroYear,
	Monthly12,
	MonthlySeries,
	PitmanParameters,
	RainfallSeries,
	RunMessage,
	RunMode,
	RunoffDiagnostics,
	RunoffModule,
	YearTable
} from '../types.js';
import { samiAquiferParams } from '../groundwater/sami/aquifer.js';
import {
	samiAbstractionMm,
	samiDiagnostics,
	simulateSami,
	type SamiOptionsInput,
	type SamiRunParts,
	type SamiSimulation
} from '../groundwater/sami/index.js';
import { samiSoilParams } from '../groundwater/sami/soil.js';
import type { StreamflowReduction } from '../landuse/contract.js';
import { MuskingumRouter } from './lag.js';
import { SAMI_PARTS, SAMI_PARTS_NOT_WIRED, STREAMFLOW_REDUCTIONS } from './wiring.js';
import { interceptionConstants, sCurveFractions, type SCurveSampling } from './rain.js';

/** Time steps per month, fixed at 4 (TT 690 p.1; OQ-28: a constant, not an option). */
export const NOFT = 4;

/** The ZMIN/ZMAX value that means "all rainfall is absorbed" (TT 689 Table 10.1, p.178; OQ-6). */
export const NO_SURFACE_RUNOFF_RATE = 999;

/**
 * The provisional choices of the classic module, each with its open
 * question in docs/theory/pitman.md §5. Defaults are `DEFAULT_PITMAN_OPTIONS`.
 */
export interface PitmanOptions {
	/**
	 * OQ-23: soil moisture S at the start of the run, mm. `halfST` (default,
	 * a placeholder with no manual basis), `zero`, `SL`, `ST`, or a number.
	 */
	readonly initialSoilMoisture: 'halfST' | 'zero' | 'SL' | 'ST' | number;
	/**
	 * OQ-24: starting state of both lag reservoirs. `zero` (default) or
	 * `steady` (I0 = O0 = the first interval's inflow).
	 */
	readonly initialLagState: 'zero' | 'steady';
	/** OQ-1: how the mass curve is sampled into the steps (default `cumulative`). */
	readonly sCurveSampling: SCurveSampling;
	/**
	 * OQ-3: how the month's interception is spread over the steps.
	 * `proportional` (default): i_j = I f_j. `equal`: I/4 per step, capped at
	 * the step's rain, the shortfall carried to the next step and lost at
	 * month end.
	 */
	readonly interceptionSpread: 'proportional' | 'equal';
	/**
	 * OQ-8: order within a step. `explicit` (default): Q and E from S at the
	 * start of the step, one mass balance, then SPILL. `spillBeforeQ`: add
	 * infiltration and take off E, spill above ST, then Q from the post-spill S.
	 */
	readonly stepOrder: 'explicit' | 'spillBeforeQ';
	/**
	 * OQ-12: how soil evaporation allows for intercepted water.
	 * `proportional` (default): E (1 − i/(DT PE)). `subtractive`: E − i.
	 */
	readonly evaporationAdjustment: 'proportional' | 'subtractive';
	/**
	 * OQ-20 / OQ-22: routing interval. `monthly` (default, Δt = 1 month on
	 * the monthly totals, as printed) or `perStep` (Δt = DT on each step's
	 * flows, summed per month).
	 */
	readonly routing: 'monthly' | 'perStep';
	/**
	 * OQ-25: arithmetic. `float64` (default) or `float32`, which rounds the
	 * soil moisture and the lag reservoirs' outflow state with `Math.fround`
	 * at each update (TT 691 declares them REAL).
	 */
	readonly precision: 'float64' | 'float32';
}

/** The accepted provisional defaults (docs/decisions.md). */
export const DEFAULT_PITMAN_OPTIONS: PitmanOptions = {
	initialSoilMoisture: 'halfST', // OQ-23
	initialLagState: 'zero', // OQ-24
	sCurveSampling: 'cumulative', // OQ-1
	interceptionSpread: 'proportional', // OQ-3
	stepOrder: 'explicit', // OQ-8
	evaporationAdjustment: 'proportional', // OQ-12
	routing: 'monthly', // OQ-20, OQ-22
	precision: 'float64' // OQ-25
};

/** What `runRunoffModule` returns. */
export interface RunoffModuleResult {
	/** Total module outflow, million m³ per month, before the outflow-route split (L.019–L.020). */
	readonly outflow: MonthlySeries;
	readonly diagnostics: RunoffDiagnostics;
	readonly messages: RunMessage[];
	/** The Sami run, for a Sami module (every part's monthly output, for tracing a divergence). */
	readonly sami?: SamiSimulation;
	/** The outflow before streamflow reductions, when any were applied. */
	readonly unreducedOutflow?: MonthlySeries;
	/** The applied streamflow reduction, million m³/month, when any were applied. */
	readonly reductionMm3?: MonthlySeries;
	/** "Virgin MAR" of an SFR child, million m³/a, when a reduction computed one. */
	readonly virginMarMm3?: number;
}

/** A run that cannot go ahead; `messages` holds the error(s) as run messages. */
export class PitmanRunError extends Error {
	override readonly name = 'PitmanRunError';
	readonly messages: RunMessage[];

	constructor(messages: RunMessage[]) {
		super(messages.filter((m) => m.level === 'error').map((m) => m.text).join('; '));
		this.messages = messages;
	}
}

// ---------------------------------------------------------------------------
// Component equations
// ---------------------------------------------------------------------------

/**
 * Surface runoff for rain `r` against a triangular distribution of
 * absorption rates between `ZMIN` and `ZMAX` (TT 690 pp.3–4 eqs. 1.8–1.12;
 * r, ZMIN, ZMAX in one unit, mm/month in the module, OQ-5). Eq. 1.10 is
 * coded with its missing minus restored, (r − ZMIN)³ (docs/decisions.md).
 * Case boundaries use ≤ (OQ-7; the function is continuous).
 *
 * OQ-6: ZMIN ≥ 999 and ZMAX ≥ 999 is the "all rain absorbed" sentinel and
 * gives 0; any other ZMIN = ZMAX gives the limit max(0, r − ZMIN). ZMIN >
 * ZMAX is rejected by validation, not here.
 */
export function surfaceRunoff(r: number, ZMIN: number, ZMAX: number): number {
	if (ZMIN >= NO_SURFACE_RUNOFF_RATE && ZMAX >= NO_SURFACE_RUNOFF_RATE) return 0;
	if (r <= ZMIN) return 0; // eq. 1.9
	if (ZMAX <= ZMIN) return r - ZMIN;
	const Zave = (ZMIN + ZMAX) / 2; // eq. 1.8
	const d2 = 3 * (ZMAX - ZMIN) ** 2;
	if (r <= Zave) return (2 * (r - ZMIN) ** 3) / d2; // eq. 1.10 (corrected)
	if (r <= ZMAX) return r - Zave + (2 * (ZMAX - r) ** 3) / d2; // eq. 1.11
	return r - Zave; // eq. 1.12
}

/**
 * Subsurface flow rate Q, mm/month, at soil moisture `S` mm
 * (TT 690 p.4 eq. 1.13): FT ((S − SL)/(ST − SL))^POW, zero for S ≤ SL.
 */
export function subsurfaceFlow(S: number, p: Pick<PitmanParameters, 'POW' | 'SL' | 'ST' | 'FT'>): number {
	if (S <= p.SL) return 0;
	return p.FT * ((S - p.SL) / (p.ST - p.SL)) ** p.POW;
}

/**
 * Potential evaporation per calendar month (October first), mm/month:
 * FF × S-pan × pan factor (OQ-13, OQ-14). The 12 values repeat every year.
 */
export function potentialEvaporation(sPanMm: Monthly12, panFactors: Monthly12, FF: number): number[] {
	return sPanMm.map((pan, m) => FF * pan * (panFactors[m] ?? 0));
}

/**
 * Coefficients of E = b S + c for one calendar month (TT 690 p.5 eqs.
 * 1.18, 1.19). `PE` and `PEMAX` mm/month, `ST` mm, 0 ≤ R ≤ 1 (OQ-15). A
 * month with PE ≤ 0 has no evaporation (b = c = 0).
 */
export function evaporationCoefficients(PE: number, PEMAX: number, ST: number, R: number): { readonly b: number; readonly c: number } {
	if (!(PE > 0)) return { b: 0, c: 0 };
	const d = 1 - R * (1 - PE / PEMAX);
	return { b: PE / (ST * d), c: PE - PE / d };
}

/** Soil evaporation rate, mm/month, at soil moisture `S`: max(0, b S + c) (eq. 1.17; OQ-11). */
export function evaporationRate(S: number, b: number, c: number): number {
	return Math.max(0, b * S + c);
}

/**
 * The value of a year table in hydrological year `year`: linear between
 * listed years, held flat before the first and after the last (OQ-17; the
 * land-use proposal in docs/theory/pitman.md OQ-17, and the "interpolated
 * linearly between years and held flat beyond them" rule `DemandSpec`
 * uses). An empty table is 0.
 */
export function yearTableValue(table: YearTable, year: number): number {
	const first = table[0];
	if (!first) return 0;
	if (year <= first.year) return first.value;
	for (let i = 1; i < table.length; i++) {
		const hi = table[i]!;
		if (year <= hi.year) {
			const lo = table[i - 1]!;
			if (hi.year === lo.year) return hi.value;
			return lo.value + ((hi.value - lo.value) * (year - lo.year)) / (hi.year - lo.year);
		}
	}
	return table[table.length - 1]!.value;
}

// ---------------------------------------------------------------------------
// The simulation
// ---------------------------------------------------------------------------

/** Inputs of `simulatePitman`, already resolved to numbers. */
export interface PitmanInput {
	readonly params: PitmanParameters;
	/** L.004: monthly S-pan evaporation, mm, October first. */
	readonly sPanMm: Monthly12;
	/** L.005: monthly pan factors, October first. */
	readonly panFactors: Monthly12;
	/** Catchment rain per month, mm. Index 0 is October of the first year (OQ-27). */
	readonly rainfallMm: readonly number[];
	/** Impervious fraction AI (0–1) per month, same length as `rainfallMm`; 0 when absent. */
	readonly imperviousFraction?: readonly number[];
	/**
	 * An extra loss from the soil store, as a rate in mm/month at soil
	 * moisture S, taken in each step like Q (Δt = DT). Absent (the classic
	 * module, and Sami under OQ-S2 (a)) it is 0. Sami's OQ-S2 (b) passes
	 * its recharge curve here so recharge drains Pitman S
	 * (`groundwater/sami/index.ts`). In a step that would end below 0 it is
	 * cut after E and before Q (OQ-9).
	 */
	readonly soilDrain?: (S: number) => number;
}

/** One time step's water balance, mm over the whole catchment. */
export interface PitmanStep {
	/** Rain on the pervious part, r_j. */
	readonly rain: number;
	/** Interception, i_j. */
	readonly interception: number;
	readonly surface: number;
	readonly infiltration: number;
	/** Subsurface flow, after any OQ-9 cut. */
	readonly Q: number;
	/** The `soilDrain` loss, after any OQ-9 cut; 0 without one. */
	readonly drain: number;
	/** The evaporation rate b S + c (clamped at 0), mm/month, before the interception adjustment. */
	readonly evaporationRate: number;
	/** Soil evaporation, after any OQ-9 cut. */
	readonly E: number;
	readonly spill: number;
	readonly sEnd: number;
	/** The part lagged with GL: min(Q, DT·GW) + GFRACT·SPILL. */
	readonly base: number;
	/** The part lagged with TL: surface + the rest of Q + the rest of SPILL. */
	readonly fast: number;
}

/** One month's results, mm over the whole catchment unless stated. */
export interface PitmanMonth {
	/** Catchment rain. */
	readonly P: number;
	/** Impervious-area runoff AI·P, not lagged (OQ-18). */
	readonly paved: number;
	/** Interception actually taken off (Σ i_j). */
	readonly interception: number;
	readonly surface: number;
	readonly infiltration: number;
	readonly Q: number;
	/** Σ of the steps' `soilDrain` loss; 0 without one. */
	readonly drain: number;
	readonly E: number;
	readonly spill: number;
	readonly sStart: number;
	/** Soil moisture at month end ("Pitman S"). */
	readonly sEnd: number;
	/** Un-lagged baseflow total B. */
	readonly base: number;
	/** Un-lagged fast-flow total F. */
	readonly fast: number;
	/** The subsurface (FT-term) part of F: Σ (Q − min(Q, DT·GW)). */
	readonly fastSubsurface: number;
	/** B routed with GL. */
	readonly routedBase: number;
	/** F routed with TL. */
	readonly routedFast: number;
	/**
	 * `fastSubsurface` routed alone with TL, the FT part of `routedFast`
	 * (the routing is linear, so `routedFast − routedFastSubsurface` is the
	 * lagged surface + spill part). Sami swaps it for its own interflow
	 * (docs/theory/sami.md OQ-S3).
	 */
	readonly routedFastSubsurface: number;
	/** routedBase + routedFast + paved. */
	readonly runoff: number;
	readonly steps: readonly PitmanStep[];
}

/** What `simulatePitman` returns. */
export interface PitmanSimulation {
	readonly months: PitmanMonth[];
	/** Steps in which S would have gone below 0 and E, then Q, were cut (OQ-9). */
	readonly negativeSoilMoistureSteps: number;
}

/** S at the start of the run (OQ-23). */
export function initialSoilMoisture(choice: PitmanOptions['initialSoilMoisture'], p: PitmanParameters): number {
	if (typeof choice === 'number') return choice;
	switch (choice) {
		case 'halfST':
			return p.ST / 2;
		case 'zero':
			return 0;
		case 'SL':
			return p.SL;
		case 'ST':
			return p.ST;
	}
}

/**
 * Run the classic Pitman soil-moisture model month by month
 * (docs/theory/pitman.md §3.2). Inputs are assumed valid (see
 * `validatePitmanParameters`). Depths only: the caller converts to volume.
 */
export function simulatePitman(input: PitmanInput, options: Partial<PitmanOptions> = {}): PitmanSimulation {
	const opt: PitmanOptions = { ...DEFAULT_PITMAN_OPTIONS, ...options };
	const p = input.params;
	const DT = 1 / NOFT;
	const round = opt.precision === 'float32' ? Math.fround : (x: number) => x; // OQ-25

	// Once per module (§3.2 steps 1–5).
	const PE = potentialEvaporation(input.sPanMm, input.panFactors, p.FF); // OQ-13, OQ-14
	const PEMAX = Math.max(...PE);
	const coeff = PE.map((pe) => evaporationCoefficients(pe, PEMAX, p.ST, p.R));
	const ic = interceptionConstants(p.PI);
	const gf = p.FT > 0 ? Math.min(1, p.GW / p.FT) : 0; // GFRACT, OQ-10

	const routeDt = opt.routing === 'perStep' ? DT : 1; // OQ-20
	const routerOptions = { dt: routeDt, ...(opt.precision === 'float32' ? { round: Math.fround } : {}) };
	const baseRouter = new MuskingumRouter({ k: p.GL, ...routerOptions });
	const fastRouter = new MuskingumRouter({ k: p.TL, ...routerOptions });
	// The FT part of the fast flow, routed alone (it doesn't feed back into the other two).
	const subRouter = new MuskingumRouter({ k: p.TL, ...routerOptions });
	let lagStarted = opt.initialLagState === 'zero'; // OQ-24
	const route = (base: number, fast: number, sub: number): [number, number, number] => {
		if (!lagStarted) {
			baseRouter.reset({ inflow: base, outflow: base });
			fastRouter.reset({ inflow: fast, outflow: fast });
			subRouter.reset({ inflow: sub, outflow: sub });
			lagStarted = true;
		}
		return [baseRouter.step(base), fastRouter.step(fast), subRouter.step(sub)];
	};
	const drainRate = input.soilDrain;

	let S = round(initialSoilMoisture(opt.initialSoilMoisture, p));
	let negativeSteps = 0;
	const months: PitmanMonth[] = [];

	for (let t = 0; t < input.rainfallMm.length; t++) {
		const m = t % 12;
		const pe = PE[m]!;
		const { b, c } = coeff[m]!;
		const P = input.rainfallMm[t]!;
		const AI = input.imperviousFraction?.[t] ?? 0;

		// Impervious runoff, no interception on it (OQ-17, OQ-19).
		const paved = AI * P;
		const pervious = P - paved;
		// Eq. 1.5 on the gross rain over the vegetated fraction, capped at P' (OQ-3, OQ-17).
		const I = P > 0 ? Math.min(pervious, (1 - AI) * ic.a * (1 - Math.exp(ic.b * P))) : 0;
		const f = sCurveFractions(P, NOFT, opt.sCurveSampling); // OQ-1, OQ-2

		const sStart = S;
		let carry = 0;
		let sumI = 0, sumSurf = 0, sumInf = 0, sumQ = 0, sumE = 0, sumSpill = 0, sumBase = 0, sumFast = 0, sumSub = 0, sumDrain = 0;
		let stepRoutedBase = 0, stepRoutedFast = 0, stepRoutedSub = 0;
		const steps: PitmanStep[] = [];

		for (let j = 0; j < NOFT; j++) {
			const r = pervious * f[j]!;
			let i: number;
			if (opt.interceptionSpread === 'proportional') {
				i = I * f[j]!; // OQ-3 (a)
			} else {
				const want = I / NOFT + carry; // OQ-3 (b)
				i = Math.min(r, want);
				carry = want - i;
			}
			const rn = r - i;
			const surf = DT * surfaceRunoff(rn / DT, p.ZMIN, p.ZMAX); // OQ-5
			const inf = rn - surf;

			const eRate = evaporationRate(S, b, c); // OQ-11
			let e: number;
			if (!(pe > 0)) e = 0;
			else if (opt.evaporationAdjustment === 'proportional') e = DT * eRate * Math.max(0, 1 - i / (DT * pe)); // OQ-12 (a)
			else e = Math.max(0, DT * eRate - i); // OQ-12 (b)

			let q: number;
			let d = 0;
			let spill: number;
			let sNew: number;
			if (opt.stepOrder === 'explicit') {
				// OQ-8 (a)
				q = DT * subsurfaceFlow(S, p);
				if (drainRate) d = DT * drainRate(S);
				sNew = S + inf - q - e - d;
				spill = Math.max(0, sNew - p.ST);
				sNew -= spill;
			} else {
				// OQ-8 (b)
				const s1 = S + inf - e;
				spill = Math.max(0, s1 - p.ST);
				q = DT * subsurfaceFlow(s1 - spill, p);
				if (drainRate) d = DT * drainRate(s1 - spill);
				sNew = s1 - spill - q - d;
			}
			if (sNew < 0) {
				// OQ-9: cut E first, then the soil drain (0 for the classic module), then Q, so that S ends at 0.
				negativeSteps++;
				const cutE = Math.min(e, -sNew);
				e -= cutE;
				sNew += cutE;
				if (sNew < 0 && d > 0) {
					const cutD = Math.min(d, -sNew);
					d -= cutD;
					sNew += cutD;
				}
				if (sNew < 0) {
					q += sNew;
					sNew = 0;
				}
			}
			sNew = round(sNew);

			const qb = Math.min(q, DT * p.GW);
			const base = qb + gf * spill;
			const fast = surf + (q - qb) + (1 - gf) * spill;
			if (opt.routing === 'perStep') {
				const [ob, of, os] = route(base, fast, q - qb);
				stepRoutedBase += ob;
				stepRoutedFast += of;
				stepRoutedSub += os;
			}

			steps.push({ rain: r, interception: i, surface: surf, infiltration: inf, Q: q, drain: d, evaporationRate: eRate, E: e, spill, sEnd: sNew, base, fast });
			sumI += i;
			sumSurf += surf;
			sumInf += inf;
			sumQ += q;
			sumE += e;
			sumSpill += spill;
			sumBase += base;
			sumFast += fast;
			sumSub += q - qb;
			sumDrain += d;
			S = sNew;
		}

		const [routedBase, routedFast, routedFastSubsurface] =
			opt.routing === 'perStep' ? [stepRoutedBase, stepRoutedFast, stepRoutedSub] : route(sumBase, sumFast, sumSub);
		months.push({
			P,
			paved,
			interception: sumI,
			surface: sumSurf,
			infiltration: sumInf,
			Q: sumQ,
			drain: sumDrain,
			E: sumE,
			spill: sumSpill,
			sStart,
			sEnd: S,
			base: sumBase,
			fast: sumFast,
			fastSubsurface: sumSub,
			routedBase,
			routedFast,
			routedFastSubsurface,
			runoff: routedBase + routedFast + paved, // OQ-18: paved runoff is not lagged
			steps
		});
	}
	return { months, negativeSoilMoistureSteps: negativeSteps };
}

// ---------------------------------------------------------------------------
// Validation and the module-level entry point
// ---------------------------------------------------------------------------

/**
 * Check the classic parameter set (OQ-6, OQ-15, OQ-16). Errors are values
 * the equations cannot use; warnings are values outside the documented
 * range.
 */
export function validatePitmanParameters(p: PitmanParameters): { level: 'error' | 'warning'; text: string }[] {
	const out: { level: 'error' | 'warning'; text: string }[] = [];
	const err = (text: string) => out.push({ level: 'error', text });
	for (const [name, value] of Object.entries(p)) {
		if (!Number.isFinite(value)) err(`${name} = ${value} is not a finite number`);
	}
	if (p.SL < 0) err(`SL = ${p.SL} is negative (OQ-16)`);
	if (p.ST <= p.SL) err(`ST = ${p.ST} must exceed SL = ${p.SL} (OQ-16)`);
	if (p.POW <= 0) err(`POW = ${p.POW} must be positive (OQ-16)`);
	for (const name of ['FT', 'GW', 'PI', 'TL', 'GL'] as const) {
		if (p[name] < 0) err(`${name} = ${p[name]} is negative (OQ-16)`);
	}
	if (!(p.R >= 0 && p.R <= 1)) err(`R = ${p.R} is outside 0–1 (OQ-15)`);
	if (p.ZMIN > p.ZMAX) err(`ZMIN = ${p.ZMIN} exceeds ZMAX = ${p.ZMAX} (OQ-6)`);
	if (!(p.FF > 0)) err(`FF = ${p.FF} must be positive (OQ-14)`);
	if (p.PI > 10) out.push({ level: 'warning', text: `PI = ${p.PI} mm is above the 0–10 mm range eqs. 1.6–1.7 were fitted to (TT 690 p.2; OQ-16)` });
	if (![1, 2, 3].includes(p.POW)) out.push({ level: 'warning', text: `POW = ${p.POW} is not 1, 2 or 3 (TT 689 Table 10.1; OQ-16)` });
	return out;
}


/** What `runRunoffModule` needs besides the module and its rainfall. */
export interface RunRunoffOptions {
	readonly startYear: HydroYear;
	readonly endYear: HydroYear;
	/** Pitman core options (R2-1), for classic and Sami modules alike. */
	readonly pitman?: Partial<PitmanOptions>;
	/** D1. The caller has already applied it to the module (`applyRunMode`); here it zeroes Sami abstractions and goes to the reductions. Default historical. */
	readonly mode?: RunMode;
	/** The Sami composition's switches (OQ-S2 … OQ-S11; `groundwater/sami/index.ts`). */
	readonly sami?: SamiOptionsInput;
	/** The Sami parts; default `SAMI_PARTS` (`runoff/wiring.ts`). */
	readonly samiParts?: SamiRunParts;
	/** Streamflow reductions on a free module (afforestation, alien vegetation); default `STREAMFLOW_REDUCTIONS` (`runoff/wiring.ts`). */
	readonly reductions?: readonly StreamflowReduction[];
	/** The SFR parent when this module is a child (R3-N11, OQ-S18), else `null`. Passed to the reductions. */
	readonly parent?: RunoffModule | null;
	/**
	 * Impervious fraction AI per run month, replacing the module's L.016–L.018
	 * table (R6-P1: an SFR parent's `activeAreaPavedFraction` on its reduced
	 * active area). Same length as the run.
	 */
	readonly imperviousFraction?: readonly number[];
	/**
	 * Area per run month, km², for the depth → volume conversion, replacing
	 * L.002 (an area that changes through the run, R6-P1). Same length as the run.
	 */
	readonly activeAreaKm2?: readonly number[];
}

/**
 * Rainfall and impervious fraction of a module over `startYear` …
 * `endYear`, month 0 = October (OQ-27): rain is `%MAP / 100 × MAP`
 * (TT 690 p.2), AI the paved fraction of each hydrological year (OQ-17).
 * Throws `PitmanRunError` for a missing year, a negative value or a
 * paved fraction outside 0–1 (R2-2). Exported so a land-use model can
 * re-run a module (`simulateModuleRunoff`).
 */
export function runoffModuleRainfall(
	module: RunoffModule,
	rainfall: RainfallSeries,
	startYear: HydroYear,
	endYear: HydroYear
): { readonly rainfallMm: number[]; readonly imperviousFraction: number[] } {
	const ref = { type: 'RU', number: module.number } as const;
	const fail = (text: string): never => {
		throw new PitmanRunError([{ level: 'error', module: ref, text }]);
	};
	const rows = new Map(rainfall.rows.map((row) => [row.year, row.months]));
	const rainfallMm: number[] = [];
	const imperviousFraction: number[] = [];
	for (let year = startYear; year <= endYear; year++) {
		const months = rows.get(year) ?? fail(`RU ${module.number}: rainfall ${rainfall.code} has no year ${year}`);
		const AI = module.paved ? yearTableValue(module.paved.fraction, year) : 0;
		if (!(AI >= 0 && AI <= 1)) fail(`RU ${module.number}: paved fraction ${AI} in ${year} is outside 0–1`);
		for (let m = 0; m < 12; m++) {
			const pc = months[m]!;
			if (!(pc >= 0)) fail(`RU ${module.number}: rainfall ${rainfall.code} ${year} month ${m} is ${pc} % MAP`);
			rainfallMm.push((pc / 100) * module.mapMm);
			imperviousFraction.push(AI);
		}
	}
	return { rainfallMm, imperviousFraction };
}

/** A module's runoff as depths, before any streamflow reduction. */
export interface ModuleRunoff {
	/** Total runoff per month, mm over the module's area (Qfinal for Sami). */
	readonly runoffMm: number[];
	readonly diagnostics: RunoffDiagnostics;
	/** The Pitman core run (for Sami, the L.035 run with GW = GL = 0). */
	readonly pitman: PitmanSimulation;
	/** Present for a Sami module. */
	readonly sami?: SamiSimulation;
	readonly messages: RunMessage[];
}

/**
 * The runoff of one module from resolved rainfall, classic or Sami, with
 * no validation and no reductions: the core `runRunoffModule` wraps. A
 * land-use model can call it to re-run a module with changed data (e.g. an
 * SFR child's forest factor or area). Hughes throws.
 */
export function simulateModuleRunoff(
	module: RunoffModule,
	rain: { readonly rainfallMm: readonly number[]; readonly imperviousFraction: readonly number[] },
	options: Omit<RunRunoffOptions, 'reductions' | 'parent'>
): ModuleRunoff {
	const ref = { type: 'RU', number: module.number } as const;
	const { startYear, endYear } = options;
	const messages: RunMessage[] = [];
	const areaAt = (i: number) => options.activeAreaKm2?.[i] ?? module.areaKm2;
	const toMm3 = (depthMm: number, i: number) => (depthMm * areaAt(i)) / 1000; // TT 690 p.6
	const series = (values: number[], unit: MonthlySeries['unit']): MonthlySeries => ({ startYear, values, unit });
	const gwModel = module.groundwaterModel ?? 0;
	// R6-V10: evaporation for the riparian alien-vegetation deduction. PE = FF·S-pan·pan factor of the active set.
	const evaporation = (pitman: PitmanSimulation, FF: number): Pick<RunoffDiagnostics, 'actualEvaporationMm' | 'potentialEvaporationMm'> => {
		const pe = potentialEvaporation(module.sPanMm, module.panFactors, FF);
		return {
			actualEvaporationMm: series(pitman.months.map((mo) => mo.E + mo.interception), 'mm'),
			potentialEvaporationMm: series(pitman.months.map((_, t) => pe[t % 12]!), 'mm')
		};
	};

	if (gwModel === 0) {
		const pitman = simulatePitman(
			{ params: module.pitman, sPanMm: module.sPanMm, panFactors: module.panFactors, rainfallMm: rain.rainfallMm, imperviousFraction: rain.imperviousFraction },
			options.pitman
		);
		const runoffMm = pitman.months.map((mo) => mo.runoff);
		const outflow = series(runoffMm.map(toMm3), 'Mm3');
		return {
			runoffMm,
			pitman,
			messages,
			diagnostics: {
				// Classic GW: "total surface runoff" = net catchment runoff, groundwater outflow zero (TT 689 pp.120–121).
				netRunoff: outflow,
				surfaceRunoff: outflow,
				groundwaterOutflow: series(pitman.months.map(() => 0), 'Mm3'),
				pavedFlow: series(pitman.months.map((mo, i) => toMm3(mo.paved, i)), 'Mm3'),
				soilMoistureMm: series(pitman.months.map((mo) => mo.sEnd), 'mm'),
				...evaporation(pitman, module.pitman.FF)
			}
		};
	}
	if (gwModel !== 2) {
		throw new PitmanRunError([{ level: 'error', module: ref, text: `RU ${module.number}: groundwater model ${gwModel} (Hughes) is not supported yet (Round 6 implements Sami)` }]);
	}

	const parts = options.samiParts ?? SAMI_PARTS;
	if (parts === SAMI_PARTS_NOT_WIRED) {
		throw new PitmanRunError([{ level: 'error', module: ref, text: `RU ${module.number}: groundwater model 2 (Sami) parts are not wired yet (src/runoff/wiring.ts)` }]);
	}
	const sami = module.sami!; // checked by runRunoffModule
	const natural = options.mode?.kind === 'natural';
	let abstractionMm = natural ? new Array<number>(rain.rainfallMm.length).fill(0) : samiAbstractionMm(module, startYear, endYear, options.sami);
	if (abstractionMm === null) {
		messages.push({ level: 'warning', module: ref, text: `RU ${module.number}: Sami abstractions from a time-series file (AbstractionsOn = 2) are not read yet; none applied (OQ-S9, R3-N9)` });
		abstractionMm = new Array<number>(rain.rainfallMm.length).fill(0);
	}
	let aPan = module.aPanFactors;
	if (!aPan) {
		messages.push({ level: 'warning', module: ref, text: `RU ${module.number}: no A-pan factors (L.040); groundwater PET uses the L.005 pan factors (OQ-S7)` });
		aPan = module.panFactors;
	}
	const petGwMm = module.sPanMm.map((e, m) => e * aPan[m]!) as unknown as Monthly12; // OQ-S7: E_m × APF_m

	let sim: SamiSimulation;
	try {
		sim = simulateSami(
			{
				pitman: { params: sami.pitman, sPanMm: module.sPanMm, panFactors: module.panFactors, rainfallMm: rain.rainfallMm, imperviousFraction: rain.imperviousFraction },
				soil: samiSoilParams(module),
				aquifer: samiAquiferParams(module),
				petGwMm,
				abstractionMm
			},
			parts,
			options.sami,
			options.pitman
		);
	} catch (error) {
		if (error instanceof PitmanRunError) throw error;
		// R2-2: a part's RangeError (invalid parameter, R6-S1/S2) or contract break, with the module named.
		throw new PitmanRunError([{ level: 'error', module: ref, text: `RU ${module.number}: Sami: ${error instanceof Error ? error.message : String(error)}` }]);
	}
	if (sim.negativeRunoffMonths > 0) {
		messages.push({
			level: 'warning',
			module: ref,
			text: `RU ${module.number}: Sami runoff is negative in ${sim.negativeRunoffMonths} month(s): transmission loss exceeded surface runoff + interflow + baseflow (OQ-S3); ${sim.options.negativeRunoff === 'clamp' ? 'raised to 0' : 'kept'} (R6-R3)`
		});
	}
	return { runoffMm: sim.months.map((m) => m.runoff), pitman: sim.pitman, sami: sim, messages, diagnostics: { ...samiDiagnostics(sim, options.activeAreaKm2 ?? module.areaKm2, startYear), ...evaporation(sim.pitman, sami.pitman.FF) } };
}

/**
 * Run one runoff module for hydrological years `startYear` … `endYear`
 * inclusive: the classic Pitman model (groundwater model 0) or Sami (2,
 * `groundwater/sami/index.ts`, with the L.035 set and GW = GL = 0). Hughes
 * (1) throws.
 *
 * Rain in mm is `%MAP / 100 × MAP` (TT 690 p.2), month 0 = October
 * (OQ-27). Paved area enters as the impervious fraction AI of each
 * hydrological year (OQ-17 … OQ-19). Streamflow reductions on a free module
 * (afforestation, alien vegetation) are `reductions` (default
 * `STREAMFLOW_REDUCTIONS`, `runoff/wiring.ts`). SFR children are not run
 * here: `runNetwork` runs a parent with its children (`landuse/sfr.ts`). Invalid
 * parameters, a Sami part's invalid-parameter error, or Sami parts not
 * wired throw a `PitmanRunError` carrying the error messages (R2-2).
 */
export function runRunoffModule(module: RunoffModule, rainfall: RainfallSeries, options: RunRunoffOptions): RunoffModuleResult {
	const ref = { type: 'RU', number: module.number } as const;
	const messages: RunMessage[] = [];
	const fail = (text: string): never => {
		messages.push({ level: 'error', module: ref, text });
		throw new PitmanRunError(messages);
	};

	const gwModel = module.groundwaterModel ?? 0;
	if (gwModel === 1) fail(`RU ${module.number}: groundwater model 1 (Hughes) is not supported yet (Round 6 implements Sami)`);
	if (gwModel === 2 && !module.sami) fail(`RU ${module.number}: groundwater model 2 (Sami) but no Sami parameters (L.031–L.037)`);
	const pitmanSet = gwModel === 2 ? module.sami!.pitman : module.pitman; // TT 689 p.38 §6.1.7.1: one calibration set per GW model

	for (const v of validatePitmanParameters(pitmanSet)) messages.push({ ...v, module: ref, text: `RU ${module.number}: ${v.text}` });
	if (!(module.areaKm2 > 0)) messages.push({ level: 'error', module: ref, text: `RU ${module.number}: area ${module.areaKm2} km² must be positive (OQ-16)` });
	if (!(module.mapMm > 0)) messages.push({ level: 'error', module: ref, text: `RU ${module.number}: MAP ${module.mapMm} mm must be positive (OQ-16)` });
	if (messages.some((m) => m.level === 'error')) throw new PitmanRunError(messages);

	const reductions = options.reductions ?? STREAMFLOW_REDUCTIONS;
	if (module.sfrChildren && module.sfrChildren.length > 0) {
		messages.push({ level: 'warning', module: ref, text: `RU ${module.number}: SFR children are run with their parent by the network runner (runNetwork, landuse/sfr.ts); ignored here` });
	}

	const { startYear, endYear } = options;
	if (!(Number.isInteger(startYear) && Number.isInteger(endYear) && endYear >= startYear)) {
		fail(`RU ${module.number}: bad run period ${startYear}–${endYear}`);
	}
	let rain: ReturnType<typeof runoffModuleRainfall>;
	try {
		rain = runoffModuleRainfall(module, rainfall, startYear, endYear);
		for (const [name, series] of [['imperviousFraction', options.imperviousFraction], ['activeAreaKm2', options.activeAreaKm2]] as const) {
			if (series && series.length !== rain.rainfallMm.length) fail(`RU ${module.number}: ${name} has ${series.length} months; the run has ${rain.rainfallMm.length}`);
		}
		if (options.imperviousFraction) {
			options.imperviousFraction.forEach((ai, i) => {
				if (!(ai >= 0 && ai <= 1)) fail(`RU ${module.number}: impervious fraction ${ai} in month ${i} is outside 0–1`);
			});
			rain = { ...rain, imperviousFraction: [...options.imperviousFraction] };
		}
	} catch (error) {
		if (error instanceof PitmanRunError) throw new PitmanRunError([...messages, ...error.messages]);
		throw error;
	}

	let result: ModuleRunoff;
	try {
		result = simulateModuleRunoff(module, rain, options);
	} catch (error) {
		if (error instanceof PitmanRunError) throw new PitmanRunError([...messages, ...error.messages]);
		throw error;
	}
	messages.push(...result.messages);
	if (result.pitman.negativeSoilMoistureSteps > 0) {
		messages.push({
			level: 'warning',
			module: ref,
			text: `RU ${module.number}: soil moisture would have gone negative in ${result.pitman.negativeSoilMoistureSteps} time step(s); evaporation, then subsurface flow, was reduced (OQ-9)`
		});
	}

	const toMm3 = (depthMm: number, i: number) => (depthMm * (options.activeAreaKm2?.[i] ?? module.areaKm2)) / 1000; // TT 690 p.6
	const unreduced: MonthlySeries = { startYear, values: result.runoffMm.map(toMm3), unit: 'Mm3' };
	if (reductions.length === 0) {
		return { outflow: unreduced, diagnostics: result.diagnostics, messages, ...(result.sami ? { sami: result.sami } : {}) };
	}

	// Streamflow reductions (landuse/contract.ts), each on the unreduced runoff; their sum is capped at it (R6-R4).
	const mode = options.mode ?? { kind: 'historical' };
	const n = unreduced.values.length;
	const reduction = new Array<number>(n).fill(0);
	let virginMarMm3: number | undefined;
	for (const reduce of reductions) {
		// `evaporation` is beyond the contract's ReductionInput: alien vegetation's riparian deduction reads it (R6-V10); others ignore it.
		const reductionInput = {
			module,
			parent: options.parent ?? null,
			mode,
			startYear,
			endYear,
			unreducedRunoffMm3: unreduced,
			rainfallMm: rain.rainfallMm,
			evaporation: { potentialMm: result.diagnostics.potentialEvaporationMm!.values, actualMm: result.diagnostics.actualEvaporationMm!.values }
		};
		const out = reduce(reductionInput);
		messages.push(...out.messages.map((m) => (m.module ? m : { ...m, module: ref })));
		if (out.reductionMm3.values.length !== n) fail(`RU ${module.number}: a streamflow reduction returned ${out.reductionMm3.values.length} months; the run has ${n}`);
		out.reductionMm3.values.forEach((v, i) => {
			if (!(v >= 0) || !Number.isFinite(v)) fail(`RU ${module.number}: a streamflow reduction returned ${v} in month ${i}; it must be finite and ≥ 0`);
			reduction[i]! += v;
		});
		if (out.virginMarMm3 !== undefined) virginMarMm3 = out.virginMarMm3;
	}
	let capped = 0;
	const reduced = unreduced.values.map((q, i) => {
		const r = Math.min(reduction[i]!, Math.max(0, q));
		if (r < reduction[i]!) capped++;
		reduction[i] = r;
		return q - r;
	});
	if (capped > 0) messages.push({ level: 'warning', module: ref, text: `RU ${module.number}: streamflow reductions exceeded the runoff in ${capped} month(s); capped at the runoff (R6-R4)` });
	const outflow: MonthlySeries = { startYear, values: reduced, unit: 'Mm3' };
	return {
		outflow,
		diagnostics: { ...result.diagnostics, netRunoff: outflow },
		messages,
		unreducedOutflow: unreduced,
		reductionMm3: { startYear, values: reduction, unit: 'Mm3' },
		...(virginMarMm3 !== undefined ? { virginMarMm3 } : {}),
		...(result.sami ? { sami: result.sami } : {})
	};
}
