/**
 * The Sami runoff module (WRSM2000 groundwater model 2): the composition of
 * the Pitman core with the Sami soil side (`soil.ts`, agent 6.1) and the
 * aquifer side (`aquifer.ts`, agent 6.2). Spec: docs/theory/sami.md §1
 * (what Sami replaces), §3.12 (outputs), §4 (order of operations), §6
 * (interface) and OQ-S2/OQ-S3 (how final runoff is assembled).
 *
 * Order (§4.1):
 *   1. Pitman core over the whole record with the L.035 set and GW = GL = 0
 *      (TT 691 p.123 §11.2; TT 689 p.38–39), giving S_i, Q_i and the surface
 *      part of Q_i.
 *   2–3. `soilPass(S)`: passes 1 and 2 (RE, REbar, the percolating store, PERCbar).
 *   4. `aquiferInit`, then `aquiferStep` month by month (pass 3), then
 *      `interflow(SIF, AQX, F28_Lag)`.
 *   5. Qfinal (§3.12; OQ-S3).
 *
 * The parts are injected (`SamiParts`, `contract.ts`) so this file has no
 * dependency on their implementations; `runoff/wiring.ts` holds the
 * defaults the runner uses. Every reading of OQ-S2/OQ-S3/OQ-S4 the spec
 * lists is a field of `SamiOptions`, so the reference comparison can pick
 * the winner without touching code.
 */

import { DEFAULT_PITMAN_OPTIONS, simulatePitman, yearTableValue, type PitmanInput, type PitmanOptions, type PitmanSimulation } from '../../runoff/pitman.js';
import type { HydroYear, Monthly12, MonthlySeries, RunoffDiagnostics, RunoffModule } from '../../types.js';
import { DEFAULT_SAMI_AQUIFER_OPTIONS, type SamiAquiferOptions } from './aquifer.js';
import type {
	Mm,
	SamiAquiferInitFn,
	SamiAquiferInput,
	SamiAquiferOutput,
	SamiAquiferParams,
	SamiAquiferState,
	SamiAquiferStepFn,
	SamiSoilParams,
	SamiSoilPass
} from './contract.js';
import { DEFAULT_SAMI_INTERFLOW_OPTIONS, DEFAULT_SAMI_SOIL_OPTIONS, samiRecharge, type SamiInterflowOptions, type SamiSoilOptions } from './soil.js';

/**
 * The parts as this composition calls them: the contract's `SamiParts`
 * with the soil side's optional options argument (`soil.ts`), plus an
 * optional factory for an aquifer step with `SamiAquiferOptions`
 * (`makeSamiAquiferStep`, `aquifer.ts`). When `makeAquiferStep` is given
 * it is used with `SamiOptions.aquifer` and `aquiferStep` is not called.
 * Any `SamiParts` (a fake that ignores options included) is assignable.
 */
export interface SamiRunParts {
	/**
	 * `recharge`, when given, is RE per month already taken out of S by the
	 * Pitman core (OQ-S2 (b)); the pass uses it instead of RE(S) so the water
	 * drained from S is the water that reaches the percolating store.
	 */
	readonly soilPass: (S: readonly Mm[], p: SamiSoilParams, options?: SamiSoilOptions, recharge?: readonly Mm[]) => SamiSoilPass;
	readonly interflow: (soilInterflow: readonly Mm[], excessToInterflow: readonly Mm[], lag: number, options?: SamiInterflowOptions) => Mm[];
	readonly aquiferInit: SamiAquiferInitFn;
	readonly aquiferStep: SamiAquiferStepFn;
	readonly makeAquiferStep?: (options: SamiAquiferOptions) => SamiAquiferStepFn;
}

/** The provisional choices of the composition, each with its open question in docs/theory/sami.md §8. */
export interface SamiOptions {
	/**
	 * OQ-S3, Qfinal. `totalOrBaseflow` (reading (c), default, R6-R10):
	 * max(Pitman total Q, GWBF_net) − TL. The baseflow is a part of Q, not
	 * added to it (TT 687 p.5 Fig 1 "Surface Runoff = Q − GWBaseflow −
	 * Interflow − TL"): it shows only when it exceeds Q, in dry months. The
	 * baseflow the stream doesn't show still leaves the aquifer, and
	 * Sami's interflow (SIF + AQX) partitions Q without adding to it.
	 * `surfacePlusSami` (reading (a), R6-R0 … R6-R9): Qsurface + QLAG +
	 * GWBF_net − TL, the Pitman FT term replaced by Sami's interflow.
	 * `totalPlusBaseflow` (reading (b)): Pitman total Q + GWBF_net − TL
	 * (Sami's interflow unused, the aquifer excess lost).
	 */
	readonly finalRunoff: 'totalOrBaseflow' | 'surfacePlusSami' | 'totalPlusBaseflow';
	/**
	 * OQ-S3, the runoff in HEAD = STORE − SWL − Q (eq. 8.9) and the TL cap.
	 * `total` (reading (i), default): Pitman total Q. `surface` (reading
	 * (ii)): its surface part.
	 */
	readonly headRunoff: 'total' | 'surface';
	/**
	 * OQ-S3, "with Q and the surface component both lagged by TL as the
	 * Pitman core produces them". `lagged` (default) or `unlagged` (the
	 * monthly totals before the TL lag; paved runoff is never lagged, OQ-18).
	 */
	readonly pitmanParts: 'lagged' | 'unlagged';
	/**
	 * OQ-S2. `none` (reading (a), default): Sami is a post-process and never
	 * alters S. `rechargeDrainsS` (reading (b)): the recharge curve RE(S)
	 * (§3.2) is taken out of S inside the Pitman steps, like Q.
	 */
	readonly soilFeedback: 'none' | 'rechargeDrainsS';
	/**
	 * OQ-S4, the S per month Sami reads. `monthEnd` (default, the saved
	 * "Pitman S") or `stepMean` (the mean of the four sub-step end values).
	 */
	readonly soilMoisture: 'monthEnd' | 'stepMean';
	/** The soil side's switches (OQ-S5, S6, S8; `soil.ts`). */
	readonly soil: SamiSoilOptions;
	/** The interflow lag's switches (OQ-S17; `soil.ts`). */
	readonly interflow: SamiInterflowOptions;
	/** The aquifer step's switches (R6-A1, R6-A2, OQ-S14; `aquifer.ts`), used through `SamiRunParts.makeAquiferStep`. */
	readonly aquifer: SamiAquiferOptions;
	/**
	 * R6-R3: a month whose transmission loss exceeds surface runoff +
	 * interflow + net baseflow (TL is capped at the HEAD runoff, not at
	 * what Qfinal has) gives Qfinal < 0. `keep` (default): kept as is and
	 * counted in a warning. `clamp`: raised to 0, the water added recorded
	 * per month (`SamiMonth.clampedMm`) and in the balance.
	 */
	readonly negativeRunoff: 'keep' | 'clamp';
	/** OQ-S11: outflow width W = factor × √AREA (default 4). */
	readonly outflowWidthFactor: number;
	/** OQ-S11 / eq. 8.14: days per month (default 30). */
	readonly daysPerMonth: number;
	/** GWMAX, maximum % of abstraction from storage (fixed at 100 in WRSM2000, §2.1). */
	readonly gwMax: number;
	/**
	 * OQ-S9 / TT 691 p.145: when the L.036–L.037 annual abstractions apply.
	 * `whenTablePresent` (default): whenever the table has entries, whatever
	 * the AbstractionsOn flag, as the old program acted on the L.036 count.
	 * `whenFlagOn`: only with AbstractionsOn = 1.
	 */
	readonly abstractions: 'whenTablePresent' | 'whenFlagOn';
}

/** The accepted provisional defaults (docs/theory/sami.md §8; docs/decisions.md). */
export const DEFAULT_SAMI_OPTIONS: SamiOptions = {
	finalRunoff: 'totalOrBaseflow', // OQ-S3 (c), R6-R10 (was (a))
	headRunoff: 'total', // OQ-S3 (i)
	pitmanParts: 'lagged', // OQ-S3
	soilFeedback: 'none', // OQ-S2 (a)
	soilMoisture: 'monthEnd', // OQ-S4
	soil: DEFAULT_SAMI_SOIL_OPTIONS, // OQ-S5, S6, S8
	interflow: DEFAULT_SAMI_INTERFLOW_OPTIONS, // OQ-S17
	aquifer: DEFAULT_SAMI_AQUIFER_OPTIONS, // R6-A1, R6-A2, OQ-S14
	negativeRunoff: 'keep', // R6-R3
	outflowWidthFactor: 4, // OQ-S11
	daysPerMonth: 30, // OQ-S11
	gwMax: 100, // §2.1
	abstractions: 'whenTablePresent' // OQ-S9
};

/** Caller-facing options: any field may be left out, and the nested soil/interflow ones partly. */
export type SamiOptionsInput = Partial<Omit<SamiOptions, 'soil' | 'interflow' | 'aquifer'>> & {
	readonly soil?: Partial<SamiSoilOptions>;
	readonly interflow?: Partial<SamiInterflowOptions>;
	readonly aquifer?: Partial<SamiAquiferOptions>;
};

/** Fill `options` with the defaults. */
export function resolveSamiOptions(options: SamiOptionsInput = {}): SamiOptions {
	return {
		...DEFAULT_SAMI_OPTIONS,
		...options,
		soil: { ...DEFAULT_SAMI_OPTIONS.soil, ...options.soil },
		interflow: { ...DEFAULT_SAMI_OPTIONS.interflow, ...options.interflow },
		aquifer: { ...DEFAULT_SAMI_OPTIONS.aquifer, ...options.aquifer }
	};
}

/** Inputs of `simulateSami`, already resolved to numbers. */
export interface SamiInput {
	/**
	 * The Pitman core's input with the **L.035** set. `simulateSami` forces
	 * GW = GL = 0 (§1) and sets `soilDrain` itself (OQ-S2).
	 */
	readonly pitman: PitmanInput;
	readonly soil: SamiSoilParams;
	/** With `areaKm2` (`samiAquiferParams` in `aquifer.ts` builds it from a module). The OQ-S11 constants and GWMAX are replaced by `SamiOptions`'. */
	readonly aquifer: SamiAquiferParams;
	/** Groundwater PET per calendar month (October first), mm: E_m × APF_m (OQ-S7). */
	readonly petGwMm: Monthly12;
	/** Abstraction ABS_i per run month, mm over the area; 0 in natural mode. Absent = none. */
	readonly abstractionMm?: readonly number[];
}

/** One month of a Sami run, mm over the catchment. */
export interface SamiMonth {
	/** The S Sami read (OQ-S4). */
	readonly S: Mm;
	/** Pitman total runoff as Sami sees it (lagged or not, OQ-S3), including paved runoff. */
	readonly pitmanTotal: Mm;
	/** Its surface part: the FT (subsurface) term excluded. */
	readonly surface: Mm;
	/** The aquifer step's input. */
	readonly aquiferInput: SamiAquiferInput;
	readonly aquifer: SamiAquiferOutput;
	/** QLAG_i, lagged interflow. */
	readonly interflow: Mm;
	/** Qfinal_i (OQ-S3). Negative when TL exceeds what the month has, unless clamped (R6-R3). */
	readonly runoff: Mm;
	/** Water added to raise a negative Qfinal to 0 under `negativeRunoff: 'clamp'`; else 0. */
	readonly clampedMm: Mm;
}

/** What `simulateSami` returns. */
export interface SamiSimulation {
	readonly options: SamiOptions;
	readonly pitman: PitmanSimulation;
	readonly soil: SamiSoilPass;
	readonly initialAquifer: SamiAquiferState;
	readonly months: readonly SamiMonth[];
	/** Months whose Qfinal came out < 0 (TL larger than the month's surface + interflow + baseflow), clamped or not (R6-R3). */
	readonly negativeRunoffMonths: number;
}

/** A part broke the contract (wrong series length, non-finite value). Converted to a `PitmanRunError` by the runner. */
export class SamiPartError extends Error {
	override readonly name = 'SamiPartError';
}

function checkLength(what: string, values: readonly unknown[], n: number): void {
	if (values.length !== n) throw new SamiPartError(`Sami ${what} returned ${values.length} months; the run has ${n}`);
}

/**
 * Run a Sami module: the composition of docs/theory/sami.md §4. Depths
 * only; the caller converts to volume. Parts are called in this order:
 * `soilPass` once, `aquiferInit` once, `aquiferStep` once per month in
 * month order, `interflow` once.
 */
export function simulateSami(
	input: SamiInput,
	parts: SamiRunParts,
	options: SamiOptionsInput = {},
	pitmanOptions: Partial<PitmanOptions> = {}
): SamiSimulation {
	const opt = resolveSamiOptions(options);
	const n = input.pitman.rainfallMm.length;

	// 1. Pitman core, L.035 set, GW = GL = 0 (§1; TT 691 p.123).
	const params = { ...input.pitman.params, GW: 0, GL: 0 };
	const soilDrain =
		opt.soilFeedback === 'rechargeDrainsS' ? (S: number) => samiRecharge(S, input.soil, opt.soil) : undefined; // OQ-S2 (b)
	const pitman = simulatePitman({ ...input.pitman, params, ...(soilDrain ? { soilDrain } : {}) }, { ...DEFAULT_PITMAN_OPTIONS, ...pitmanOptions });

	const S = pitman.months.map((mo) =>
		opt.soilMoisture === 'monthEnd' ? mo.sEnd : mo.steps.reduce((a, s) => a + s.sEnd, 0) / mo.steps.length
	); // OQ-S4
	// GW = 0, so the base flow B is 0 and all of Q is in the fast flow's FT part.
	const pitmanTotal = pitman.months.map((mo) =>
		opt.pitmanParts === 'lagged' ? mo.runoff : mo.paved + mo.base + mo.fast
	);
	const surface = pitman.months.map((mo, i) =>
		pitmanTotal[i]! - (opt.pitmanParts === 'lagged' ? mo.routedFastSubsurface : mo.fastSubsurface)
	);

	// 2–3. Soil passes 1 and 2. Under OQ-S2 (b) RE is what the core drained from S, not RE(month-end S).
	const drained = soilDrain ? pitman.months.map((mo) => mo.drain) : undefined;
	const soil = drained ? parts.soilPass(S, input.soil, opt.soil, drained) : parts.soilPass(S, input.soil, opt.soil);
	for (const key of ['re', 'soilInterflow', 'perc', 'exrech'] as const) checkLength(`soilPass ${key}`, soil[key], n);
	if (drained) {
		const out = total(drained);
		const into = total(soil.re);
		if (Math.abs(out - into) > 1e-9 * Math.max(1, out)) throw new SamiPartError(`Sami soilPass recharge ${into} mm differs from the ${out} mm drained from S (OQ-S2 (b))`);
	}

	// 4. Pass 3: the aquifer, month by month (§4.2).
	const aquiferParams: SamiAquiferParams = {
		...input.aquifer,
		outflowWidthFactor: opt.outflowWidthFactor,
		daysPerMonth: opt.daysPerMonth,
		GWMAX: opt.gwMax
	};
	const aquiferStep = parts.makeAquiferStep ? parts.makeAquiferStep(opt.aquifer) : parts.aquiferStep;
	const initialAquifer = parts.aquiferInit(aquiferParams);
	let state = initialAquifer;
	const inputs: SamiAquiferInput[] = [];
	const outputs: SamiAquiferOutput[] = [];
	for (let i = 0; i < n; i++) {
		const aquiferInput: SamiAquiferInput = {
			aquiferInflow: soil.perc[i]! + soil.exrech[i]!,
			perc: soil.perc[i]!,
			percBar: soil.percBar,
			runoffForHead: opt.headRunoff === 'total' ? pitmanTotal[i]! : surface[i]!, // OQ-S3 (i)/(ii)
			rain: input.pitman.rainfallMm[i]!,
			petGw: input.petGwMm[i % 12]!,
			abstraction: input.abstractionMm?.[i] ?? 0
		};
		const step = aquiferStep(state, aquiferInput, aquiferParams);
		state = step.state;
		inputs.push(aquiferInput);
		outputs.push(step.out);
	}

	// Interflow: SIF + AQX, lagged by F28_Lag (§3.7).
	const qlag = parts.interflow(
		soil.soilInterflow,
		outputs.map((o) => o.excessToInterflow),
		input.soil.lag,
		opt.interflow
	);
	checkLength('interflow', qlag, n);

	// 5. Qfinal (§3.12; OQ-S3).
	let negative = 0;
	const months: SamiMonth[] = outputs.map((out, i) => {
		const raw =
			opt.finalRunoff === 'surfacePlusSami'
				? surface[i]! + qlag[i]! + out.baseflow - out.transmissionLoss
				: opt.finalRunoff === 'totalOrBaseflow'
					? Math.max(pitmanTotal[i]!, out.baseflow) - out.transmissionLoss // OQ-S3 (c)
					: pitmanTotal[i]! + out.baseflow - out.transmissionLoss;
		if (!Number.isFinite(raw)) throw new SamiPartError(`Sami runoff is ${raw} in month ${i}`);
		if (raw < 0) negative++;
		const clampedMm = raw < 0 && opt.negativeRunoff === 'clamp' ? -raw : 0; // R6-R3
		return { S: S[i]!, pitmanTotal: pitmanTotal[i]!, surface: surface[i]!, aquiferInput: inputs[i]!, aquifer: out, interflow: qlag[i]!, runoff: raw + clampedMm, clampedMm };
	});
	return { options: opt, pitman, soil, initialAquifer, months, negativeRunoffMonths: negative };
}

// ---------------------------------------------------------------------------
// Water balance of the composed module
// ---------------------------------------------------------------------------

/** Run totals, mm over the catchment, of every term of the composed balance. */
export interface SamiWaterBalance {
	readonly rain: Mm;
	/** Σ RE: recharge Sami draws from S (OQ-S2: from the Pitman store in (b), created on top of it in (a)). */
	readonly recharge: Mm;
	/** Σ SIF, in reading (a) of OQ-S3 only (0 in (b), where the interflow is unused). */
	readonly soilInterflow: Mm;
	/** Water added by clamping negative Qfinal (R6-R3); 0 under `keep`. */
	readonly clamped: Mm;
	readonly interception: Mm;
	readonly evaporation: Mm;
	/** Σ of the Pitman `soilDrain` (OQ-S2 (b)); 0 in (a). */
	readonly soilDrain: Mm;
	readonly deltaSoil: Mm;
	/** Pitman flow not passed on: TL-lag storage change plus the dropped FT term (reading (a)). */
	readonly pitmanNotUsed: Mm;
	readonly deltaPercolating: Mm;
	readonly deltaAquifer: Mm;
	/** Interflow lag storage change (reading (a)); the discarded aquifer excess (readings (b), (c)). */
	readonly interflowNotUsed: Mm;
	/** Reading (c): baseflow taken from the aquifer that the stream doesn't show, Σ min(GWBF_net, Q); 0 otherwise. */
	readonly baseflowNotUsed: Mm;
	readonly groundwaterEvaporation: Mm;
	readonly regionalOutflow: Mm;
	readonly abstraction: Mm;
	readonly runoff: Mm;
	/** Sources − sinks; 0 up to rounding when every part conserves mass. */
	readonly residual: Mm;
}

const total = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

/**
 * The composed module's water balance over the run (docs/theory/sami.md §5
 * extended through the Pitman core):
 *
 *   rain + ΣRE + ΣSIF + Σclamped = I + E + drain + ΔS + pitmanNotUsed + ΔP + ΔSTORE
 *                       + interflowNotUsed + baseflowNotUsed + ET + OUT + ABS + ΣQfinal
 *
 * (ΣSIF only in OQ-S3 (a)). Every term is measured from the parts'
 * outputs, so the residual checks the composition and the parts together.
 */
export function samiWaterBalance(sim: SamiSimulation, input: SamiInput): SamiWaterBalance {
	const pm = sim.pitman.months;
	const a = sim.months.map((m) => m.aquifer);
	const readingA = sim.options.finalRunoff === 'surfacePlusSami';
	const used = sim.months.map((m) => (readingA ? m.surface : m.pitmanTotal));
	const pitmanOut = total(pm.map((m) => m.paved + m.base + m.fast));
	const p0 = input.soil.P0;
	const pEnd = sim.soil.p[sim.soil.p.length - 1] ?? p0;
	const storeEnd = a[a.length - 1]?.store ?? sim.initialAquifer.store;
	const aqx = total(a.map((o) => o.excessToInterflow));
	const sif = total(sim.soil.soilInterflow);
	const t = {
		rain: total(pm.map((m) => m.P)),
		recharge: total(sim.soil.re),
		soilInterflow: readingA ? sif : 0,
		clamped: total(sim.months.map((m) => m.clampedMm)),
		interception: total(pm.map((m) => m.interception)),
		evaporation: total(pm.map((m) => m.E)),
		soilDrain: total(pm.map((m) => m.drain)),
		deltaSoil: pm.length > 0 ? pm[pm.length - 1]!.sEnd - pm[0]!.sStart : 0,
		pitmanNotUsed: pitmanOut - total(used),
		deltaPercolating: pEnd - p0,
		deltaAquifer: storeEnd - sim.initialAquifer.store,
		interflowNotUsed: readingA ? sif + aqx - total(sim.months.map((m) => m.interflow)) : aqx,
		baseflowNotUsed:
			sim.options.finalRunoff === 'totalOrBaseflow' ? total(sim.months.map((m) => Math.min(m.aquifer.baseflow, m.pitmanTotal))) : 0,
		groundwaterEvaporation: total(a.map((o) => o.et)),
		regionalOutflow: total(a.map((o) => o.outflow)),
		abstraction: total(sim.months.map((m) => m.aquiferInput.abstraction)),
		runoff: total(sim.months.map((m) => m.runoff))
	};
	const sources = t.rain + t.recharge + t.soilInterflow + t.clamped;
	const sinks =
		t.interception + t.evaporation + t.soilDrain + t.deltaSoil + t.pitmanNotUsed + t.deltaPercolating + t.deltaAquifer +
		t.interflowNotUsed + t.baseflowNotUsed + t.groundwaterEvaporation + t.regionalOutflow + t.abstraction + t.runoff;
	return { ...t, residual: sources - sinks };
}

// ---------------------------------------------------------------------------
// From a runoff module file
// ---------------------------------------------------------------------------

/**
 * Monthly groundwater abstraction ABS_i, mm over the area (§3.11; OQ-S9):
 * the L.036–L.037 annual value (million m³/a, interpolated by
 * hydrological year and held flat beyond the table, OQ-17) spread evenly
 * over the 12 months. Returns `null` for a time-series file (AbstractionsOn = 2), which is not
 * read yet (R3-N9). `areaKm2PerMonth` is the area the run converts depths
 * back to volume with when it changes month by month (`activeAreaKm2`,
 * R6-P1), so the abstracted volume stays the L.037 volume; L.002 otherwise.
 */
export function samiAbstractionMm(
	module: Pick<RunoffModule, 'sami' | 'areaKm2'>,
	startYear: HydroYear,
	endYear: HydroYear,
	options: SamiOptionsInput = {},
	areaKm2PerMonth?: readonly number[]
): number[] | null {
	const s = module.sami;
	const months = 12 * (endYear - startYear + 1);
	if (!s) return new Array<number>(months).fill(0);
	if (s.abstractionMode === 2) return null;
	const opt = resolveSamiOptions(options);
	const on = opt.abstractions === 'whenTablePresent' ? s.abstractions.length > 0 : s.abstractionMode === 1 && s.abstractions.length > 0;
	const out: number[] = [];
	for (let year = startYear; year <= endYear; year++) {
		const mm3 = on ? yearTableValue(s.abstractions, year) / 12 : 0;
		for (let m = 0; m < 12; m++) out.push(mm3 === 0 ? 0 : (mm3 * 1000) / (areaKm2PerMonth?.[out.length] ?? module.areaKm2));
	}
	return out;
}

/**
 * The §3.12 series as `RunoffDiagnostics`: net runoff (Qfinal), surface
 * runoff (its surface part), groundwater outflow (GWBF_net + QLAG, TT 689
 * p.181–182 "groundwater outflows" = baseflow + interflow), paved flow,
 * Pitman S, aquifer storage, aquifer recharge (AQRECH) and interflow
 * (QLAG). `areaKm2` is L.002, or the area per month when it changes
 * (R6-P1). Flows in million m³/month; `RunoffDiagnostics` has no slot for
 * baseflow or transmission loss alone (R6-R2): they stay in `SamiSimulation`.
 */
export function samiDiagnostics(sim: SamiSimulation, areaKm2: number | readonly number[], startYear: HydroYear): RunoffDiagnostics {
	const toMm3 = (mm: number, i: number) => (mm * (typeof areaKm2 === 'number' ? areaKm2 : areaKm2[i]!)) / 1000;
	const mm3 = (f: (m: SamiMonth, i: number) => number): MonthlySeries => ({ startYear, values: sim.months.map((m, i) => toMm3(f(m, i), i)), unit: 'Mm3' });
	const mm = (f: (m: SamiMonth) => number): MonthlySeries => ({ startYear, values: sim.months.map(f), unit: 'mm' });
	return {
		netRunoff: mm3((m) => m.runoff),
		surfaceRunoff: mm3((m) => m.surface),
		groundwaterOutflow: mm3((m) => m.aquifer.baseflow + m.interflow),
		pavedFlow: mm3((_, i) => sim.pitman.months[i]!.paved),
		soilMoistureMm: mm((m) => m.S),
		aquiferStorageMm: mm((m) => m.aquifer.store),
		rechargeMm: mm((m) => m.aquifer.aquiferRecharge),
		interflow: mm3((m) => m.interflow)
	};
}
