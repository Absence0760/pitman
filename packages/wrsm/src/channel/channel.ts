/**
 * The channel reach module (CR): `simulateChannel`, the `ChannelSimulator`
 * of the Round 3 contract (`src/network/contract.ts`).
 *
 * Spec: docs/theory/channel.md. Each month (spec §2):
 *
 * 1. sum the inflow routes (a defined-flow file replaces the route's flow;
 *    a comprehensive wetland's local inflow route goes to the wetland);
 * 2. take off the bed loss CHBL (TT 689 §6.2.3.1 p.144);
 * 3. supply the defined outflows, then the calculated demands, sharing a
 *    shortfall in proportion to demand (TT 689 ch.8 pp.169–170);
 * 4. run the special feature on what is left: basic wetland (TT 690 ch.9),
 *    comprehensive wetland (TT 690 ch.10) or diversion (TT 689 §6.2.3.4
 *    pp.147–149);
 * 5. send the rest down the principal outflow route.
 *
 * Every choice the manuals leave open is an `OQ-CR…` in the spec's §8 and,
 * where it is cheap, a field of `ChannelOptions`.
 */

import type { ChannelModule, MonthlySeries, RainfallSeries, RunMessage, RouteConnection } from '../types.js';
import { definedFlowSeries, monthCount, type ModuleRunContext, type ModuleRunResult, type RouteFlows } from '../network/contract.js';
import {
	basicWetlandMonth,
	comprehensiveWetlandMonth,
	DEFAULT_WETLAND_SOLVER,
	type BasicRechargeForm,
	type BasicWetlandParameters,
	type ComprehensiveWetlandParameters,
	type WetlandSolver
} from './wetland.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Provisional choices, each an open question in docs/theory/channel.md §8. Defaults: `DEFAULT_CHANNEL_OPTIONS`. */
export interface ChannelOptions {
	/**
	 * OQ-CR3: a defined outflow the reach cannot supply. `supplyInFull`
	 * (default, TT 689 ch.8 p.169: "flows in DEFINED routes are NEVER adjusted
	 * downwards"): the route carries the full defined flow, the missing water
	 * is reported as created. `limitToAvailable`: defined routes share what
	 * is available in proportion to their demands.
	 */
	readonly definedShortfall: 'supplyInFull' | 'limitToAvailable';
	/**
	 * OQ-CR13: a defined-flow file on an inflow route in natural mode.
	 * `remove` (default, R3-2: a defined flow is development) or `keep`
	 * (read the file as in historical mode).
	 */
	readonly definedInflowInNatural: 'remove' | 'keep';
	/** OQ-CR5: the form of eq. 9.1. `printed` (default) or `prose`. */
	readonly basicRechargeForm: BasicRechargeForm;
	/**
	 * OQ-CR8: wetland storage at the start of the run. `nominal` (default:
	 * CHC1 for the basic wetland, Snom for the comprehensive), `half`,
	 * `empty`, or a number in million m³.
	 */
	readonly initialWetlandStorage: 'nominal' | 'half' | 'empty' | number;
	/** OQ-CR10: the successive-approximation settings of TT 690 §10.7.1. */
	readonly wetlandSolver: WetlandSolver;
}

export const DEFAULT_CHANNEL_OPTIONS: ChannelOptions = {
	definedShortfall: 'supplyInFull',
	definedInflowInNatural: 'remove',
	basicRechargeForm: 'printed',
	initialWetlandStorage: 'nominal',
	wetlandSolver: DEFAULT_WETLAND_SOLVER
};

/** Failures of a month below this are "minor", above it "major" (TT 691 §7.7.1 pp.86–87, CRFAIL: 0.009 per month; OQ-CR14). */
export const MAJOR_FAILURE_MM3 = 0.009;

/** At most this many messages of each failure type are listed (TT 691 §7.7.1 p.87: "only the first 255 errors of any type"). */
export const MAX_FAILURE_MESSAGES = 255;

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** Per-month terms of the reach's water balance, million m³/month (spec §6). */
export interface ChannelBreakdown {
	/** Sum of all inflow routes, including a wetland's local inflow. */
	readonly inflow: MonthlySeries;
	/** CHBL actually lost (≤ the river flow). */
	readonly bedLoss: MonthlySeries;
	/** Supplied to defined outflow routes (not the principal one). */
	readonly definedOutflow: MonthlySeries;
	/** Supplied to calculated-demand routes (irrigation abstractions). */
	readonly calculatedOutflow: MonthlySeries;
	/** River flow reaching the special feature (Qr, Qus or qtot). */
	readonly upstreamOfFeature: MonthlySeries;
	/** Flow from the channel into the wetland (Qloss > 0 or Qin). */
	readonly wetlandInflow: MonthlySeries;
	/** Flow from the wetland back to the channel (−Qloss when negative, or Qout). */
	readonly wetlandReturn: MonthlySeries;
	/** Local inflow straight into a comprehensive wetland (Qloc). */
	readonly wetlandLocalInflow: MonthlySeries;
	/** Abstraction from a comprehensive wetland (Qabs supplied). */
	readonly wetlandAbstraction: MonthlySeries;
	/** Rain on the wetland, P × area. */
	readonly wetlandRain: MonthlySeries;
	/** Gross evaporation from the wetland, pan × factor × area. */
	readonly wetlandEvaporation: MonthlySeries;
	/** Net evaporation = gross − rain (ETA or Qevap); negative in a wet month. */
	readonly wetlandNetEvaporation: MonthlySeries;
	/** Flow diverted down the diversion route. */
	readonly diversion: MonthlySeries;
	/** Principal outflow route. */
	readonly principal: MonthlySeries;
	/** Water a defined route was given that the reach did not have (OQ-CR3, TT 689 p.168). */
	readonly created: MonthlySeries;
	/** Water lost because the principal route has a defined flow smaller than what reached it (TT 689 p.168). */
	readonly lost: MonthlySeries;
	/** Wetland storage at month end; zeros without a wetland. */
	readonly storage: MonthlySeries;
	/** Storage at the start of the run. */
	readonly initialStorage: number;
}

/** `ModuleRunResult` plus the breakdown. */
export interface ChannelRunResult extends ModuleRunResult {
	readonly breakdown: ChannelBreakdown;
}

/** Invalid channel data or inputs. The message names the module. */
export class ChannelRunError extends Error {
	override readonly name = 'ChannelRunError';
}

// ---------------------------------------------------------------------------
// Allocation (TT 689 ch.8)
// ---------------------------------------------------------------------------

/**
 * Shares `available` among `demands` in proportion to demand (TT 689 ch.8
 * p.169: 2.5 and 3 demanded from 3.5 give 1.59 and 1.91). Returns what each
 * gets; all of it when the total demand fits.
 */
export function shareProportionally(available: number, demands: readonly number[]): number[] {
	const total = demands.reduce((s, d) => s + d, 0);
	if (total <= available) return [...demands];
	if (!(available > 0) || !(total > 0)) return demands.map(() => 0);
	return demands.map((d) => (d * available) / total);
}

/**
 * Flow diverted by a diversion channel (TT 689 §6.2.3.4 p.148):
 * `qinw = min(qdivcap, drprqin × (qtot − drqbnk))`, 0 below bankfull, and
 * no more than `demand` when the route has one.
 */
export function diversionFlow(
	qtot: number,
	d: { readonly bankfullCapacity: number; readonly efficiency: number; readonly maxMonthlyMm3: number },
	demand = Infinity
): number {
	if (qtot <= d.bankfullCapacity) return 0;
	return Math.max(0, Math.min(d.maxMonthlyMm3, d.efficiency * (qtot - d.bankfullCapacity), demand));
}

/** Net and gross evaporation depth for a month, mm: pan × factor, and rain = % MAP / 100 × MAP (spec §5). */
export function wetlandClimate(panMm: number, panFactor: number, percentMap: number, mapMm: number): { gross: number; rain: number; net: number } {
	const gross = panMm * panFactor;
	const rain = (percentMap / 100) * mapMm;
	return { gross, rain, net: gross - rain };
}

// ---------------------------------------------------------------------------
// The simulator
// ---------------------------------------------------------------------------

type Role = 'principal' | 'defined' | 'calculated' | 'diversion' | 'wetlandOut' | 'idle';

interface OutRoute {
	readonly route: number;
	readonly role: Role;
	/** Demand per month (defined file or calculated demand); `undefined` = none. */
	readonly demand?: readonly number[];
	readonly definedFile: string | null;
}

/**
 * Simulates one channel reach over the run. `demands` holds the calculated
 * demand on each outflow route that has one (an irrigation module's
 * abstraction route), million m³/month; it is the fourth argument because
 * the contract has no slot for it yet (OQ-CR4; spec §7, contract change C-1).
 */
export function runChannel(
	module: ChannelModule,
	inflows: RouteFlows,
	ctx: ModuleRunContext,
	demands: RouteFlows = {},
	options: ChannelOptions = DEFAULT_CHANNEL_OPTIONS
): ChannelRunResult {
	const who = `channel reach CR${module.number} '${module.name}'`;
	const fail = (text: string): never => {
		throw new ChannelRunError(`${who}: ${text}`);
	};
	const ref = { type: 'CR' as const, number: module.number };
	const n = monthCount(ctx.startYear, ctx.endYear);
	const natural = ctx.mode.kind === 'natural';
	const messages: RunMessage[] = [];

	validate(module, fail);
	const type = module.wetlandType;

	// --- route series --------------------------------------------------------
	const checkSeries = (s: MonthlySeries | undefined, what: string): readonly number[] | undefined => {
		if (!s) return undefined;
		if (s.startYear !== ctx.startYear || s.values.length !== n) {
			fail(`${what} covers ${s.startYear} for ${s.values.length} months; the run is ${ctx.startYear}–${ctx.endYear} (${n} months)`);
		}
		s.values.forEach((v, i) => {
			if (!Number.isFinite(v) || v < 0) fail(`${what} has ${v} in month ${i + 1}; flows must be ≥ 0`);
		});
		return s.values;
	};
	const definedFile = (c: RouteConnection, mode = ctx.mode): readonly number[] => {
		const file = ctx.flowFile(c.definedFlowFile!);
		if (!file) return fail(`route ${c.route}: defined-flow file '${c.definedFlowFile}' is not in the network`);
		const { series, messages: m } = definedFlowSeries(file, mode, ctx.startYear, ctx.endYear);
		for (const msg of m) messages.push({ ...msg, module: ref, route: c.route });
		return checkSeries(series, `route ${c.route} file '${c.definedFlowFile}'`)!;
	};

	const localIn = type === 2 ? (module.localWetlandInflowRoute ?? 0) : 0;
	const localOut = type === 2 ? (module.localWetlandOutflowRoute ?? 0) : 0;
	const divRoute = type === 3 ? (module.diversionRoute ?? 0) : 0;

	const riverIn = new Array<number>(n).fill(0);
	const localInflow = new Array<number>(n).fill(0);
	for (const c of module.inflows) {
		let values: readonly number[] | undefined;
		if (c.definedFlowFile !== null) {
			const keep = natural && options.definedInflowInNatural === 'keep';
			values = definedFile(c, keep ? { kind: 'historical' } : ctx.mode);
		} else {
			values = checkSeries(inflows[c.route], `inflow route ${c.route}`);
			if (!values) {
				messages.push({ level: 'info', module: ref, route: c.route, text: `${who}: inflow route ${c.route} has no upstream flow and no defined-flow file; taken as zero (OQ-CR19)` });
				continue;
			}
		}
		const target = c.route === localIn ? localInflow : riverIn;
		for (let t = 0; t < n; t++) target[t]! += values[t]!;
	}

	// Outflow routes and their roles (spec §2.3). The local wetland and diversion routes are ordinary routes unless their feature is active (OQ-CR15).
	const outs: OutRoute[] = [];
	const principalConn = module.outflows.find((c) => c.route === module.principalOutflowRoute);
	for (const c of module.outflows) {
		if (c.route === module.principalOutflowRoute) continue;
		const calc = checkSeries(demands[c.route], `calculated demand on route ${c.route}`);
		const fileDemand = c.definedFlowFile !== null ? definedFile(c) : undefined;
		const demand = fileDemand ?? calc;
		const zeroed = natural ? undefined : demand; // D1, OQ-CR12: abstractions and diversions are development
		if (c.route === divRoute) outs.push({ route: c.route, role: 'diversion', demand: zeroed, definedFile: c.definedFlowFile });
		else if (c.route === localOut) outs.push({ route: c.route, role: 'wetlandOut', demand: zeroed, definedFile: c.definedFlowFile });
		else if (fileDemand) outs.push({ route: c.route, role: 'defined', demand: fileDemand, definedFile: c.definedFlowFile });
		else if (calc) outs.push({ route: c.route, role: 'calculated', demand: natural ? undefined : calc, definedFile: null });
		else outs.push({ route: c.route, role: 'idle', definedFile: null });
	}
	const principalDemand = principalConn?.definedFlowFile ? definedFile(principalConn) : undefined;
	if (principalDemand) {
		messages.push({ level: 'warning', module: ref, route: module.principalOutflowRoute, text: `${who}: the principal outflow route has a defined flow; surplus water is lost and a shortfall is created (TT 689 §7.2 p.168)` });
	}

	// --- wetland set-up ------------------------------------------------------
	let basic: BasicWetlandParameters | undefined;
	let comp: ComprehensiveWetlandParameters | undefined;
	if (type === 1) basic = { chc1: module.wetlandStorageMm3, chc2: module.wetlandAreaKm2, chc3: module.rechargeCoefficient };
	if (type === 2) {
		const g = module.comprehensiveWetland!;
		comp = {
			anom: g.bankfullAreaKm2,
			snom: g.bankfullVolumeMm3,
			b: g.areaVolumePower,
			qbf: g.channelBankfullCapacity,
			kin: g.excessToWetland,
			kout: g.wetlandToChannel,
			qdiv: (module.qdiv ?? 0) > 0 ? module.qdiv! : Infinity // OQ-CR9
		};
	}
	const nominal = basic ? basic.chc1 : comp ? comp.snom : 0;
	const s0 = !basic && !comp ? 0 : initialStorage(options.initialWetlandStorage, nominal, fail);
	let rain: RainfallSeries | undefined;
	const rainByYear = new Map<number, readonly number[]>();
	if (basic || comp) {
		const file = module.wetlandRainfallFile;
		if (!file) fail(`wetland type ${type} needs a rainfall file (L.002)`);
		rain = ctx.rainfall(file!);
		if (!rain) fail(`wetland rainfall file '${file}' is not in the network`);
		for (const row of rain!.rows) rainByYear.set(row.year, row.months);
		for (let y = ctx.startYear; y <= ctx.endYear; y++) if (!rainByYear.has(y)) fail(`rainfall file '${file}' has no ${y} row`);
	}

	// --- outputs -------------------------------------------------------------
	const zeros = () => new Array<number>(n).fill(0);
	const out: Record<number, number[]> = { [module.principalOutflowRoute]: zeros() };
	for (const o of outs) out[o.route] = zeros();
	const b = {
		inflow: zeros(), bedLoss: zeros(), definedOutflow: zeros(), calculatedOutflow: zeros(), upstreamOfFeature: zeros(),
		wetlandInflow: zeros(), wetlandReturn: zeros(), wetlandLocalInflow: zeros(), wetlandAbstraction: zeros(), wetlandRain: zeros(),
		wetlandEvaporation: zeros(), wetlandNetEvaporation: zeros(), diversion: zeros(), principal: zeros(), created: zeros(), lost: zeros(), storage: zeros()
	};
	const failures = { defined: { minor: 0, major: 0, listed: 0 }, calculated: { minor: 0, major: 0, listed: 0 } };
	const report = (kind: 'defined' | 'calculated', route: number, t: number, demanded: number, supplied: number) => {
		const short = demanded - supplied;
		if (!(short > 1e-12)) return;
		const f = failures[kind];
		const major = short > MAJOR_FAILURE_MM3;
		if (major) f.major++;
		else f.minor++;
		if (f.listed >= MAX_FAILURE_MESSAGES) return;
		f.listed++;
		const at = { year: ctx.startYear + Math.floor(t / 12), month: t % 12 };
		messages.push({
			level: 'warning',
			module: ref,
			route,
			at,
			text: `${who}: ${major ? 'major' : 'minor'} failure to supply ${kind} demand on route ${route}: demanded ${demanded.toFixed(4)}, ${kind === 'defined' && options.definedShortfall === 'supplyInFull' ? `available ${supplied.toFixed(4)} (full flow supplied, the rest created)` : `supplied ${supplied.toFixed(4)}`} million m³`
		});
	};

	let wets = s0;
	for (let t = 0; t < n; t++) {
		const inflow = riverIn[t]! + localInflow[t]!;
		b.inflow[t] = inflow;
		b.wetlandLocalInflow[t] = localInflow[t]!;

		// Bed loss on the river inflows (TT 689 §6.2.3.1 p.144, OQ-CR2).
		const bed = Math.min(module.bedLossMm3PerMonth, riverIn[t]!);
		b.bedLoss[t] = bed;
		let q = riverIn[t]! - bed;

		// Defined outflows (TT 689 ch.8 p.169).
		const defined = outs.filter((o) => o.role === 'defined');
		const dDem = defined.map((o) => o.demand![t]!);
		const dTotal = dDem.reduce((s, d) => s + d, 0);
		if (dTotal > q) {
			const shares = shareProportionally(q, dDem);
			defined.forEach((o, i) => {
				const given = options.definedShortfall === 'supplyInFull' ? dDem[i]! : shares[i]!;
				out[o.route]![t] = given;
				report('defined', o.route, t, dDem[i]!, shares[i]!);
			});
			if (options.definedShortfall === 'supplyInFull') b.created[t]! += dTotal - q;
			b.definedOutflow[t] = options.definedShortfall === 'supplyInFull' ? dTotal : q;
			q = 0;
		} else {
			defined.forEach((o, i) => (out[o.route]![t] = dDem[i]!));
			b.definedOutflow[t] = dTotal;
			q -= dTotal;
		}

		// Calculated demands, shared in proportion (TT 689 ch.8 p.170).
		const calc = outs.filter((o) => o.role === 'calculated');
		const cDem = calc.map((o) => o.demand?.[t] ?? 0);
		const cShares = shareProportionally(q, cDem);
		let cTotal = 0;
		calc.forEach((o, i) => {
			out[o.route]![t] = cShares[i]!;
			cTotal += cShares[i]!;
			report('calculated', o.route, t, cDem[i]!, cShares[i]!);
		});
		b.calculatedOutflow[t] = cTotal;
		q = Math.max(0, q - cTotal);

		// Special feature on what is left (spec §2.4, OQ-CR1).
		b.upstreamOfFeature[t] = q;
		if (basic || comp) {
			const year = ctx.startYear + Math.floor(t / 12);
			const m = t % 12;
			const clim = wetlandClimate(module.panMm[m]!, module.panFactors[m]!, rainByYear.get(year)![m]!, module.wetlandMapMm);
			if (basic) {
				let r;
				try {
					r = basicWetlandMonth(basic, wets, q, clim.net, options.basicRechargeForm);
				} catch (e) {
					return fail(`${(e as Error).message} in ${year} month ${m + 1}`);
				}
				const area = (basic.chc2 * r.averageStorage) / basic.chc1;
				b.wetlandInflow[t] = Math.max(r.qloss, 0);
				b.wetlandReturn[t] = Math.max(-r.qloss, 0);
				b.wetlandNetEvaporation[t] = r.netEvaporation;
				b.wetlandRain[t] = 0.001 * clim.rain * area;
				b.wetlandEvaporation[t] = r.netEvaporation + b.wetlandRain[t]!;
				wets = r.storageEnd;
				q = r.riverOut;
			} else {
				const lo = outs.find((o) => o.role === 'wetlandOut');
				const qabsDemand = lo?.demand?.[t] ?? 0;
				let r;
				try {
					r = comprehensiveWetlandMonth(comp!, { s1: wets, qus: q, qloc: localInflow[t]!, qabs: qabsDemand, enetM: clim.net / 1000 }, options.wetlandSolver);
				} catch (e) {
					return fail(`${(e as Error).message} in ${year} month ${m + 1}`);
				}
				let qabs = r.qabs;
				if (lo) {
					const isDefined = lo.definedFile !== null;
					report(isDefined ? 'defined' : 'calculated', lo.route, t, qabsDemand, r.qabs);
					if (isDefined && options.definedShortfall === 'supplyInFull' && r.qabsShort > 0) {
						b.created[t]! += r.qabsShort;
						qabs = qabsDemand;
					}
					out[lo.route]![t] = qabs;
				}
				b.wetlandInflow[t] = r.qin;
				b.wetlandReturn[t] = r.qout;
				b.wetlandAbstraction[t] = qabs;
				b.wetlandNetEvaporation[t] = r.qevap;
				b.wetlandRain[t] = 0.001 * clim.rain * r.area;
				b.wetlandEvaporation[t] = r.qevap + b.wetlandRain[t]!;
				wets = r.s2;
				q = r.qds;
			}
			b.storage[t] = wets;
		} else if (type === 3) {
			const dv = outs.find((o) => o.role === 'diversion');
			if (dv && !natural) {
				const demand = dv.demand ? dv.demand[t]! : Infinity; // no demand: unlimited (OQ-CR17)
				const div = diversionFlow(q, module.diversion!, demand);
				out[dv.route]![t] = div;
				b.diversion[t] = div;
				if (dv.demand) report(dv.definedFile !== null ? 'defined' : 'calculated', dv.route, t, demand, div);
				q -= div;
			}
		}

		// Principal outflow (TT 689 p.xvi; §7.2 p.168 and OQ-CR16 for a defined one).
		if (principalDemand) {
			const want = principalDemand[t]!;
			if (want > q) {
				report('defined', module.principalOutflowRoute, t, want, q);
				b.created[t]! += want - q;
			} else b.lost[t] = q - want;
			q = want;
		}
		out[module.principalOutflowRoute]![t] = q;
		b.principal[t] = q;
	}

	for (const kind of ['defined', 'calculated'] as const) {
		const f = failures[kind];
		if (f.minor + f.major > 0) {
			messages.push({
				level: 'warning',
				module: ref,
				text: `${who}: ${f.major} major and ${f.minor} minor failures to supply ${kind} demands${f.minor + f.major > f.listed ? ` (first ${f.listed} listed)` : ''}`
			});
		}
	}

	const series = (values: number[]): MonthlySeries => ({ startYear: ctx.startYear, values, unit: 'Mm3' });
	const outflows: Record<number, MonthlySeries> = {};
	for (const [route, values] of Object.entries(out)) outflows[Number(route)] = series(values);
	const breakdown = Object.fromEntries(Object.entries(b).map(([k, v]) => [k, series(v)])) as unknown as Omit<ChannelBreakdown, 'initialStorage'>;
	return {
		outflows,
		...(basic || comp ? { storage: breakdown.storage } : {}),
		messages,
		breakdown: { ...breakdown, initialStorage: s0 }
	};
}

function initialStorage(choice: ChannelOptions['initialWetlandStorage'], nominal: number, fail: (t: string) => never): number {
	if (typeof choice === 'number') {
		if (!(choice >= 0)) fail(`initial wetland storage ${choice} must be ≥ 0`);
		return choice;
	}
	return choice === 'nominal' ? nominal : choice === 'half' ? nominal / 2 : 0;
}

/** Throws on data the simulation cannot use (spec §7). */
function validate(m: ChannelModule, fail: (t: string) => never): void {
	const inRange = (v: number, lo: number, hi: number) => Number.isFinite(v) && v >= lo && v <= hi;
	if (!(m.principalOutflowRoute > 0)) fail('no principal outflow route (L.006)');
	if (m.inflows.some((c) => c.route === m.principalOutflowRoute)) fail(`route ${m.principalOutflowRoute} is both an inflow and the principal outflow`);
	const outRoutes = new Set<number>();
	for (const c of m.outflows) {
		if (outRoutes.has(c.route)) fail(`outflow route ${c.route} is listed twice`);
		outRoutes.add(c.route);
	}
	if (!inRange(m.bedLossMm3PerMonth, 0, Infinity)) fail(`bed loss CHBL ${m.bedLossMm3PerMonth} must be ≥ 0`);
	if (![0, 1, 2, 3].includes(m.wetlandType)) fail(`wetland type ${m.wetlandType} is not 0–3 (L.011)`);
	if (m.wetlandType === 1 || m.wetlandType === 2) {
		if (!inRange(m.wetlandMapMm, 0, Infinity)) fail(`wetland MAP ${m.wetlandMapMm} must be ≥ 0`);
		for (let k = 0; k < 12; k++) {
			if (!inRange(m.panMm[k]!, 0, Infinity) || !inRange(m.panFactors[k]!, 0, Infinity)) fail(`pan evaporation and factors (L.004–L.005) must be ≥ 0`);
		}
	}
	if (m.wetlandType === 1) {
		if (!(m.wetlandStorageMm3 > 0) || !Number.isFinite(m.wetlandStorageMm3)) fail(`basic wetland: storage CHC1 ${m.wetlandStorageMm3} must be > 0`);
		if (!inRange(m.wetlandAreaKm2, 0, Infinity)) fail(`basic wetland: area CHC2 ${m.wetlandAreaKm2} must be ≥ 0`);
		if (!inRange(m.rechargeCoefficient, 0, 1)) fail(`basic wetland: recharge coefficient CHC3 ${m.rechargeCoefficient} must be 0–1 (OQ-CR6)`);
	}
	if (m.wetlandType === 2) {
		const g = m.comprehensiveWetland;
		if (!g) return fail('comprehensive wetland: L.012 is missing');
		if (!(g.bankfullVolumeMm3 > 0) || !Number.isFinite(g.bankfullVolumeMm3)) fail(`comprehensive wetland: bankfull volume ${g.bankfullVolumeMm3} must be > 0`);
		if (!inRange(g.bankfullAreaKm2, 0, Infinity)) fail(`comprehensive wetland: bankfull area ${g.bankfullAreaKm2} must be ≥ 0`);
		if (!(g.areaVolumePower > 0) || !Number.isFinite(g.areaVolumePower)) fail(`comprehensive wetland: area–volume power ${g.areaVolumePower} must be > 0`);
		if (!inRange(g.channelBankfullCapacity, 0, Infinity)) fail(`comprehensive wetland: channel bankfull capacity ${g.channelBankfullCapacity} must be ≥ 0`);
		if (!inRange(g.excessToWetland, 0, 1)) fail(`comprehensive wetland: proportion into the wetland ${g.excessToWetland} must be 0–1`);
		if (!inRange(g.wetlandToChannel, 0, 1)) fail(`comprehensive wetland: proportion back to the channel ${g.wetlandToChannel} must be 0–1`);
		if (!inRange(m.qdiv ?? 0, 0, Infinity)) fail(`comprehensive wetland: QDIV ${m.qdiv} must be ≥ 0`);
		const li = m.localWetlandInflowRoute ?? 0;
		const lo = m.localWetlandOutflowRoute ?? 0;
		if (li !== 0 && !m.inflows.some((c) => c.route === li)) fail(`local wetland inflow route ${li} (L.014) is not an inflow route`);
		if (lo !== 0 && !outRoutes.has(lo)) fail(`local wetland outflow route ${lo} (L.015) is not an outflow route`);
		if (lo !== 0 && lo === m.principalOutflowRoute) fail(`local wetland outflow route ${lo} cannot be the principal outflow route (TT 689 p.146)`);
	}
	if (m.wetlandType === 3) {
		const r = m.diversionRoute ?? 0;
		const d = m.diversion;
		if (!d) return fail('diversion channel: L.017 is missing');
		if (r === 0) fail('diversion channel: no diversion route (L.016)');
		if (r === m.principalOutflowRoute) fail(`diversion route ${r} cannot be the principal outflow route (TT 689 p.147)`);
		if (!outRoutes.has(r)) fail(`diversion route ${r} (L.016) is not an outflow route`);
		if (!inRange(d.bankfullCapacity, 0, Infinity)) fail(`diversion channel: bankfull capacity ${d.bankfullCapacity} must be ≥ 0`);
		if (!inRange(d.efficiency, 0, 1)) fail(`diversion channel: efficiency ${d.efficiency} must be 0–1`);
		if (!inRange(d.maxMonthlyMm3, 0, Infinity)) fail(`diversion channel: maximum monthly diversion ${d.maxMonthlyMm3} must be ≥ 0`);
	}
}

/** A `ChannelSimulator` with the given options. The optional fourth argument carries calculated demands (contract change C-1). */
export function createChannelSimulator(options: Partial<ChannelOptions> = {}) {
	const full: ChannelOptions = { ...DEFAULT_CHANNEL_OPTIONS, ...options };
	return (module: ChannelModule, inflows: RouteFlows, ctx: ModuleRunContext, demands: RouteFlows = {}): ChannelRunResult =>
		runChannel(module, inflows, ctx, demands, full);
}

/** The channel simulator with the default options (`DEFAULT_CHANNEL_OPTIONS`). */
export const simulateChannel = createChannelSimulator();
