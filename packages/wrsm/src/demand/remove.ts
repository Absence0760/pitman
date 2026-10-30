/**
 * Taking a demand or defined-flow file off the network (docs/formats.md §12).
 *
 * As with `planDemand`, `planDemandRemoval` says everything a removal would do
 * without changing the bundle, so the screen shows that plan and applies that
 * same plan.
 *
 * What goes (R7-X9 … R7-X13):
 * - The reference on every route that reads the file, or on the one route asked
 *   for when several share it. The other routes keep the file.
 * - A route from the zero source goes with its reference: a flow from a zero
 *   source must be defined by a file (TT 689 p.xv), so the route can't stay
 *   without one. It is refused when a gauge or a summary line names the route,
 *   or it is the module's wetland inflow.
 * - Any other route stays. An outflow route with no file carries nothing, or
 *   what the module calculates for it, and a new demand can use it.
 * - When no route reads the file any more, its record, its path and its spec
 *   and sources in the sidecar, so a save no longer writes it. A gauge reading
 *   the same file as its observed flow keeps the file in the zip.
 *
 * A file with no spec is one of the network's own: its removal needs a reason
 * and leaves one `demandRemoved` entry in `sidecar.values`, because nothing else
 * in the saved network would say it was ever there (issue #3 rule 8). A file
 * Pitman generated has its spec and leaves nothing behind.
 */

import type { BundleFileIndex, LoadedBundle } from '../io/bundle.js';
import { moduleLabel, placeModules } from '../network/modules.js';
import { validateNetwork } from '../network/validate.js';
import type { ChannelModule, DemandSeries, Module, ModuleRef, NetworkBundle, ReservoirModule, Sidecar, ValueSource } from '../types.js';
import { demandAttachments, demandFileKeys, demandSpecOf, DemandError, type DemandAttachment } from './attach.js';

/** The `sidecar.values` field of a removal. Its note starts `Demand removed: `. */
export const DEMAND_REMOVED_FIELD = 'demandRemoved';
const NOTE_PREFIX = 'Demand removed: ';

/** The `sidecar.values` fields a spec's sources use. */
const SOURCE_FIELDS = new Set(['annualVolumeMm3', 'monthlyDistributionPercent', 'growth']);

type RoutedModule = ReservoirModule | ChannelModule;
const isRouted = (m: Module | undefined): m is RoutedModule => m?.kind === 'RV' || m?.kind === 'CR';
const sameModule = (m: Module, ref: ModuleRef) => isRouted(m) && m.kind === ref.type && m.number === ref.number;

/** One route coming off a file. */
export interface DemandRouteRemoval {
	readonly attachment: DemandAttachment;
	/** What the route does afterwards, in words. */
	readonly effect: string;
	/** The route leaves the `.NET` too (a route from the zero source). */
	readonly routeGoes: boolean;
}

/** Which route to take a shared file off. */
export type DemandRouteChoice = Pick<DemandAttachment, 'module' | 'route' | 'direction'>;

/** Everything a removal would do. */
export interface DemandRemovalPlan {
	readonly key: string;
	readonly fileName: string;
	/** The routes that lose the file. */
	readonly routes: readonly DemandRouteRemoval[];
	/** The routes that keep it, when one route of a shared file is taken off. */
	readonly stays: readonly DemandAttachment[];
	/** No route reads the file afterwards: its record, spec and sources go. */
	readonly fileGoes: boolean;
	/** Why the file itself stays in a saved zip although its record goes. */
	readonly stillInZip: string | null;
	/** A spec and its sources leave `pitman.json`. */
	readonly specGoes: boolean;
	/** The file is the network's own, so the removal needs a reason (issue #3 rule 8). */
	readonly needsReason: boolean;
	/** Why it can't be done, with the way out; nothing changes while this is set. */
	readonly refused: string | null;
}

function fileIndex(bundle: NetworkBundle): BundleFileIndex | undefined {
	return (bundle as Partial<LoadedBundle>).files;
}

/** What a route is to its module, when it is more than an abstraction. */
function routeRole(module: RoutedModule, route: number, direction: 'in' | 'out'): string | null {
	if (module.kind === 'RV') return direction === 'out' && route === module.spillRoute ? 'the spill route' : null;
	// The wetland and diversion routes are ordinary routes unless their feature is active (OQ-CR15).
	const wetland = module.wetlandType === 2;
	if (direction === 'in') return wetland && route === module.localWetlandInflowRoute ? 'the wetland inflow route' : null;
	if (route === module.principalOutflowRoute) return 'the principal outflow route';
	if (wetland && route === module.localWetlandOutflowRoute) return 'the wetland outflow route';
	return module.wetlandType === 3 && route === module.diversionRoute ? 'the diversion route' : null;
}

function routeRemoval(bundle: NetworkBundle, attachment: DemandAttachment): { removal: DemandRouteRemoval; refused: string | null } {
	const { route: number, direction } = attachment;
	const placed = placeModules(bundle);
	const route = bundle.network.routes.find((r) => r.number === number);
	const module = bundle.modules.find((m): m is RoutedModule => sameModule(m, attachment.module));
	const role = module === undefined ? null : routeRole(module, number, direction);
	const stay = (effect: string) => ({ removal: { attachment, effect, routeGoes: false }, refused: null });

	if (direction === 'in') {
		if (route?.upstreamPosition !== 0) return stay(`Route ${number} goes back to carrying what ${attachment.other} sends.`);
		const blocker = zeroRouteBlocker(bundle, number, role);
		const effect = `Route ${number} goes too: a route from the zero source must have a file (TT 689 p.xv).`;
		const refused = blocker === null ? null : `Route ${number} starts at the zero source, so it can’t stay without a file (TT 689 p.xv), and it can’t go because ${blocker}. Change the network in WRSM2000 first.`;
		return { removal: { attachment, effect, routeGoes: true }, refused };
	}
	if (role !== null) return stay(`Route ${number} is ${role}: with no file, a run simulates it again.`);
	const down = route === undefined ? undefined : placed[route.downstreamPosition - 1];
	if (down?.entry.type === 'RR') return stay(`Route ${number} goes back to the demand ${moduleLabel(down.ref)} calculates.`);
	return stay(`Route ${number} stays on ${moduleLabel(attachment.module)} and carries nothing. A new demand can use it.`);
}

function zeroRouteBlocker(bundle: NetworkBundle, route: number, role: string | null): string | null {
	if (role !== null) return `it is ${role}`;
	const gauge = bundle.network.gauges.find((g) => g.route === route);
	if (gauge !== undefined) return `gauge ${gauge.label.trim() === '' ? gauge.observedFile.trim() : gauge.label.trim()} is on it`;
	return bundle.network.summaryLines.some((s) => s.kind === 'RT' && s.number === route) ? 'a summary line reports it' : null;
}

/** Why the file stays in a saved zip once its record has gone. */
function stillInZip(bundle: NetworkBundle, keys: readonly string[]): string | null {
	const index = fileIndex(bundle);
	const paths = new Set(keys.flatMap((k) => index?.flowFiles[k] ?? []));
	const gauge = keys.some((k) => bundle.observed[k] !== undefined) || Object.values(index?.observed ?? {}).some((p) => paths.has(p));
	return gauge ? 'A gauge reads it as its observed flow, so the file stays in the zip.' : null;
}

/**
 * Work out a removal. `only` takes the file off one route and leaves it on the
 * others. Throws `DemandError` when the file or the route isn't there.
 */
export function planDemandRemoval(bundle: NetworkBundle, key: string, only?: DemandRouteChoice): DemandRemovalPlan {
	const series = bundle.flowFiles[key];
	if (series === undefined) throw new DemandError(`${key} is not a file of this network`);
	const attachments = demandAttachments(bundle, key);
	const matches = (a: DemandAttachment) => only === undefined || (a.module.type === only.module.type && a.module.number === only.module.number && a.route === only.route && a.direction === only.direction);
	const taken = attachments.filter(matches);
	if (only !== undefined && taken.length === 0) throw new DemandError(`${series.fileName.trim()} is not on route ${only.route} of ${moduleLabel(only.module)}`);
	const stays = attachments.filter((a) => !matches(a));
	const worked = taken.map((a) => routeRemoval(bundle, a));
	const fileGoes = stays.length === 0;
	const hasSpec = demandSpecOf(bundle, key) !== undefined;
	const plan: DemandRemovalPlan = {
		key,
		fileName: series.fileName.trim(),
		routes: worked.map((w) => w.removal),
		stays,
		fileGoes,
		stillInZip: fileGoes ? stillInZip(bundle, demandFileKeys(bundle, key)) : null,
		specGoes: fileGoes && hasSpec,
		needsReason: !hasSpec,
		refused: worked.find((w) => w.refused !== null)?.refused ?? null
	};
	return plan.refused !== null ? plan : { ...plan, refused: unrunnable(bundle, plan) };
}

/** R7-X14: a defined route adds no solve-order dependency, so taking its file off can leave a network that can't run. */
function unrunnable(bundle: NetworkBundle, plan: DemandRemovalPlan): string | null {
	const errors = (b: NetworkBundle) => validateNetwork(b).filter((m) => m.level === 'error').map((m) => m.text);
	const before = new Set(errors(bundle));
	const added = errors(applyDemandRemoval(bundle, { ...plan, needsReason: false })).find((text) => !before.has(text));
	return added === undefined ? null : `The network couldn’t run without this file: ${added}. Keep the file, or change the module list in WRSM2000 first.`;
}

function removalNote(plan: DemandRemovalPlan, series: DemandSeries, reason: string): string {
	const where = plan.routes.map((r) => {
		const { module, route, direction } = r.attachment;
		return `${direction === 'out' ? 'on' : 'into'} ${moduleLabel(module)} route ${route}`;
	});
	const years = series.rows.map((r) => r.year);
	const total = series.rows.reduce((sum, row) => sum + row.months.reduce((a, b) => a + b, 0), 0);
	const mean = series.rows.length === 0 ? 0 : total / series.rows.length;
	const held = series.rows.length === 0 ? 'no rows' : `${Math.min(...years)} to ${Math.max(...years)}, mean ${mean.toFixed(2)} million m³/a`;
	return `${NOTE_PREFIX}${[plan.fileName, ...where].join(', ')} (${held}); ${reason}`;
}

/** The sidecar after the plan: a file with a spec leaves nothing, the network's own leaves its removal. */
function sidecarAfter(bundle: NetworkBundle, plan: DemandRemovalPlan, keys: ReadonlySet<string>, source: ValueSource | undefined): Sidecar | undefined {
	const base = bundle.sidecar;
	const logged = plan.needsReason ? [{ target: { file: plan.key, field: DEMAND_REMOVED_FIELD }, source: { ...source!, note: removalNote(plan, bundle.flowFiles[plan.key]!, source!.note!.trim()) } }] : [];
	if (base === undefined && logged.length === 0) return undefined;
	const start: Sidecar = base ?? { schema: 'pitman-sidecar', schemaVersion: 1 };
	if (!plan.fileGoes) return logged.length === 0 ? start : { ...start, values: [...(start.values ?? []), ...logged] };
	const { demands: allSpecs, values: allValues, ...rest } = start;
	const demands = Object.fromEntries(Object.entries(allSpecs ?? {}).filter(([k]) => !keys.has(k)));
	const values = [...(allValues ?? []).filter((v) => !(v.target.file !== undefined && keys.has(v.target.file) && SOURCE_FIELDS.has(v.target.field))), ...logged];
	return { ...rest, ...(Object.keys(demands).length > 0 && { demands }), ...(values.length > 0 && { values }) };
}

/** The file index after a file has gone: no path, and no source, so a new file can take the name. */
function filesAfter(files: BundleFileIndex, keys: ReadonlySet<string>): BundleFileIndex {
	const gone = new Set(Object.entries(files.flowFiles).flatMap(([k, path]) => (keys.has(k) ? [path] : [])));
	const flowFiles = Object.fromEntries(Object.entries(files.flowFiles).filter(([k]) => !keys.has(k)));
	const held = new Set([...Object.values(flowFiles), ...Object.values(files.observed), ...Object.values(files.rainfall), ...Object.values(files.modules)]);
	const sources = Object.fromEntries(Object.entries(files.sources).filter(([path]) => !gone.has(path) || held.has(path)));
	return { ...files, flowFiles, sources };
}

/**
 * The bundle with the plan carried out. A plan belongs to the bundle it was
 * made from. `source` carries the reason, and is required when `needsReason`.
 */
export function applyDemandRemoval<B extends NetworkBundle>(bundle: B, plan: DemandRemovalPlan, source?: ValueSource): B {
	if (plan.refused !== null) throw new DemandError(plan.refused);
	if (plan.needsReason && (source?.note ?? '').trim() === '') throw new DemandError(`Say why ${plan.fileName} goes: it is the network’s own file (rule 8)`);

	const keys = new Set(demandFileKeys(bundle, plan.key));
	const goneRoutes = new Set(plan.routes.filter((r) => r.routeGoes).map((r) => r.attachment.route));
	const modules = bundle.modules.map((m) => {
		const own = plan.routes.filter((r) => sameModule(m, r.attachment.module));
		if (own.length === 0 || !isRouted(m)) return m;
		const off = (direction: 'in' | 'out', route: number) => own.some((r) => r.attachment.direction === direction && r.attachment.route === route);
		const clear = <C extends { readonly route: number; readonly definedFlowFile: string | null }>(list: readonly C[], direction: 'in' | 'out'): C[] =>
			list.filter((c) => !(direction === 'in' && goneRoutes.has(c.route))).map((c) => (off(direction, c.route) ? { ...c, definedFlowFile: null } : c));
		return { ...m, inflows: clear(m.inflows, 'in'), outflows: clear(m.outflows, 'out') } as Module;
	});
	const network = goneRoutes.size === 0 ? bundle.network : { ...bundle.network, routes: bundle.network.routes.filter((r) => !goneRoutes.has(r.number)) };

	const flowFiles = plan.fileGoes ? Object.fromEntries(Object.entries(bundle.flowFiles).filter(([k]) => !keys.has(k))) : bundle.flowFiles;
	const sidecar = sidecarAfter(bundle, plan, keys, source);
	const files = fileIndex(bundle);
	return {
		...bundle,
		network,
		modules,
		flowFiles,
		...(sidecar !== undefined && { sidecar }),
		...(plan.fileGoes && files !== undefined && { files: filesAfter(files, keys) })
	};
}

/** One removal `sidecar.values` records. */
export interface DemandRemovalEntry {
	readonly file: string;
	/** The file, its routes and what it held, then the reason. */
	readonly note: string;
	readonly date: string;
}

/** The removals the sidecar records, oldest first. */
export function demandRemovals(sidecar: Sidecar | undefined): DemandRemovalEntry[] {
	return (sidecar?.values ?? []).flatMap(({ target, source }) => {
		if (target.field !== DEMAND_REMOVED_FIELD || target.file === undefined) return [];
		const note = source.note ?? '';
		return [{ file: target.file, note: note.startsWith(NOTE_PREFIX) ? note.slice(NOTE_PREFIX.length) : note, date: source.date ?? '' }];
	});
}

