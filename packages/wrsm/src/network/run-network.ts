/**
 * `runNetwork()`: solve a whole network in one run mode.
 *
 * Modules are solved one at a time over the whole record, in `.NET` order
 * (R3-1), after `validateNetwork` has passed. Runoff modules run on
 * `runRunoffModule`; reservoirs and channels on the injected simulators
 * (`ModuleSimulators`, `contract.ts`). Spec: docs/theory/network.md §6.
 */

import type { SamiOptionsInput, SamiRunParts } from '../groundwater/sami/index.js';
import type { StreamflowReduction } from '../landuse/contract.js';
import type { ChildTargetModel, SfrOptions } from '../landuse/sfr.js';
import { SFR_TARGETS } from '../runoff/wiring.js';
import { collapseYears, specialAreaMessages } from '../landuse/paved.js';
import { PitmanRunError, runRunoffModule, type PitmanOptions } from '../runoff/pitman.js';
import type {
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
import { NetworkError, validateNetwork } from './validate.js';

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
 * zero-source route, or zeros (a route leaving an unsolved, irrigation,
 * mine or unparsed module; R3-N6, R3-N7).
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

	for (const p of placed) {
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
				const inflow = module.inflowRoute ? flows.get(module.inflowRoute)!.values : undefined;
				const total = result.outflow.values.map((v, i) => v + (inflow ? inflow[i]! : 0));
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
				const result: ModuleRunResult = guard(p, () =>
					module.kind === 'RV' ? options.simulators.reservoir(module, inflows, ctx) : options.simulators.channel(module, inflows, ctx)
				);
				for (const m of result.messages) messages.push(m.module ? m : { ...m, module: p.ref });
				takeOutflows(p, leaving, result.outflows, length, flows, messages);
				if (result.storage) {
					checkLength(p, 'storage', result.storage, length);
					if (module.kind === 'RV') reservoirStorage[module.number] = result.storage;
				}
				break;
			}
			case 'RR':
				// R3-N6: irrigation is simulated from Round 7; until then it demands and returns nothing.
				messages.push(
					mode.kind === 'natural'
						? { level: 'info', module: p.ref, text: `${placedLabel(p)}: irrigation is removed in natural mode; its return-flow route carries zero` }
						: { level: 'warning', module: p.ref, text: `${placedLabel(p)}: irrigation is not simulated yet (Round 7); it demands nothing and its return-flow route carries zero (R3-N6)` }
				);
				break;
			case 'unparsed':
				// R3-N7: a module the engine can't read (a mine, or an unknown file version).
				messages.push({
					level: 'warning',
					module: p.ref,
					text: `${placedLabel(p)} is not simulated (${module.reason}); ${leaving.length > 0 ? `routes ${leaving.join(', ')} carry` : 'it has no outflow routes, so it sends'} zero (R3-N7)`
				});
				break;
		}
		// Whatever the module didn't put a flow on (irrigation, unparsed, a route a simulator left out) carries zero.
		for (const route of leaving) if (!flows.has(route)) flows.set(route, zeroSeries(startYear, endYear));
	}

	const routeFlows: Record<number, MonthlySeries> = {};
	for (const route of network.routes) routeFlows[route.number] = flows.get(route.number) ?? zeroSeries(startYear, endYear);
	return { mode, startYear, endYear, routeFlows, reservoirStorage, runoff, ...(Object.keys(virginMarMm3).length > 0 ? { virginMarMm3 } : {}), messages };
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

