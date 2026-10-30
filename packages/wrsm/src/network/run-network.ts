/**
 * `runNetwork()`: solve a whole network in one run mode.
 *
 * Modules are solved one at a time over the whole record, in `.NET` order
 * (R3-1), after `validateNetwork` has passed. Runoff modules run on
 * `runRunoffModule`; reservoirs and channels on the injected simulators
 * (`ModuleSimulators`, `contract.ts`). Spec: docs/theory/network.md §6.
 */

import type { SamiOptionsInput, SamiRunParts } from '../groundwater/sami/index.js';
import { irrigatedAreaKm2, irrigationDemand, type IrrigationDemand, type IrrigationOptions } from '../irrigation/demand.js';
import { settleIrrigation } from '../irrigation/supply.js';
import type { StreamflowReduction } from '../landuse/contract.js';
import type { ChildTargetModel, SfrOptions } from '../landuse/sfr.js';
import { SFR_TARGETS } from '../runoff/wiring.js';
import { collapseYears, pavedFractionByMonth, specialAreaMessages } from '../landuse/paved.js';
import { PitmanRunError, runRunoffModule, type PitmanOptions } from '../runoff/pitman.js';
import type {
	IrrigationDiagnostics,
	IrrigationModule,
	MonthlySeries,
	NetworkBundle,
	RunMessage,
	RunMode,
	RunoffDiagnostics,
	RunoffModule,
	RunResult
} from '../types.js';
import { definedFlowSeries, monthCount, zeroSeries, type ModuleRunContext, type ModuleRunResult, type ModuleSimulators, type RouteFlows } from './contract.js';
import { applyRunMode } from './modes.js';
import { definedFileOn, lookupFile, moduleLabel, placedLabel, placeModules, type PlacedModule } from './modules.js';
import { runGroup, sfrParents, type PlacedGroup } from './sfr-groups.js';
import { NetworkError, networkDependencies, validateNetwork, type Dependency } from './validate.js';

/** What `runNetwork` needs besides the bundle and the mode. */
export interface RunNetworkOptions {
	readonly simulators: ModuleSimulators;
	/** Pitman core options for every runoff module (R2-1). */
	readonly pitman?: Partial<PitmanOptions>;
	/** Sami parts for every Sami module; default `SAMI_PARTS` (`runoff/wiring.ts`). */
	readonly samiParts?: SamiRunParts;
	/** The Sami composition's switches for every Sami module (OQ-S2 … S11, R6-R3). */
	readonly sami?: SamiOptionsInput;
	/** Streamflow reductions for every **free** runoff module (not in an SFR group); default `STREAMFLOW_REDUCTIONS` (`runoff/wiring.ts`). */
	readonly reductions?: readonly StreamflowReduction[];
	/**
	 * The SFR parent/child mechanism (`landuse/sfr.ts`): calibration options
	 * and the child target models. Targets default to `SFR_TARGETS`
	 * (`runoff/wiring.ts`; afforestation is `runSfrGroup`'s own default).
	 */
	readonly sfr?: { readonly options?: Partial<SfrOptions>; readonly targets?: { readonly forest?: ChildTargetModel; readonly alien?: ChildTargetModel } };
	/** The irrigation modules' provisional switches (R7-I4, R7-I5). */
	readonly irrigation?: Partial<IrrigationOptions>;
}

/** An irrigation module whose demand is on its route and whose supply isn't known yet. */
interface PendingIrrigation {
	readonly p: PlacedModule;
	readonly module: IrrigationModule;
	readonly demand: IrrigationDemand;
}

/**
 * Run `bundle` in `mode`.
 *
 * Throws `NetworkError` (every validation problem at once) when the network
 * can't be run, `PitmanRunError` when a runoff module can't (R2-2: e.g. a
 * Hughes module, a Sami module whose parts are not wired, or a rainfall year missing), and
 * `NetworkError` naming the module when a simulator throws or breaks the
 * contract (a series of the wrong length).
 *
 * The result has a series for **every** `.NET` route, each `monthCount`
 * long: what the module that controls it put on it, the defined flow of a
 * zero-source route, or zeros (a route leaving an unsolved, mine or
 * unparsed module, or an irrigation module in natural mode; R3-N7).
 *
 * An irrigation module is solved in two passes (R7-I2): at its place in the
 * list it puts its demand on the abstraction route; once the supplier has
 * solved, it settles against what the route carries and puts its return flow
 * on the return route. Demand never depends on supply and a return can't
 * reach back to the supplier (validation), so nothing needs iterating.
 */
export function runNetwork(bundle: NetworkBundle, mode: RunMode, options: RunNetworkOptions): RunResult {
	const validation = validateNetwork(bundle);
	if (validation.some((m) => m.level === 'error')) throw new NetworkError(validation);

	const { network } = bundle;
	const { startYear, endYear } = network;
	const length = monthCount(startYear, endYear);
	const placed = placeModules(bundle);
	const messages: RunMessage[] = [...validation];
	const flows = new Map<number, MonthlySeries>();
	const reservoirStorage: Record<number, MonthlySeries> = {};
	const runoff: Record<number, RunoffDiagnostics> = {};
	const irrigation: Record<number, IrrigationDiagnostics> = {};
	const pending: PendingIrrigation[] = [];
	const demandStream = new Map<number, MonthlySeries>(); // the routes' demand stream (TT 689 p.84)
	const generated = new Map<number, MonthlySeries>(); // each solved runoff module's own runoff
	const totalReturn = totalReturnBlocks(bundle); // RU number → the blocks whose 'total' return flow takes its area (R7-I13)
	const virginMarMm3: Record<number, number> = {};
	const parents = sfrParents(bundle);
	const groups = new Map<number, PlacedGroup>();
	const runoffOptions = {
		...(options.pitman ? { pitman: options.pitman } : {}),
		...(options.sami ? { sami: options.sami } : {}),
		...(options.samiParts ? { samiParts: options.samiParts } : {})
	};
	/** A parent's group, run the first time the parent or any child is met (TT 689 p.135), then cached. */
	const groupOf = (p: PlacedModule, parent: RunoffModule): PlacedGroup => {
		let g = groups.get(parent.number);
		if (!g) {
			const targets = { ...SFR_TARGETS, ...options.sfr?.targets };
			g = guard(p, () => runGroup(bundle, parent, mode, startYear, endYear, runoffOptions, { ...options.sfr, targets }));
			groups.set(parent.number, g);
			messages.push(...g.result.messages);
			Object.assign(virginMarMm3, g.result.virginMarMm3);
		}
		return g;
	};
	const ctx: ModuleRunContext = {
		mode,
		startYear,
		endYear,
		rainfall: (fileName) => lookupFile(bundle.rainfall, fileName),
		flowFile: (fileName) => lookupFile(bundle.flowFiles, fileName)
	};

	// Routes from the zero module carry the defined flow their downstream module names (TT 689 p.xv).
	for (const route of network.routes) {
		if (route.upstreamPosition !== 0) continue;
		const down = placed[route.downstreamPosition - 1]!;
		const fileName = definedFileOn(down.module, route.number, 'in');
		const file = fileName ? lookupFile(bundle.flowFiles, fileName) : undefined;
		if (!file) continue; // an unparsed downstream module (warned by validation): zeros below
		const result = guard(down, () => definedFlowSeries(file, mode, startYear, endYear));
		flows.set(route.number, result.series);
		for (const m of result.messages) messages.push({ ...m, route: m.route ?? route.number });
	}

	/** QC (TT 690 eq. 4.18) for a WQT block: the runoff per unit pervious area of the module it lies in (R7-I12). */
	const unitRunoff = (rr: PendingIrrigation): readonly number[] | undefined => {
		const { module, p } = rr;
		if (module.layout === 'pitman' || rr.demand.modelType === 1 || rr.demand.modelType === 4 || !module.runoffModule) return undefined;
		const ru = bundle.modules.find((m): m is RunoffModule => m.kind === 'RU' && m.number === module.runoffModule);
		const own = generated.get(module.runoffModule);
		if (!ru || !own) {
			const why = ru ? 'has not been solved yet; list it above the supplier' : 'is not in the network';
			messages.push({ level: 'warning', module: p.ref, text: `${placedLabel(p)}: runoff module RU ${module.runoffModule} (L.013) ${why}, so no catchment runoff passes through the block (R7-I12)` });
			return undefined;
		}
		const paved = pavedFractionByMonth(ru, mode, startYear, endYear).fraction;
		const pavedFlow = runoff[ru.number]?.pavedFlow?.values;
		return own.values.map((v, t) => {
			const pervious = ru.areaKm2 * (1 - paved[t]!);
			return pervious > 0 ? (Math.max(0, v - (pavedFlow?.[t] ?? 0)) * 1000) / pervious : 0;
		});
	};
	/** Settle every block whose abstraction route now has a flow; `force` settles the rest on no supply. A settled block's return may feed another block. */
	const settleReady = (force = false): void => {
		for (let k = 0; k < pending.length; ) {
			const rr = pending[k]!;
			const supply = flows.get(rr.module.abstractionRoute);
			if (!supply && !force) {
				k++;
				continue;
			}
			pending.splice(k, 1);
			const { module, p, demand } = rr;
			const settled = guard(p, () => settleIrrigation(module, demand, supply?.values ?? zeroSeries(startYear, endYear).values, unitRunoff(rr)));
			messages.push(...settled.messages);
			if (module.returnFlowRoute) flows.set(module.returnFlowRoute, settled.returnFlow);
			irrigation[module.number] = {
				demand: demand.gross,
				supply: settled.supply,
				application: settled.application,
				returnFlow: settled.returnFlow,
				evapotranspiration: settled.evapotranspiration,
				soilMoistureMm: settled.soilMoistureMm,
				areaKm2: demand.areaKm2,
				effectiveAreaKm2: settled.effectiveAreaKm2
			};
			k = 0;
		}
	};

	const dependencies = networkDependencies(bundle, placed);
	for (const d of dependencies) {
		if (d.kind !== 'returnFlow' || d.before < d.after) continue;
		const [supplier, target] = [placed[d.before - 1]!, placed[d.after - 1]!];
		messages.push({ level: 'info', route: d.route, text: `${placedLabel(supplier)} is solved ahead of ${placedLabel(target)}, which takes the return flow on route ${d.route} from an irrigation module ${placedLabel(supplier)} supplies (R7-I2)` });
	}

	for (const p of solveOrder(placed, dependencies)) {
		const module = p.module!; // validation guarantees a file per entry
		const leaving = network.routes.filter((r) => r.upstreamPosition === p.position).map((r) => r.number);
		if (!p.entry.solve) {
			messages.push({ level: 'info', module: p.ref, text: `${placedLabel(p)} is not solved (Solve = N in ${network.code}.NET); its outflow routes carry zero` });
			for (const route of leaving) flows.set(route, zeroSeries(startYear, endYear));
			continue;
		}
		switch (module.kind) {
			case 'RU': {
				// An SFR parent or child runs with its group (R6-F…, docs/theory/afforestation.md); a free module on its own, with the reductions.
				const parent = (module.sfrChildren?.length ?? 0) > 0 ? module : parents.get(module.number);
				let result: { outflow: MonthlySeries; diagnostics: RunoffDiagnostics };
				if (parent) {
					result = groupOf(p, parent).members.get(module.number)!;
				} else {
					const free = runRunoff(p, module, bundle, mode, options);
					messages.push(...free.messages);
					if (free.virginMarMm3 !== undefined) virginMarMm3[module.number] = free.virginMarMm3;
					result = free;
				}
				runoff[module.number] = result.diagnostics;
				generated.set(module.number, result.outflow);
				const inflow = module.inflowRoute ? flows.get(module.inflowRoute)!.values : undefined;
				// R7-I13: a block with 'total' return flows takes its area out of the module (TT 689 p.106).
				const taken = mode.kind === 'natural' ? [] : (totalReturn.get(module.number) ?? []);
				const total = result.outflow.values.map((v, i) => {
					const year = startYear + Math.floor(i / 12);
					const share = taken.reduce((s, rr) => s + irrigatedAreaKm2(rr, mode, year), 0) / module.areaKm2;
					return v * (1 - Math.min(1, share)) + (inflow ? inflow[i]! : 0);
				});
				for (const o of module.outflows) {
					// TT 689 p.xvi (c): "fixed proportions of the total runoff along various routes"; TT 691 L.020.
					const share = o.percent / 100;
					flows.set(o.route, series(startYear, total.map((v) => v * share)));
				}
				break;
			}
			case 'RV':
			case 'CR': {
				const inflows: Record<number, MonthlySeries> = {};
				for (const c of module.inflows) {
					// A route with a defined-flow file is read by the simulator from `ctx.flowFile` (contract.ts).
					if (c.definedFlowFile) continue;
					const route = network.routes.find((r) => r.number === c.route)!;
					if (route.upstreamPosition === 0) continue;
					inflows[c.route] = flows.get(c.route)!;
				}
				// R7-I19: a route the supplier defines by file keeps the file; the block takes what it brings.
				const demands: Record<number, MonthlySeries> = {};
				for (const o of module.outflows) {
					const demand = demandStream.get(o.route);
					if (!demand) continue;
					if (o.definedFlowFile === null) demands[o.route] = demand;
					else messages.push({ level: 'info', module: p.ref, route: o.route, text: `${placedLabel(p)}: irrigation route ${o.route} is defined by '${o.definedFlowFile}', so it carries that flow, not the block's demand (R7-I19)` });
				}
				const result: ModuleRunResult = guard(p, () =>
					module.kind === 'RV' ? options.simulators.reservoir(module, inflows, ctx, demands) : options.simulators.channel(module, inflows, ctx, demands)
				);
				for (const m of result.messages) messages.push(m.module ? m : { ...m, module: p.ref });
				takeOutflows(p, leaving, result.outflows, length, flows, messages);
				if (result.storage) {
					checkLength(p, 'storage', result.storage, length);
					if (module.kind === 'RV') reservoirStorage[module.number] = result.storage;
				}
				break;
			}
			case 'RR': {
				if (mode.kind === 'natural') {
					// D1: no irrigation. Nothing goes on the demand stream, and the return route carries zero below.
					messages.push({ level: 'info', module: p.ref, text: `${placedLabel(p)}: irrigation is removed in natural mode; its return-flow route carries zero` });
					break;
				}
				const demand = guard(p, () => irrigationDemand(module, lookupFile(bundle.rainfall, module.rainfallFile), mode, startYear, endYear, options.irrigation));
				messages.push(...demand.messages);
				demandStream.set(module.abstractionRoute, demand.gross);
				pending.push({ p, module, demand });
				break;
			}
			case 'unparsed':
				// R3-N7: a module the engine can't read (a mine, or an unknown file version).
				messages.push({
					level: 'warning',
					module: p.ref,
					text: `${placedLabel(p)} is not simulated (${module.reason}); ${leaving.length > 0 ? `routes ${leaving.join(', ')} carry` : 'it has no outflow routes, so it sends'} zero (R3-N7)`
				});
				break;
		}
		// Whatever the module didn't put a flow on (unparsed, a route a simulator left out) carries zero; a waiting block's return route waits with it.
		const waiting = new Set(pending.map((rr) => rr.module.returnFlowRoute));
		for (const route of leaving) if (!flows.has(route) && !waiting.has(route)) flows.set(route, zeroSeries(startYear, endYear));
		settleReady();
	}
	settleReady(true); // a block no solved module supplied gets nothing

	const routeFlows: Record<number, MonthlySeries> = {};
	for (const route of network.routes) routeFlows[route.number] = flows.get(route.number) ?? zeroSeries(startYear, endYear);
	return {
		mode,
		startYear,
		endYear,
		routeFlows,
		reservoirStorage,
		runoff,
		...(Object.keys(irrigation).length > 0 ? { irrigation } : {}),
		...(Object.keys(virginMarMm3).length > 0 ? { virginMarMm3 } : {}),
		messages
	};
}

/**
 * The order modules are solved in: the list (R3-N3), except that a supplier
 * moves ahead of a module that takes its block's return flow (R3-N22, R7-I2).
 * That module may sit earlier in the list on another branch, and a return flow
 * isn't known until the supply is. Stable, and the list itself when no such
 * case exists; validation has already ruled out cycles.
 */
function solveOrder(placed: readonly PlacedModule[], dependencies: readonly Dependency[]): readonly PlacedModule[] {
	if (!dependencies.some((d) => d.kind === 'returnFlow' && d.before > d.after)) return placed;
	const left = [...placed];
	const order: PlacedModule[] = [];
	while (left.length > 0) {
		const ready = (p: PlacedModule) => !dependencies.some((d) => d.after === p.position && left.some((q) => q.position === d.before));
		const k = Math.max(0, left.findIndex(ready));
		order.push(...left.splice(k, 1));
	}
	return order;
}

/** Blocks with 'total' return flows (L.014 v2 = 0) by the runoff module they lie in. Types 2 and 3 only: type 4 is always net (R7-I13). */
function totalReturnBlocks(bundle: NetworkBundle): ReadonlyMap<number, readonly IrrigationModule[]> {
	const out = new Map<number, IrrigationModule[]>();
	for (const m of bundle.modules) {
		if (m.kind !== 'RR' || m.layout === 'pitman' || m.netReturnFlows || !m.runoffModule) continue;
		if (m.modelType !== 2 && m.modelType !== 3) continue;
		out.set(m.runoffModule, [...(out.get(m.runoffModule) ?? []), m]);
	}
	return out;
}

function series(startYear: number, values: number[]): MonthlySeries {
	return { startYear, values, unit: 'Mm3' };
}

function runRunoff(p: PlacedModule, module: RunoffModule, bundle: NetworkBundle, mode: RunMode, options: RunNetworkOptions) {
	const { startYear, endYear } = bundle.network;
	const messages: RunMessage[] = [];
	const specials: RunMessage[] = [];
	const applied = applyRunMode(module, mode);
	// TT 689 p.142: paved data must cover the whole simulation period, or the module warns.
	const paved = applied.paved?.fraction ?? [];
	if (mode.kind === 'historical' && paved.length > 0 && (paved[0]!.year > startYear || paved[paved.length - 1]!.year < endYear)) {
		messages.push({ level: 'warning', module: p.ref, text: `${placedLabel(p)}: paved-area years ${paved[0]!.year}–${paved[paved.length - 1]!.year} don't cover the run ${startYear}–${endYear}; held flat beyond them (TT 689 p.142; OQ-17)` });
	}
	// R6-P3: afforestation + alien vegetation + paved area against AREA, year by year (TT 689 p.127; TT 691 p.63 RU_SPECIAL_AREA).
	for (let y = startYear; y <= endYear; y++) specials.push(...specialAreaMessages(applied, y, [], mode));
	messages.push(...collapseYears(specials));
	const rainfall = lookupFile(bundle.rainfall, module.rainfallFile)!; // validated
	const result = runRunoffModule(applied, rainfall, {
		startYear,
		endYear,
		mode,
		parent: null,
		...(options.pitman ? { pitman: options.pitman } : {}),
		...(options.sami ? { sami: options.sami } : {}),
		...(options.samiParts ? { samiParts: options.samiParts } : {}),
		...(options.reductions ? { reductions: options.reductions } : {})
	});
	return { ...result, messages: [...messages, ...result.messages] };
}

/** Run a simulator (or a defined-flow read), turning a plain error into a `NetworkError` naming the module. */
function guard<T>(p: PlacedModule, run: () => T): T {
	try {
		return run();
	} catch (error) {
		if (error instanceof NetworkError || error instanceof PitmanRunError) throw error;
		const text = `${placedLabel(p)}: ${error instanceof Error ? error.message : String(error)}`;
		throw new NetworkError([{ level: 'error', module: p.ref, text }], { cause: error });
	}
}

function checkLength(p: PlacedModule, what: string, s: MonthlySeries, length: number): void {
	if (s.values.length !== length) {
		throw new NetworkError([{ level: 'error', module: p.ref, text: `${placedLabel(p)}: simulator returned ${what} with ${s.values.length} months; the run has ${length}` }]);
	}
}

/**
 * Keep a simulator's outflows on the routes that leave its module in the
 * `.NET`; a route it leaves out carries zero (warned), a route it returns
 * that doesn't leave it is ignored (warned).
 */
function takeOutflows(
	p: PlacedModule,
	leaving: readonly number[],
	outflows: RouteFlows,
	length: number,
	flows: Map<number, MonthlySeries>,
	messages: RunMessage[]
): void {
	for (const route of leaving) {
		const s = outflows[route];
		if (!s) {
			messages.push({ level: 'warning', module: p.ref, route, text: `${placedLabel(p)}: the simulator returned nothing for outflow route ${route}; it carries zero` });
			continue;
		}
		checkLength(p, `route ${route}`, s, length);
		flows.set(route, s);
	}
	for (const key of Object.keys(outflows)) {
		const route = Number(key);
		if (!leaving.includes(route)) {
			messages.push({ level: 'warning', module: p.ref, route, text: `${placedLabel(p)}: the simulator returned route ${route}, which doesn't leave ${moduleLabel(p.ref)} in the network; ignored` });
		}
	}
}

