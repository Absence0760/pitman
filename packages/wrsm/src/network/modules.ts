/**
 * The module list of a network, resolved against the bundle: which module
 * file sits at each `.NET` position, which routes each module names, and
 * the labels messages use. Spec: docs/theory/network.md §§1–3.
 */

import type {
	ChannelModule,
	Module,
	ModuleRef,
	ModuleTypeCode,
	NetworkBundle,
	NetworkModuleEntry,
	ReservoirModule,
	RouteConnection
} from '../types.js';

/** One `.NET` L.008 entry with its module file (when the bundle has it). */
export interface PlacedModule {
	/** 1-based position in the module list (the index routes use, TT 691 §12.6 L.014). */
	readonly position: number;
	readonly entry: NetworkModuleEntry;
	readonly ref: ModuleRef;
	/** `<net><TT><n>.DAT`, the name WRSM2000 looks for (TT 689 §2.3.1 p.6). */
	readonly fileName: string;
	readonly module: Module | undefined;
}

/** The type code a module object stands for. */
export function moduleType(module: Module): ModuleTypeCode {
	return module.kind === 'unparsed' ? module.moduleType : module.kind;
}

/** `RU 12`: how messages name a module (type and external number). */
export function moduleLabel(ref: ModuleRef): string {
	return `${ref.type} ${ref.number}`;
}

/** `RU 12 (SYRU12.DAT)`. */
export function placedLabel(placed: PlacedModule): string {
	return `${moduleLabel(placed.ref)} (${placed.fileName})`;
}

/** Resolve every L.008 entry to its module file, by type and number (numbers are unique per type, TT 689 §2.3.1). */
export function placeModules(bundle: NetworkBundle): PlacedModule[] {
	const byKey = new Map<string, Module>();
	for (const module of bundle.modules) {
		const key = `${moduleType(module)}${module.number}`;
		if (!byKey.has(key)) byKey.set(key, module);
	}
	return bundle.network.modules.map((entry, index) => ({
		position: index + 1,
		entry,
		ref: { type: entry.type, number: entry.number },
		fileName: `${bundle.network.code}${entry.type}${entry.number}.DAT`,
		module: byKey.get(`${entry.type}${entry.number}`)
	}));
}

/** How a module file names one of its routes. */
export interface NamedRoute {
	readonly route: number;
	readonly direction: 'in' | 'out';
	/** What the file calls it, for messages: "outflow route", "spill route", ... */
	readonly role: string;
	/** The defined-flow file on an RV/CR route line (`null` blank = simulated, `'*'` monthly defined abstraction). */
	readonly definedFlowFile?: string | null;
}

const connections = (list: readonly RouteConnection[], direction: 'in' | 'out', role: string): NamedRoute[] =>
	list.map((c) => ({ route: c.route, direction, role, definedFlowFile: c.definedFlowFile }));

/**
 * Every route a parsed module file names, with its direction. `undefined`
 * for an `UnparsedModule`, whose routes the engine can't read.
 *
 * - RU: L.020 outflow routes; L.021 v1 RTIN inflow route (TT 691 §12.1).
 * - RV: L.009 spill route, L.011 inflows, L.013 outflows (TT 691 §12.3).
 * - CR: L.006 principal outflow, L.008 inflows, L.010 outflows, L.014–L.016
 *   local wetland inflow/outflow and diversion routes (TT 691 §12.2).
 * - RR: L.011 abstraction route (in), L.012 return-flow route (out) (TT 691 §12.4).
 *
 * A route listed twice by one file (the RV spill route is also one of its
 * L.013 outflows) appears once per listing; callers compare by number.
 */
export function namedRoutes(module: Module): NamedRoute[] | undefined {
	switch (module.kind) {
		case 'RU': {
			const out: NamedRoute[] = module.outflows.map((o) => ({ route: o.route, direction: 'out', role: 'outflow route (L.020)' }));
			if (module.inflowRoute) out.push({ route: module.inflowRoute, direction: 'in', role: 'upstream inflow route RTIN (L.021)' });
			return out;
		}
		case 'RV':
			return [
				{ route: module.spillRoute, direction: 'out', role: 'spill route (L.009)' },
				...connections(module.inflows, 'in', 'inflow route (L.011)'),
				...connections(module.outflows, 'out', 'outflow route (L.013)')
			];
		case 'CR': {
			const out: NamedRoute[] = [
				{ route: module.principalOutflowRoute, direction: 'out', role: 'principal outflow route (L.006)' },
				...connections(module.inflows, 'in', 'inflow route (L.008)'),
				...connections(module.outflows, 'out', 'outflow route (L.010)')
			];
			if (module.localWetlandInflowRoute) out.push({ route: module.localWetlandInflowRoute, direction: 'in', role: 'local wetland inflow route (L.014)' });
			if (module.localWetlandOutflowRoute) out.push({ route: module.localWetlandOutflowRoute, direction: 'out', role: 'local wetland outflow route (L.015)' });
			if (module.diversionRoute) out.push({ route: module.diversionRoute, direction: 'out', role: 'diversion route (L.016)' });
			return out;
		}
		case 'RR': {
			const out: NamedRoute[] = [{ route: module.abstractionRoute, direction: 'in', role: 'abstraction route (L.011)' }];
			if (module.returnFlowRoute) out.push({ route: module.returnFlowRoute, direction: 'out', role: 'return-flow route (L.012)' });
			return out;
		}
		case 'unparsed':
			return undefined;
	}
}

/**
 * The defined-flow file an RV or CR names on a route line in `direction`,
 * or `undefined` when it names none (blank, or the module isn't RV/CR).
 * `'*'` (monthly defined abstraction, RV outflows only) counts as defined.
 */
export function definedFileOn(module: Module | undefined, route: number, direction: 'in' | 'out'): string | undefined {
	if (!module || (module.kind !== 'RV' && module.kind !== 'CR')) return undefined;
	const list: readonly RouteConnection[] = direction === 'in' ? module.inflows : (module as ReservoirModule | ChannelModule).outflows;
	const file = list.find((c) => c.route === route)?.definedFlowFile;
	return file ?? undefined;
}

/**
 * A file name as a module names it, resolved case-insensitively against a
 * bundle record keyed by upper-cased name (`NetworkBundle`). A name with a
 * folder (`RAIN\MUCH.RAN`, TT 689 §2.3.2.2) falls back to its base name.
 */
export function lookupFile<T>(record: Readonly<Record<string, T>>, fileName: string): T | undefined {
	const get = (key: string) => (Object.hasOwn(record, key) ? record[key] : undefined);
	const upper = fileName.trim().toUpperCase();
	const exact = get(upper);
	if (exact !== undefined) return exact;
	const base = upper.slice(Math.max(upper.lastIndexOf('\\'), upper.lastIndexOf('/')) + 1);
	return base === upper ? undefined : get(base);
}
