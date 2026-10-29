/**
 * The reservoir module (docs/theory/reservoir.md; TT 690 ch.2 pp.9–10;
 * TT 689 ch.8 pp.169–171; TT 691 §7.6 and §12.3 pp.157–158).
 *
 * One monthly mass balance per month over the whole run (R3-1):
 *
 *   E  = A₁ (G − P) / 1000                     TT 690 p.9 eq. 2.1
 *   S₂ = S₁ + I − D − E                         TT 690 p.9 eq. 2.2
 *   S₂ > CAP → SPILL = S₂ − CAP, S₂ = CAP       TT 690 p.9
 *   S₂ < 0   → D reduced (TT 689 ch.8 priorities), S₂ = 0
 *   A  = a S^b, a = FSA / CAP^b                 TT 690 p.10 eq. 2.3
 *   D  = Dm (S₁ ≥ Sr) or Fr·Dm (S₁ < Sr)        TT 690 p.10 eqs. 2.4–2.5
 *
 * Every choice the manuals leave open has an ID (R3-RV…) in the spec's
 * open questions and, where cheap, a field of `ReservoirOptions`.
 */

import type { ModuleRunContext, ModuleRunResult, RouteFlows } from '../network/contract.js';
import { definedFlowSeries, monthCount } from '../network/contract.js';
import type { HydroYear, ModuleRef, MonthlySeries, ReservoirModule, ReservoirOutflow, RunMessage } from '../types.js';
import { allocateDrafts, type DeficitCase } from './allocate.js';
import { CapacityTableError, capacitySeries, surfaceArea, type CapacityBetweenRows, type CapacityOutsideTable, type YearCapacity } from './capacity.js';

/** The provisional reservoir choices, each with its open question in docs/theory/reservoir.md §7. */
export interface ReservoirOptions {
	/** R3-RV4: capacity in a year between two table rows (default `linear`). */
	readonly capacityBetweenRows: CapacityBetweenRows;
	/** R3-RV5: a simulated year outside the capacity table in historical mode (default `error`). */
	readonly capacityOutsideTable: CapacityOutsideTable;
	/**
	 * R3-RV7 (U-9): what an L.015 initial storage of exactly 0 means.
	 * `empty` (default) starts the reservoir empty; `halfFull` treats it like
	 * an absent line (50 % of full supply).
	 */
	readonly zeroInitialStorage: 'empty' | 'halfFull';
	/**
	 * R3-RV11: arithmetic. `float64` (default) or `float32`, which rounds the
	 * month-end storage with `Math.fround` (TT 691 p.79 declares SNOW/QRV REAL).
	 */
	readonly precision: 'float64' | 'float32';
}

export const DEFAULT_RESERVOIR_OPTIONS: ReservoirOptions = {
	capacityBetweenRows: 'linear', // R3-RV4
	capacityOutsideTable: 'error', // R3-RV5
	zeroInitialStorage: 'empty', // R3-RV7
	precision: 'float64' // R3-RV11
};

/**
 * TT 691 p.80: a failure is "minor" below 0.009 million m³ in a month and
 * "major" above it (R3-RV10: exactly 0.009 counts as minor).
 */
export const MAJOR_FAILURE_MM3 = 0.009;

/** Deficits smaller than this are rounding noise, not failures, million m³. */
const DEFICIT_TOLERANCE_MM3 = 1e-9;

/** Negative flows down to this are rounding noise and read as 0 (R3-RV23), million m³. */
const NEGATIVE_TOLERANCE_MM3 = 1e-9;

/** Invalid reservoir data or inputs. The message names the module. */
export class ReservoirRunError extends Error {
	override readonly name = 'ReservoirRunError';
}

/** What a draft route is, for the deficit priorities (§3.3). */
export type DraftKind =
	/** A defined-flow (or demand) file on the route: a time series of demands (TT 690 p.10 type 2). */
	| 'defined'
	/** `'*'`: 12 monthly volumes with a trigger level and restriction factor (type 3). */
	| 'monthly'
	/** No file: a demand calculated by the module downstream, e.g. an irrigation abstraction (type 1). */
	| 'calculated';

/** Per-route detail. */
export interface ReservoirRouteDetail {
	readonly route: number;
	readonly kind: DraftKind;
	readonly isSpillRoute: boolean;
	/** Demand on the route, million m³/month (after any restriction factor). */
	readonly demand: MonthlySeries;
	/** Draft supplied, million m³/month (excludes spill). */
	readonly supply: MonthlySeries;
}

/** The richer per-month breakdown, for tests and later the UI. All million m³/month unless noted. */
export interface ReservoirDetail {
	/** Total inflow I (simulated and defined inflow routes). */
	readonly inflow: MonthlySeries;
	/** Storage at the start of each month, S₁. */
	readonly startStorage: MonthlySeries;
	/** Storage at the end of each month, S₂. */
	readonly storage: MonthlySeries;
	/** Full supply volume in force, CAP. */
	readonly capacity: MonthlySeries;
	/** Surface area at the start of each month, A₁, km². */
	readonly areaKm2: readonly number[];
	/** Rainfall on the surface, A₁·P/1000. */
	readonly rainfall: MonthlySeries;
	/** Gross evaporation from the surface, A₁·G/1000 (reduced only when the dam dries up, R3-RV3). */
	readonly evaporation: MonthlySeries;
	/** Spill, SPILL. */
	readonly spill: MonthlySeries;
	/** Each outflow route's demand and supply, in L.013 order. */
	readonly routes: readonly ReservoirRouteDetail[];
	/** The deficit case of each month. */
	readonly deficitCase: readonly DeficitCase[];
}

/** What `runReservoir` returns: the contract result and the breakdown. */
export interface ReservoirRun {
	readonly result: ModuleRunResult;
	readonly detail: ReservoirDetail;
}

/** Extra inputs `runReservoir` takes beyond the `ReservoirSimulator` contract. */
export interface ReservoirRunInput {
	/**
	 * Calculated demands on outflow routes without a defined-flow file, e.g.
	 * an irrigation module's abstraction route, keyed by route number,
	 * million m³/month. A calculated route not listed has no demand. The
	 * contract has no slot for these yet (report, contract change 1).
	 */
	readonly demands?: RouteFlows;
	readonly options?: Partial<ReservoirOptions>;
}

const MONTH_NAMES = ['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'] as const;

const series = (startYear: HydroYear, values: number[]): MonthlySeries => ({ startYear, values, unit: 'Mm3' });

/**
 * Simulates one reservoir over the run (docs/theory/reservoir.md §3.8).
 * Throws `ReservoirRunError` naming the module for invalid data.
 */
export function runReservoir(module: ReservoirModule, inflows: RouteFlows, ctx: ModuleRunContext, input: ReservoirRunInput = {}): ReservoirRun {
	const options: ReservoirOptions = { ...DEFAULT_RESERVOIR_OPTIONS, ...input.options };
	const ref: ModuleRef = { type: 'RV', number: module.number };
	const label = `RV ${module.number}${module.name.trim() ? ` (${module.name.trim()})` : ''}`;
	const fail = (text: string): never => {
		throw new ReservoirRunError(`${label}: ${text}`);
	};
	const { mode, startYear, endYear } = ctx;
	const n = monthCount(startYear, endYear);
	const natural = mode.kind === 'natural';
	const messages: RunMessage[] = [];
	const note = (m: RunMessage): void => {
		messages.push({ ...m, module: ref });
	};

	// ---- validation (§6) ----
	if (!Number.isFinite(module.areaVolumePower) || module.areaVolumePower <= 0) {
		fail(`area–volume power (L.002 RVPOW) must be positive, got ${module.areaVolumePower}`);
	}
	if (!Number.isFinite(module.mapMm) || module.mapMm < 0) fail(`MAP (L.002) must be non-negative, got ${module.mapMm}`);
	module.panMm.forEach((v, m) => {
		if (!Number.isFinite(v) || v < 0) fail(`pan evaporation for ${MONTH_NAMES[m]} (L.007) must be non-negative, got ${v}`);
	});
	module.panFactors.forEach((v, m) => {
		if (!Number.isFinite(v) || v < 0) fail(`pan factor for ${MONTH_NAMES[m]} (L.008) must be non-negative, got ${v}`);
	});
	if (new Set(module.inflows.map((c) => c.route)).size !== module.inflows.length) fail('an inflow route is listed twice (L.011)');
	const outRoutes = new Set(module.outflows.map((o) => o.route));
	if (outRoutes.size !== module.outflows.length) fail('an outflow route is listed twice (L.013)');
	if (!outRoutes.has(module.spillRoute)) fail(`spill route ${module.spillRoute} (L.009) is not one of its outflow routes (L.013; TT 689 pp.88–89)`);
	if (module.initialStorageMm3 !== undefined && !Number.isFinite(module.initialStorageMm3)) fail('initial storage (L.015) is not a number');
	for (const route of Object.keys(input.demands ?? {}).map(Number)) {
		const out = module.outflows.find((o) => o.route === route);
		if (!out) fail(`a calculated demand was given for route ${route}, which is not an outflow route`);
		else if (out.definedFlowFile !== null) fail(`a calculated demand was given for route ${route}, which has a defined flow ('${out.definedFlowFile}')`);
	}

	const checkSeries = (what: string, s: MonthlySeries): readonly number[] => {
		if (s.unit !== 'Mm3' && s.unit !== 'Mm3PerMonth') fail(`${what} is in ${s.unit}, not million m³ per month`);
		if (s.startYear !== startYear || s.values.length !== n) {
			fail(`${what} covers ${s.startYear} for ${s.values.length} months; the run is ${startYear}–${endYear} (${n} months)`);
		}
		// R3-RV23: a negative flow is an error; rounding noise above −1e-9 reads as 0.
		const k = s.values.findIndex((v) => !Number.isFinite(v) || v < -NEGATIVE_TOLERANCE_MM3);
		if (k >= 0) fail(`${what} is negative or invalid (${s.values[k]}) in ${MONTH_NAMES[k % 12]} ${startYear + Math.floor(k / 12)}`);
		return s.values.map((v) => (v < 0 ? 0 : v));
	};
	const definedFile = (route: number, fileName: string, what: string): readonly number[] => {
		const file = ctx.flowFile(fileName) ?? fail(`${what} route ${route}: defined-flow file '${fileName}' is not in the network`);
		let read;
		try {
			read = definedFlowSeries(file, mode, startYear, endYear);
		} catch (e) {
			return fail(`${what} route ${route}: ${(e as Error).message}`);
		}
		for (const m of read.messages) note({ ...m, route });
		return checkSeries(`${what} route ${route} ('${fileName}')`, read.series);
	};

	// ---- inflow I (§3.1) ----
	const inflow = new Array<number>(n).fill(0);
	for (const conn of module.inflows) {
		let values: readonly number[];
		if (conn.definedFlowFile !== null) values = definedFile(conn.route, conn.definedFlowFile, 'inflow');
		else {
			const s = inflows[conn.route] ?? fail(`no flow was given for simulated inflow route ${conn.route}`);
			values = checkSeries(`inflow route ${conn.route}`, s);
		}
		for (let t = 0; t < n; t++) inflow[t]! += values[t]!;
	}

	// ---- drafts (§3.2) ----
	interface Draft {
		readonly out: ReservoirOutflow;
		readonly kind: DraftKind;
		/** Demand before any restriction. */
		readonly base: readonly number[];
	}
	const drafts: Draft[] = module.outflows.map((out) => {
		if (out.monthlyAbstraction) {
			const { volumesMm3, fullSupplyAboveMm3, restrictionFactor } = out.monthlyAbstraction;
			volumesMm3.forEach((v, m) => {
				if (!Number.isFinite(v) || v < 0) fail(`route ${out.route}: monthly abstraction for ${MONTH_NAMES[m]} (L.014) must be non-negative, got ${v}`);
			});
			if (!Number.isFinite(fullSupplyAboveMm3) || fullSupplyAboveMm3 < 0) fail(`route ${out.route}: trigger storage (L.014 v13) must be non-negative, got ${fullSupplyAboveMm3}`);
			if (!Number.isFinite(restrictionFactor) || restrictionFactor < 0) fail(`route ${out.route}: restriction factor (L.014 v14) must be non-negative, got ${restrictionFactor}`);
			if (restrictionFactor > 1) {
				note({ level: 'warning', route: out.route, text: `route ${out.route}: restriction factor ${restrictionFactor} is above 1; 1 is used (TT 689 p.151)` });
			}
			const base = natural ? new Array<number>(n).fill(0) : Array.from({ length: n }, (_, t) => volumesMm3[t % 12]!);
			return { out, kind: 'monthly' as const, base };
		}
		if (out.definedFlowFile === '*') fail(`route ${out.route}: '*' (monthly defined abstraction) without its L.014 line`);
		if (out.definedFlowFile !== null) return { out, kind: 'defined' as const, base: definedFile(out.route, out.definedFlowFile, 'outflow') };
		const given = input.demands?.[out.route];
		const base = given && !natural ? checkSeries(`calculated demand on route ${out.route}`, given) : new Array<number>(n).fill(0);
		return { out, kind: 'calculated' as const, base };
	});
	const definedIdx = drafts.flatMap((d, k) => (d.kind === 'defined' ? [k] : []));
	const calcIdx = drafts.flatMap((d, k) => (d.kind === 'defined' ? [] : [k]));

	// ---- capacity, rainfall, evaporation inputs (§3.4–§3.6) ----
	let capYears: readonly YearCapacity[];
	try {
		const cap = capacitySeries(module.capacity, mode, startYear, endYear, {
			between: options.capacityBetweenRows,
			outside: options.capacityOutsideTable
		});
		capYears = cap.years;
		for (const m of cap.messages) note(m);
	} catch (e) {
		if (e instanceof CapacityTableError) fail(e.message);
		throw e;
	}

	const rainMm = new Array<number>(n).fill(0);
	if (!natural) {
		const ran = ctx.rainfall(module.rainfallFile) ?? fail(`rainfall file '${module.rainfallFile}' (L.002) is not in the network`);
		const rows = new Map(ran.rows.map((row) => [row.year, row.months]));
		for (let y = startYear; y <= endYear; y++) {
			const months = rows.get(y) ?? fail(`rainfall file '${module.rainfallFile}' has no year ${y}`);
			months.forEach((pct, m) => {
				if (!Number.isFinite(pct) || pct < 0) fail(`rainfall file '${module.rainfallFile}' has a negative or invalid value (${pct}) in ${MONTH_NAMES[m]} ${y}`);
				rainMm[(y - startYear) * 12 + m] = (pct / 100) * module.mapMm; // TT 690 §1.3, TT 689 p.90
			});
		}
	}
	const grossEvapMm = module.panMm.map((pan, m) => pan * module.panFactors[m]!); // G = pan × factor, TT 691 p.157 L.007–L.008

	// ---- initial storage (§3.7) ----
	const firstCap = capYears[0]?.capMm3 ?? 0;
	let s1: number;
	if (natural) s1 = 0;
	else if (module.initialStorageMm3 === undefined || module.initialStorageMm3 < 0) s1 = 0.5 * firstCap;
	else if (module.initialStorageMm3 === 0 && options.zeroInitialStorage === 'halfFull') s1 = 0.5 * firstCap;
	else s1 = module.initialStorageMm3;
	const round = options.precision === 'float32' ? Math.fround : (x: number) => x;
	s1 = round(s1);

	// ---- the monthly loop (§3.8) ----
	const out = {
		start: new Array<number>(n),
		storage: new Array<number>(n),
		capacity: new Array<number>(n),
		area: new Array<number>(n),
		rain: new Array<number>(n),
		evap: new Array<number>(n),
		spill: new Array<number>(n),
		demand: drafts.map(() => new Array<number>(n)),
		supply: drafts.map(() => new Array<number>(n)),
		cases: new Array<DeficitCase>(n)
	};
	const failures = { definedMinor: 0, definedMajor: 0, calculatedMinor: 0, calculatedMajor: 0 };

	for (let t = 0; t < n; t++) {
		const year = startYear + Math.floor(t / 12);
		const m = t % 12;
		const cap = capYears[Math.floor(t / 12)]!;
		const i = inflow[t]!;

		// Demands this month; '*' restricted on the start-of-month storage (TT 691 p.158; R3-RV8).
		const demand = drafts.map((d) => {
			const base = d.base[t]!;
			if (d.kind !== 'monthly') return base;
			const { fullSupplyAboveMm3, restrictionFactor } = d.out.monthlyAbstraction!;
			return s1 < fullSupplyAboveMm3 ? Math.min(restrictionFactor, 1) * base : base; // eqs. 2.4–2.5
		});

		let a1 = 0;
		let rain = 0;
		let evap = 0;
		if (!natural) {
			a1 = surfaceArea(s1, cap, module.areaVolumePower); // eq. 2.3, area at the start of the month (R3-RV2)
			rain = (a1 * rainMm[t]!) / 1000;
			evap = (a1 * grossEvapMm[m]!) / 1000;
		}
		const e = evap - rain; // eq. 2.1, E = A₁ (G − P) / 1000

		const available = s1 + i - e;
		const alloc = allocateDrafts(
			available,
			definedIdx.map((k) => demand[k]!),
			calcIdx.map((k) => demand[k]!)
		);
		const supply = new Array<number>(drafts.length);
		definedIdx.forEach((k, j) => (supply[k] = alloc.defined[j]!));
		calcIdx.forEach((k, j) => (supply[k] = alloc.calculated[j]!));
		const drawn = supply.reduce((s, x) => s + x, 0);

		// eq. 2.2. A month with a deficit draws all the water there is, so it
		// ends empty (TT 690 p.9: S₂ = 0); `max` only absorbs rounding.
		// R3-RV11: under float32 the storage is rounded before the spill test,
		// so it never ends above CAP (the balance then closes to float32 precision).
		const pre = alloc.deficitCase === 'none' ? Math.max(0, available - drawn) : 0;
		let s2 = round(pre);
		let spill = 0;
		if (s2 > cap.capMm3) {
			spill = Math.max(0, pre - cap.capMm3); // TT 690 p.9: SPILL = S₂ − CAP
			s2 = cap.capMm3; //                       and S₂ = CAP
		}
		// Net evaporation above S₁ + I (R3-RV3): the water there was
		// evaporates and no more, so evaporation becomes S₁ + I + rain.
		if (available < 0) evap = Math.max(0, evap + available);

		out.start[t] = s1;
		out.storage[t] = s2;
		out.capacity[t] = cap.capMm3;
		out.area[t] = a1;
		out.rain[t] = rain;
		out.evap[t] = evap;
		out.spill[t] = spill;
		out.cases[t] = alloc.deficitCase;
		drafts.forEach((_, k) => {
			out.demand[k]![t] = demand[k]!;
			out.supply[k]![t] = supply[k]!;
		});

		const at = { year, month: m };
		const defDef = alloc.definedDeficit > DEFICIT_TOLERANCE_MM3 ? alloc.definedDeficit : 0;
		const calcDef = alloc.calculatedDeficit > DEFICIT_TOLERANCE_MM3 ? alloc.calculatedDeficit : 0;
		if (defDef > 0) failures[defDef > MAJOR_FAILURE_MM3 ? 'definedMajor' : 'definedMinor']++;
		if (calcDef > 0) failures[calcDef > MAJOR_FAILURE_MM3 ? 'calculatedMajor' : 'calculatedMinor']++;
		if (defDef > 0 || calcDef > 0) note({ level: 'warning', at, text: deficitText(alloc.deficitCase, MONTH_NAMES[m]!, year, defDef, calcDef) });

		s1 = s2;
	}

	// End-of-run summary, as WRSM2000.ERR's "At least one ... failure" lines (TT 689 p.169).
	for (const [kind, minor, major] of [
		['defined', failures.definedMinor, failures.definedMajor],
		['calculated', failures.calculatedMinor, failures.calculatedMajor]
	] as const) {
		if (major > 0) note({ level: 'warning', text: `At least one major failure to supply ${kind} demands (${major} month(s) short by more than ${MAJOR_FAILURE_MM3} million m³)` });
		if (minor > 0) note({ level: 'warning', text: `At least one minor failure to supply ${kind} demands (${minor} month(s) short by at most ${MAJOR_FAILURE_MM3} million m³)` });
	}

	// ---- results ----
	const outflows: Record<number, MonthlySeries> = {};
	drafts.forEach((d, k) => {
		const values = out.supply[k]!.slice();
		if (d.out.route === module.spillRoute) for (let t = 0; t < n; t++) values[t]! += out.spill[t]!; // spill added to the route's draft (TT 689 p.169)
		outflows[d.out.route] = series(startYear, values);
	});
	const storage = series(startYear, out.storage);

	return {
		result: { outflows, storage, messages },
		detail: {
			inflow: series(startYear, inflow),
			startStorage: series(startYear, out.start),
			storage,
			capacity: series(startYear, out.capacity),
			areaKm2: out.area,
			rainfall: series(startYear, out.rain),
			evaporation: series(startYear, out.evap),
			spill: series(startYear, out.spill),
			routes: drafts.map((d, k) => ({
				route: d.out.route,
				kind: d.kind,
				isSpillRoute: d.out.route === module.spillRoute,
				demand: series(startYear, out.demand[k]!),
				supply: series(startYear, out.supply[k]!)
			})),
			deficitCase: out.cases
		}
	};
}

function deficitText(c: DeficitCase, month: string, year: HydroYear, definedDeficit: number, calculatedDeficit: number): string {
	const head = `Water balance error in ${month} ${year}:`;
	const amounts = [
		definedDeficit > 0 ? `defined ${definedDeficit.toFixed(3)}` : '',
		calculatedDeficit > 0 ? `calculated ${calculatedDeficit.toFixed(3)}` : ''
	]
		.filter(Boolean)
		.join(', ');
	const what =
		c === 'calculatedReduced'
			? 'there was not enough water to satisfy calculated demands. Calculated outflows were reduced.'
			: c === 'definedReduced'
				? 'the defined demands were greater than the total storage + supply. Calculated outflows were set to zero; defined outflows were shared in proportion.'
				: 'the reservoir was dry. Defined and calculated outflows were set to zero.';
	return `${head} ${what} Shortfall (million m³): ${amounts}.`;
}

/** The `ReservoirSimulator` of the Round 3 contract: `runReservoir` with no calculated demands and the default options. */
export function simulateReservoir(module: ReservoirModule, inflows: RouteFlows, ctx: ModuleRunContext): ModuleRunResult {
	return runReservoir(module, inflows, ctx).result;
}
