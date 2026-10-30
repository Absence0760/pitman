/**
 * Attaching a demand file to the network (docs/formats.md §12): a defined-flow
 * file on a reservoir or channel outflow route, named after the route
 * (`SYRQ11.abs`), its inputs in the sidecar (`demands`, and `values` for where
 * each came from, issue #3 rule 8).
 *
 * `planDemand` works out everything an apply would do without changing the
 * bundle, so the screen previews the plan and applies that same plan: what is
 * on screen is what gets written.
 *
 * Which routes can take a file (`demandTargets`, R7-X3): an outflow route of a
 * parsed RV or CR that isn't its spill or principal route, a wetland or
 * diversion route, a `'*'` monthly abstraction or an irrigation block's
 * abstraction route (whose demand is calculated, TT 689 p.80), and that holds
 * no other file. A module with room can have a new outflow route to the zero
 * sink (TT 689 §2.2; Table 2.1 allows a reservoir 5 outflows, a channel 10).
 */

import { bundleKey, type BundleFileIndex, type LoadedBundle } from '../io/bundle.js';
import { writeDemand } from '../io/demand.js';
import { definedFileOn, moduleLabel, namedRoutes, placeModules, type PlacedModule } from '../network/modules.js';
import type { ChannelModule, DemandSeries, DemandSpec, HydroYear, Module, ModuleRef, NetworkBundle, ReservoirModule, Route, Sidecar, ValueSource } from '../types.js';
import { demandFileYears, demandSpecProblems, demandYearChecks, generateDemandSeries, sortedGrowth, type DemandYearCheck } from './generate.js';

/** TT 689 Table 2.1 (p.5): outflow routes per module. */
const OUTFLOW_LIMIT = { RV: 5, CR: 10 } as const;
/** Route numbers run 1–9999 (docs/formats.md §4). */
const MAX_ROUTE = 9999;

/** A plan that can't be carried out; the message is written for the user. */
export class DemandError extends Error {
	override readonly name = 'DemandError';
}

/** Where a demand goes: an outflow route the module has, or a new one to the zero sink. */
export type DemandTarget =
	| { readonly kind: 'route'; readonly module: ModuleRef; readonly route: number }
	| { readonly kind: 'newRoute'; readonly module: ModuleRef };

export interface DemandRouteOption {
	readonly route: number;
	/** Where it ends: `the zero sink`, `CR 4`. */
	readonly to: string;
	/** Why it can't take a demand, in words; `null` when it can. */
	readonly blocked: string | null;
}

export interface DemandModuleOption {
	readonly module: ModuleRef;
	readonly name: string;
	/** False when the `.NET` says Solve = N: the module's routes carry nothing. */
	readonly solved: boolean;
	readonly routes: readonly DemandRouteOption[];
	/** The number a new outflow route would take; `null` when one can't be added. */
	readonly newRoute: number | null;
	/** Why not, in words; `null` when one can. */
	readonly newRouteBlocked: string | null;
}

type RoutedModule = ReservoirModule | ChannelModule;

const isRouted = (m: Module | undefined): m is RoutedModule => m?.kind === 'RV' || m?.kind === 'CR';

function endLabel(placed: readonly PlacedModule[], position: number, zero: string): string {
	const p = placed[position - 1];
	return p === undefined ? zero : moduleLabel(p.ref);
}

function specialRole(module: RoutedModule, route: number): string | null {
	if (module.kind === 'RV') return route === module.spillRoute ? 'the spill route' : null;
	if (route === module.principalOutflowRoute) return 'the principal outflow route';
	if (route === module.localWetlandInflowRoute || route === module.localWetlandOutflowRoute) return 'a wetland route';
	return route === module.diversionRoute ? 'the diversion route' : null;
}

/** The file a module reads a route from, when it names one: abstracting from the same route wouldn't balance. */
function inflowFile(module: Module | undefined, route: number): string | undefined {
	return module !== undefined && isRouted(module) ? definedFileOn(module, route, 'in') : undefined;
}

function routeOption(module: RoutedModule, route: Route, placed: readonly PlacedModule[]): DemandRouteOption {
	const down = placed[route.downstreamPosition - 1];
	const file = definedFileOn(module, route.number, 'out');
	const role = specialRole(module, route.number);
	let blocked: string | null = null;
	if (role !== null) blocked = `it is ${role}`;
	else if (file === '*') blocked = 'it has a monthly defined abstraction';
	else if (file !== undefined) blocked = `it already carries ${file.trim()}`;
	else if (inflowFile(down?.module, route.number) !== undefined) blocked = `the module it reaches reads this route from ${inflowFile(down?.module, route.number)?.trim()}`;
	else if (down?.entry.type === 'RR') blocked = `it feeds irrigation ${moduleLabel(down.ref)}, which sets its own demand`;
	return { route: route.number, to: endLabel(placed, route.downstreamPosition, 'the zero sink'), blocked };
}

/** Every reservoir, then every channel reach, by number, with the routes a demand can go on. */
export function demandTargets(bundle: NetworkBundle): DemandModuleOption[] {
	const placed = placeModules(bundle);
	const routes = new Map(bundle.network.routes.map((r) => [r.number, r]));
	const nextRoute = Math.max(0, ...bundle.network.routes.map((r) => r.number)) + 1;
	const options: DemandModuleOption[] = [];
	for (const p of placed) {
		const { module } = p;
		if (!isRouted(module)) continue;
		const outs = new Set((namedRoutes(module) ?? []).filter((n) => n.direction === 'out').map((n) => n.route));
		const limit = OUTFLOW_LIMIT[module.kind];
		const blocked = outs.size >= limit ? `${moduleLabel(p.ref)} already has ${outs.size} outflow routes, WRSM2000's limit (TT 689 Table 2.1)` : nextRoute > MAX_ROUTE ? `route numbers stop at ${MAX_ROUTE}` : null;
		options.push({
			module: p.ref,
			name: module.name.trim(),
			solved: p.entry.solve,
			routes: module.outflows.flatMap((o) => {
				const route = routes.get(o.route);
				return route === undefined ? [] : [routeOption(module, route, placed)];
			}),
			newRoute: blocked === null ? nextRoute : null,
			newRouteBlocked: blocked
		});
	}
	const order = (type: string) => (type === 'RV' ? 0 : 1);
	return options.sort((a, b) => order(a.module.type) - order(b.module.type) || a.module.number - b.module.number);
}

function fileIndex(bundle: NetworkBundle): BundleFileIndex | undefined {
	return (bundle as Partial<LoadedBundle>).files;
}

/**
 * The name for a new file on `route`: `<net>RQ<route>.abs` (§12). A file of
 * that name already in the folder, even one nothing reads, is never
 * overwritten: the new one takes `-2`, `-3`, ….
 */
export function demandFileName(bundle: NetworkBundle, route: number): string {
	const files = fileIndex(bundle);
	const root = files?.root ?? '';
	const taken = new Set([...Object.keys(bundle.flowFiles), ...Object.keys(files?.other ?? {}), ...Object.keys(files?.sources ?? {})].map((n) => n.toUpperCase()));
	const stem = `${bundle.network.code}RQ${route}`;
	for (let k = 1; ; k++) {
		const name = `${stem}${k === 1 ? '' : `-${k}`}.abs`;
		if (!taken.has(name.toUpperCase()) && !taken.has(`${root}${name}`.toUpperCase())) return name;
	}
}

/** Every `flowFiles` key of one file: names that resolve to it share a record (`NetworkBundle`). `key` first. */
export function demandFileKeys(bundle: NetworkBundle, key: string): string[] {
	const paths = fileIndex(bundle)?.flowFiles;
	const path = paths?.[key];
	const record = bundle.flowFiles[key];
	const same = (k: string) => bundle.flowFiles[k] === record || (path !== undefined && paths?.[k] === path);
	return [key, ...Object.keys(bundle.flowFiles).filter((k) => k !== key && same(k))];
}

/** One route that reads a file. */
export interface DemandAttachment {
	readonly module: ModuleRef;
	readonly name: string;
	readonly route: number;
	/** `out`: the module's outflow, a demand. `in`: a defined inflow to it. */
	readonly direction: 'in' | 'out';
	/** The route's other end: `the zero sink`, `the zero source`, `CR 4`. */
	readonly other: string;
}

/** The routes that read `key`'s file. */
export function demandAttachments(bundle: NetworkBundle, key: string): DemandAttachment[] {
	const placed = placeModules(bundle);
	const keys = new Set(demandFileKeys(bundle, key));
	const routes = new Map(bundle.network.routes.map((r) => [r.number, r]));
	const reads = (name: string | null) => name !== null && name !== '*' && keys.has(bundleKey(name));
	const out: DemandAttachment[] = [];
	for (const p of placed) {
		const { module } = p;
		if (!isRouted(module)) continue;
		const add = (route: number, direction: 'in' | 'out') => {
			const r = routes.get(route);
			const other = direction === 'in' ? endLabel(placed, r?.upstreamPosition ?? 0, 'the zero source') : endLabel(placed, r?.downstreamPosition ?? 0, 'the zero sink');
			out.push({ module: p.ref, name: module.name.trim(), route, direction, other });
		};
		for (const c of module.outflows) if (reads(c.definedFlowFile)) add(c.route, 'out');
		for (const c of module.inflows) if (reads(c.definedFlowFile)) add(c.route, 'in');
	}
	return out;
}

/** The sidecar's spec of a file, under whichever of its names it was recorded. */
export function demandSpecOf(bundle: NetworkBundle, key: string): DemandSpec | undefined {
	const specs = bundle.sidecar?.demands;
	if (specs === undefined) return undefined;
	const hit = demandFileKeys(bundle, key).find((k) => Object.hasOwn(specs, k));
	return hit === undefined ? undefined : specs[hit];
}

/** Where a spec's values came from (issue #3 rule 8). */
export interface DemandSources {
	readonly annualVolume: ValueSource;
	/** The 12 shares are one set: they sum to 100, and are sourced together. */
	readonly monthlyDistribution: ValueSource;
	/** By the growth table's year. */
	readonly growth: Readonly<Record<number, ValueSource>>;
}

/** The `sidecar.values` fields a file's demand entries use. */
const VALUE_FIELDS = ['annualVolumeMm3', 'monthlyDistributionPercent', 'growth'];

/** What the sidecar says about a file's values, as far as it says anything. */
export function demandSourcesOf(bundle: NetworkBundle, key: string): Partial<DemandSources> & Pick<DemandSources, 'growth'> {
	const keys = new Set(demandFileKeys(bundle, key));
	const entries = (bundle.sidecar?.values ?? []).filter((v) => v.target.file !== undefined && keys.has(v.target.file));
	const one = (field: string) => entries.find((v) => v.target.field === field)?.source;
	const annualVolume = one('annualVolumeMm3');
	const monthlyDistribution = one('monthlyDistributionPercent');
	const growth: Record<number, ValueSource> = {};
	for (const v of entries) if (v.target.field === 'growth' && v.target.year !== undefined) growth[v.target.year] = v.source;
	return { ...(annualVolume !== undefined && { annualVolume }), ...(monthlyDistribution !== undefined && { monthlyDistribution }), growth };
}

export interface DemandRequest {
	readonly spec: DemandSpec;
	readonly sources: DemandSources;
	/** The file this replaces, by `flowFiles` key. Absent: a new file. */
	readonly file?: string;
	/** Where it goes. Needed for a new file; for an existing one, it moves off the one route it is on. */
	readonly target?: DemandTarget;
}

/** Everything an apply would do. */
export interface DemandPlan {
	readonly request: DemandRequest;
	/** The file's key after the apply. */
	readonly key: string;
	readonly fileName: string;
	readonly series: DemandSeries;
	/** The file's text, as a save writes it. */
	readonly text: string;
	readonly firstYear: HydroYear;
	readonly lastYear: HydroYear;
	/** Asked against written, per year. */
	readonly years: readonly DemandYearCheck[];
	/** The route the file goes onto; absent when it stays where it is. */
	readonly attach?: { readonly module: ModuleRef; readonly moduleName: string; readonly route: number; readonly newRoute: boolean };
	/** The route it comes off, when it moves. */
	readonly detach?: DemandAttachment;
	/** The old name, when a move renames the file after its new route. */
	readonly renamedFrom?: string;
}

function resolveTarget(bundle: NetworkBundle, target: DemandTarget) {
	const label = moduleLabel(target.module);
	const option = demandTargets(bundle).find((o) => o.module.type === target.module.type && o.module.number === target.module.number);
	if (option === undefined) throw new DemandError(`${label} is not a reservoir or channel reach in this network`);
	if (target.kind === 'newRoute') {
		if (option.newRoute === null) throw new DemandError(`A new route can't be added: ${option.newRouteBlocked ?? 'no room'}`);
		return { option, route: option.newRoute, newRoute: true };
	}
	const route = option.routes.find((r) => r.route === target.route);
	if (route === undefined) throw new DemandError(`Route ${target.route} is not an outflow of ${label}`);
	if (route.blocked !== null) throw new DemandError(`Route ${target.route} can't take a demand: ${route.blocked}`);
	return { option, route: target.route, newRoute: false };
}

/**
 * Work out an apply. Throws `DemandError` (written for the user) when it can't
 * be done, `RangeError` when a month doesn't fit the file's format.
 */
export function planDemand(bundle: NetworkBundle, request: DemandRequest): DemandPlan {
	const spec: DemandSpec = { ...request.spec, growth: sortedGrowth(request.spec.growth) };
	const problems = demandSpecProblems(spec);
	if (problems.length > 0) throw new DemandError(`This demand can't be generated: ${problems.join('; ')}`);
	const { file, target } = request;
	const existing = file === undefined ? undefined : bundle.flowFiles[file];
	if (file !== undefined && existing === undefined) throw new DemandError(`${file} is not a file of this network`);
	// A gauge can read this file as its observed flow (§11.5): two records of one file can't be written differently.
	if (file !== undefined && bundle.observed[file] !== undefined) throw new DemandError(`${existing?.fileName.trim()} is also a gauge's observed flow, so a generated demand can't replace it. Create a new demand file for this route instead.`);

	const resolved = target === undefined ? undefined : resolveTarget(bundle, target);
	if (existing === undefined && resolved === undefined) throw new DemandError('Choose the reservoir or channel reach this demand comes off');
	let detach: DemandAttachment | undefined;
	let fileName = existing?.fileName ?? demandFileName(bundle, resolved!.route);
	let key = file ?? bundleKey(fileName);
	let renamedFrom: string | undefined;
	if (existing !== undefined && resolved !== undefined) {
		const attachments = demandAttachments(bundle, key);
		const only = attachments[0];
		if (attachments.length !== 1 || only?.direction !== 'out') throw new DemandError(`${existing.fileName.trim()} can only move when one outflow route, and nothing else, reads it`);
		detach = only;
		if (new RegExp(`^${bundle.network.code}RQ${only.route}(-\\d+)?\\.`, 'i').test(existing.fileName.trim())) {
			renamedFrom = existing.fileName;
			fileName = demandFileName(bundle, resolved.route);
			key = bundleKey(fileName);
		}
	}

	const { firstYear, lastYear } = demandFileYears(spec, bundle.network);
	const series = generateDemandSeries(spec, { fileName, firstYear, lastYear });
	return {
		request: { ...request, spec },
		key,
		fileName,
		series,
		text: writeDemand(series),
		firstYear,
		lastYear,
		years: demandYearChecks(spec, series.rows),
		...(resolved !== undefined && { attach: { module: resolved.option.module, moduleName: resolved.option.name, route: resolved.route, newRoute: resolved.newRoute } }),
		...(detach !== undefined && { detach }),
		...(renamedFrom !== undefined && { renamedFrom })
	};
}

function sourceEntries(key: string, spec: DemandSpec, sources: DemandSources): NonNullable<Sidecar['values']> {
	return [
		{ target: { file: key, field: 'annualVolumeMm3' }, source: sources.annualVolume },
		{ target: { file: key, field: 'monthlyDistributionPercent' }, source: sources.monthlyDistribution },
		...spec.growth.map((g) => ({ target: { file: key, field: 'growth', year: g.year }, source: sources.growth[g.year] ?? sources.annualVolume }))
	];
}

/**
 * The bundle with the plan carried out: the series under every name of the
 * file, the route line, a new `.NET` route if one was asked for, and the spec
 * and its sources in the sidecar. A plan belongs to the bundle it was made from.
 */
export function applyDemand<B extends NetworkBundle>(bundle: B, plan: DemandPlan): B {
	const { request, key, series, attach, detach } = plan;
	const oldKeys = request.file === undefined ? [] : demandFileKeys(bundle, request.file);
	const newName = oldKeys.length === 0 || plan.renamedFrom !== undefined;

	const flowFiles = { ...bundle.flowFiles };
	if (newName) for (const k of oldKeys) delete flowFiles[k];
	for (const k of newName ? [key] : oldKeys) flowFiles[k] = series;

	const isModule = (m: Module, ref: ModuleRef): m is RoutedModule => isRouted(m) && m.kind === ref.type && m.number === ref.number;
	const setFile = (m: RoutedModule, route: number, file: string | null): Module => ({ ...m, outflows: m.outflows.map((o) => (o.route === route ? { ...o, definedFlowFile: file } : o)) });
	let { network, modules } = bundle;
	if (detach !== undefined) {
		modules = modules.map((m) => (isModule(m, detach.module) ? setFile(m, detach.route, null) : m));
	}
	if (attach !== undefined) {
		const { module, route, newRoute } = attach;
		modules = modules.map((m) => {
			if (!isModule(m, module)) return m;
			return newRoute ? { ...m, outflows: [...m.outflows, { route, definedFlowFile: plan.fileName }] } : setFile(m, route, plan.fileName);
		});
		if (newRoute) {
			const position = network.modules.findIndex((e) => e.type === module.type && e.number === module.number) + 1;
			network = { ...network, routes: [...network.routes, { number: route, upstreamPosition: position, downstreamPosition: 0, cost: 0 }] };
		}
	}

	const base: Sidecar = bundle.sidecar ?? { schema: 'pitman-sidecar', schemaVersion: 1 };
	const replaced = new Set([...oldKeys, key]);
	const demands = Object.fromEntries(Object.entries(base.demands ?? {}).filter(([k]) => !replaced.has(k)));
	demands[key] = request.spec;
	const kept = (base.values ?? []).filter((v) => !(v.target.file !== undefined && replaced.has(v.target.file) && VALUE_FIELDS.includes(v.target.field)));
	const sidecar: Sidecar = { ...base, demands, values: [...kept, ...sourceEntries(key, request.spec, request.sources)] };

	const files = fileIndex(bundle);
	if (files === undefined || !newName) return { ...bundle, network, modules, flowFiles, sidecar };
	// A new name keeps its spelling on disk (docs/formats.md §1.3); a renamed file's old path goes with its record.
	const flowPaths = Object.fromEntries(Object.entries(files.flowFiles).filter(([k]) => !oldKeys.includes(k)));
	flowPaths[key] = `${files.root}${plan.fileName}`;
	return { ...bundle, network, modules, flowFiles, sidecar, files: { ...files, flowFiles: flowPaths } };
}
