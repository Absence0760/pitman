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
 * Out of scope here (spec §7): Hughes and Sami groundwater (Round 6),
 * afforestation, alien vegetation and SFR children (a later land-use
 * round), splitting the outflow over exit routes (the network run).
 */

import type {
	HydroYear,
	Monthly12,
	MonthlySeries,
	PitmanParameters,
	RainfallSeries,
	RunMessage,
	RunoffDiagnostics,
	RunoffModule,
	YearTable
} from '../types.js';
import { MuskingumRouter } from './lag.js';
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
	readonly E: number;
	readonly spill: number;
	readonly sStart: number;
	/** Soil moisture at month end ("Pitman S"). */
	readonly sEnd: number;
	/** Un-lagged baseflow total B. */
	readonly base: number;
	/** Un-lagged fast-flow total F. */
	readonly fast: number;
	/** B routed with GL. */
	readonly routedBase: number;
	/** F routed with TL. */
	readonly routedFast: number;
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
	let lagStarted = opt.initialLagState === 'zero'; // OQ-24
	const route = (base: number, fast: number): [number, number] => {
		if (!lagStarted) {
			baseRouter.reset({ inflow: base, outflow: base });
			fastRouter.reset({ inflow: fast, outflow: fast });
			lagStarted = true;
		}
		return [baseRouter.step(base), fastRouter.step(fast)];
	};

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
		let sumI = 0, sumSurf = 0, sumInf = 0, sumQ = 0, sumE = 0, sumSpill = 0, sumBase = 0, sumFast = 0;
		let stepRoutedBase = 0, stepRoutedFast = 0;
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
			let spill: number;
			let sNew: number;
			if (opt.stepOrder === 'explicit') {
				// OQ-8 (a)
				q = DT * subsurfaceFlow(S, p);
				sNew = S + inf - q - e;
				spill = Math.max(0, sNew - p.ST);
				sNew -= spill;
			} else {
				// OQ-8 (b)
				const s1 = S + inf - e;
				spill = Math.max(0, s1 - p.ST);
				q = DT * subsurfaceFlow(s1 - spill, p);
				sNew = s1 - spill - q;
			}
			if (sNew < 0) {
				// OQ-9: cut E first, then Q, so that S ends at 0.
				negativeSteps++;
				const cutE = Math.min(e, -sNew);
				e -= cutE;
				sNew += cutE;
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
				const [ob, of] = route(base, fast);
				stepRoutedBase += ob;
				stepRoutedFast += of;
			}

			steps.push({ rain: r, interception: i, surface: surf, infiltration: inf, Q: q, evaporationRate: eRate, E: e, spill, sEnd: sNew, base, fast });
			sumI += i;
			sumSurf += surf;
			sumInf += inf;
			sumQ += q;
			sumE += e;
			sumSpill += spill;
			sumBase += base;
			sumFast += fast;
			S = sNew;
		}

		const [routedBase, routedFast] = opt.routing === 'perStep' ? [stepRoutedBase, stepRoutedFast] : route(sumBase, sumFast);
		months.push({
			P,
			paved,
			interception: sumI,
			surface: sumSurf,
			infiltration: sumInf,
			Q: sumQ,
			E: sumE,
			spill: sumSpill,
			sStart,
			sEnd: S,
			base: sumBase,
			fast: sumFast,
			routedBase,
			routedFast,
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

/**
 * Run one runoff module on the classic Pitman model for hydrological years
 * `startYear` … `endYear` inclusive.
 *
 * Rain in mm is `%MAP / 100 × MAP` (TT 690 p.2), month 0 = October
 * (OQ-27). Paved area enters as the impervious fraction AI of each
 * hydrological year (OQ-17 … OQ-19). Afforestation, alien vegetation and
 * SFR children are not modelled yet: a warning is added and they are
 * ignored. Hughes and Sami modules throw (Round 6). Invalid parameters
 * throw a `PitmanRunError` carrying the error messages.
 */
export function runRunoffModule(
	module: RunoffModule,
	rainfall: RainfallSeries,
	options: { readonly startYear: HydroYear; readonly endYear: HydroYear; readonly pitman?: Partial<PitmanOptions> }
): RunoffModuleResult {
	const ref = { type: 'RU', number: module.number } as const;
	const messages: RunMessage[] = [];
	const fail = (text: string): never => {
		messages.push({ level: 'error', module: ref, text });
		throw new PitmanRunError(messages);
	};

	const gwModel = module.groundwaterModel ?? 0;
	if (gwModel !== 0) {
		fail(`RU ${module.number}: groundwater model ${gwModel} (${gwModel === 1 ? 'Hughes' : 'Sami'}) is not supported yet: Sami/Hughes arrive in Round 6`);
	}

	for (const v of validatePitmanParameters(module.pitman)) messages.push({ ...v, module: ref, text: `RU ${module.number}: ${v.text}` });
	if (!(module.areaKm2 > 0)) messages.push({ level: 'error', module: ref, text: `RU ${module.number}: area ${module.areaKm2} km² must be positive (OQ-16)` });
	if (!(module.mapMm > 0)) messages.push({ level: 'error', module: ref, text: `RU ${module.number}: MAP ${module.mapMm} mm must be positive (OQ-16)` });
	if (messages.some((m) => m.level === 'error')) throw new PitmanRunError(messages);

	const ignored: string[] = [];
	if (module.afforestation.areaKm2.length > 0) ignored.push('afforestation');
	if (module.alienVegetation && module.alienVegetation.areaKm2.length > 0) ignored.push('alien vegetation');
	if (module.sfrChildren && module.sfrChildren.length > 0) ignored.push('SFR children');
	if (ignored.length > 0) {
		messages.push({ level: 'warning', module: ref, text: `RU ${module.number}: ${ignored.join(', ')} not modelled yet (land-use round); ignored` });
	}

	const { startYear, endYear } = options;
	if (!(Number.isInteger(startYear) && Number.isInteger(endYear) && endYear >= startYear)) {
		fail(`RU ${module.number}: bad run period ${startYear}–${endYear}`);
	}
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

	const sim = simulatePitman(
		{ params: module.pitman, sPanMm: module.sPanMm, panFactors: module.panFactors, rainfallMm, imperviousFraction },
		options.pitman
	);
	if (sim.negativeSoilMoistureSteps > 0) {
		messages.push({
			level: 'warning',
			module: ref,
			text: `RU ${module.number}: soil moisture would have gone negative in ${sim.negativeSoilMoistureSteps} time step(s); evaporation, then subsurface flow, was reduced (OQ-9)`
		});
	}

	const toMm3 = (depthMm: number) => (depthMm * module.areaKm2) / 1000; // TT 690 p.6
	const series = (values: number[], unit: MonthlySeries['unit']): MonthlySeries => ({ startYear, values, unit });
	const outflow = series(sim.months.map((mo) => toMm3(mo.runoff)), 'Mm3');
	return {
		outflow,
		diagnostics: {
			// Classic GW: "total surface runoff" = net catchment runoff, groundwater outflow zero (TT 689 pp.120–121).
			netRunoff: outflow,
			surfaceRunoff: outflow,
			groundwaterOutflow: series(sim.months.map(() => 0), 'Mm3'),
			pavedFlow: series(sim.months.map((mo) => toMm3(mo.paved)), 'Mm3'),
			soilMoistureMm: series(sim.months.map((mo) => mo.sEnd), 'mm')
		},
		messages
	};
}
