/**
 * The checks WRSM2000 makes "before the simulation is run" (TT 689
 * §6.1.16 p.56: a module data check and a connectivity check), plus the
 * sequence check it makes as it starts solving. Every problem is reported
 * at once; `runNetwork` throws a `NetworkError` carrying them all when any
 * is an error. Spec: docs/theory/network.md §5.
 */

import type { ModuleRef, NetworkBundle, Route, RunMessage } from '../types.js';
import { definedFileOn, lookupFile, moduleLabel, namedRoutes, placedLabel, placeModules, type NamedRoute, type PlacedModule } from './modules.js';

/** A network that can't be run; `messages` holds every problem found (errors and the warnings beside them). */
export class NetworkError extends Error {
	override readonly name = 'NetworkError';
	readonly messages: readonly RunMessage[];

	constructor(messages: readonly RunMessage[], options?: { readonly cause?: unknown }) {
		const errors = messages.filter((m) => m.level === 'error');
		super(errors.length > 0 ? errors.map((m) => m.text).join('\n') : 'network error', options);
		this.messages = messages;
	}
}

/**
 * Tolerance on the sum of an RU module's L.020 percentages, per outflow
 * route: half the 0.1 % resolution of the `F6.1` field each percentage is
 * written in (docs/formats.md §5.1), so three routes of 33.3 % pass and a
 * real 1 % gap does not (R3-N5).
 */
export const PERCENT_TOLERANCE_PER_ROUTE = 0.05;

/** TT 689 Table 2.1 (p.5): routes per module. Exceeding one is a warning (docs/formats.md §4). */
const ROUTE_LIMITS: Readonly<Record<string, { readonly in: number; readonly out: number }>> = {
	RU: { in: 1, out: 10 },
	CR: { in: 10, out: 10 },
	RV: { in: 5, out: 5 },
	RR: { in: 1, out: 1 },
	MM: { in: 0, out: 60 }
};

/**
 * "Module `before` must be solved before module `after`" (positions).
 * - `flow`: `after` takes the flow `before` puts on `route`.
 * - `demand`: `before` is an irrigation module whose abstraction `route`
 *   is supplied by `after`: "the demands of an irrigation block should also
 *   be determined before its source module" (TT 691 §12.6 p.183; TT 689
 *   pp.83–84, the route's demand stream).
 * - `returnFlow`: `before` supplies an irrigation module whose return
 *   flow enters `after` (TT 689 p.85). Used only to find cycles, never as
 *   a sequence error (R3-N22).
 * - `groundwater`: `before` is the runoff module whose groundwater state
 *   feeds `after` (RU L.021 v2; TT 689 p.41, "the order in which the
 *   modules are solved is important").
 */
export interface Dependency {
	readonly before: number;
	readonly after: number;
	readonly kind: 'flow' | 'demand' | 'groundwater' | 'returnFlow';
	readonly route?: number;
}

/**
 * The solve-order constraints of a network (docs/theory/network.md §4).
 * A route whose downstream module reads it from a defined-flow file adds
 * none: the downstream module doesn't wait for the upstream one.
 * Invalid routes (endpoints out of range) are skipped; `validateNetwork`
 * reports them.
 */
export function networkDependencies(bundle: NetworkBundle, placed: readonly PlacedModule[] = placeModules(bundle)): Dependency[] {
	const count = placed.length;
	const out: Dependency[] = [];
	for (const route of bundle.network.routes) {
		const u = route.upstreamPosition;
		const d = route.downstreamPosition;
		if (!validEndpoint(u, count) || !validEndpoint(d, count) || u === 0 || d === 0 || u === d) continue;
		const down = placed[d - 1]!;
		// An irrigation module has one inflow, its abstraction route (TT 689 Table 2.1), so the .NET type is enough (an unparsed RR too).
		if (down.entry.type === 'RR') {
			out.push({ before: d, after: u, kind: 'demand', route: route.number });
		} else if (definedFileOn(down.module, route.number, 'in') === undefined) {
			out.push({ before: u, after: d, kind: 'flow', route: route.number });
		}
	}
	// An irrigation return flow may only go "to modules that are downstream of the module that supplies an
	// Irrigation Block" (TT 689 p.85). The constraint only feeds the cycle check: a return that reaches back
	// to the supplier is circular, but the destination may sit earlier in the list (R3-N22).
	for (const p of placed) {
		const m = p.module;
		if (m?.kind !== 'RR' || !m.returnFlowRoute) continue;
		const supply = bundle.network.routes.find((r) => r.number === m.abstractionRoute && r.downstreamPosition === p.position);
		const back = bundle.network.routes.find((r) => r.number === m.returnFlowRoute && r.upstreamPosition === p.position);
		if (!supply || !back) continue;
		const s = supply.upstreamPosition;
		const x = back.downstreamPosition;
		if (validEndpoint(s, count) && validEndpoint(x, count) && s > 0 && x > 0 && s !== x) out.push({ before: s, after: x, kind: 'returnFlow', route: back.number });
	}
	for (const p of placed) {
		const m = p.module;
		if (m?.kind !== 'RU' || !m.upstreamGroundwaterModule) continue;
		const source = placed.find((q) => q.entry.type === 'RU' && q.entry.number === m.upstreamGroundwaterModule);
		if (source && source.position !== p.position) out.push({ before: source.position, after: p.position, kind: 'groundwater' });
	}
	return out;
}

function validEndpoint(position: number, count: number): boolean {
	return Number.isInteger(position) && position >= 0 && position <= count;
}

/**
 * Check a network before running it. Returns every message, errors first
 * in the order the checks run (module files, routes, connectivity, data,
 * sequence, gauges and summary lines); an empty array means it can run.
 * `runNetwork` calls this and throws `NetworkError` when any is an error.
 */
export function validateNetwork(bundle: NetworkBundle): RunMessage[] {
	const { network } = bundle;
	const netFile = `${network.code}.NET`;
	const placed = placeModules(bundle);
	const count = placed.length;
	const messages: RunMessage[] = [];
	const error = (text: string, extra: { module?: ModuleRef; route?: number } = {}) => messages.push({ level: 'error', ...extra, text });
	const warning = (text: string, extra: { module?: ModuleRef; route?: number } = {}) => messages.push({ level: 'warning', ...extra, text });
	const at = (position: number): string => (position === 0 ? 'the zero module' : `${moduleLabel(placed[position - 1]!.ref)} (position ${position})`);

	// 1. Module list against the bundle.
	const seen = new Map<string, number>();
	for (const p of placed) {
		const key = `${p.entry.type}${p.entry.number}`;
		const first = seen.get(key);
		if (first !== undefined) error(`${netFile}: ${moduleLabel(p.ref)} is listed twice in the module list (positions ${first} and ${p.position})`, { module: p.ref });
		else seen.set(key, p.position);
		if (!p.module) error(`${netFile}: module list position ${p.position} is ${moduleLabel(p.ref)}, but the network has no file ${p.fileName}`, { module: p.ref });
	}

	// 2. Routes: numbers and endpoints (TT 691 §12.6 L.014; TT 689 §2.2 pp.4–5, p.48).
	const routes = new Map<number, Route>();
	const usable = new Set<number>();
	for (const route of network.routes) {
		const where = { route: route.number };
		if (routes.has(route.number)) {
			error(`${netFile}: route ${route.number} is defined twice`, where);
			continue;
		}
		routes.set(route.number, route);
		let ok = true;
		for (const [end, position] of [
			['upstream', route.upstreamPosition],
			['downstream', route.downstreamPosition]
		] as const) {
			if (!validEndpoint(position, count)) {
				error(`${netFile}: route ${route.number} ${end} module is position ${position}, outside the module list (0–${count})`, where);
				ok = false;
			}
		}
		if (!ok) continue;
		if (route.upstreamPosition === 0 && route.downstreamPosition === 0) {
			error(`${netFile}: route ${route.number} runs from the zero module to the zero module`, where);
			ok = false;
		} else if (route.upstreamPosition === route.downstreamPosition) {
			error(`${netFile}: route ${route.number} starts and ends in ${at(route.upstreamPosition)} (TT 689 p.48)`, where);
			ok = false;
		}
		if (ok) usable.add(route.number);
	}

	// 3. Connectivity: module files against the .NET routes.
	const named = new Map<number, NamedRoute[]>();
	for (const p of placed) {
		if (!p.module) continue;
		const list = namedRoutes(p.module);
		if (!list) continue;
		named.set(p.position, list);
		const label = placedLabel(p);
		for (const n of list) {
			const route = routes.get(n.route);
			if (!route) {
				error(`${label} names ${n.role} ${n.route}, which is not a route in ${netFile}`, { module: p.ref, route: n.route });
				continue;
			}
			if (!usable.has(n.route)) continue;
			const end = n.direction === 'out' ? route.upstreamPosition : route.downstreamPosition;
			if (end !== p.position) {
				const side = n.direction === 'out' ? 'from' : 'to';
				error(`${label} names ${n.role} ${n.route}, but ${netFile} routes it ${side} ${at(end)}`, { module: p.ref, route: n.route });
			}
		}
	}
	for (const route of network.routes) {
		if (!usable.has(route.number)) continue;
		for (const [direction, position] of [
			['out', route.upstreamPosition],
			['in', route.downstreamPosition]
		] as const) {
			if (position === 0) continue;
			const list = named.get(position);
			if (!list) continue; // missing or unparsed file
			if (!list.some((n) => n.route === route.number && n.direction === direction)) {
				const p = placed[position - 1]!;
				const what = direction === 'out' ? 'leaves' : 'enters';
				const need = direction === 'out' ? 'an outflow' : 'an inflow';
				error(`route ${route.number} ${what} ${moduleLabel(p.ref)} in ${netFile}, but ${p.fileName} doesn't name it as ${need} route`, { module: p.ref, route: route.number });
			}
		}
		// A route holds one defined-flow file (Route_Type RTFile, TT 691 §7.3.1 p.30): both ends naming different ones is ambiguous.
		if (route.upstreamPosition > 0 && route.downstreamPosition > 0) {
			const up = definedFileOn(placed[route.upstreamPosition - 1]!.module, route.number, 'out');
			const down = definedFileOn(placed[route.downstreamPosition - 1]!.module, route.number, 'in');
			if (up && down && up !== '*' && up.trim().toUpperCase() !== down.trim().toUpperCase()) {
				warning(`route ${route.number}: its upstream module names defined-flow file '${up}' and its downstream module '${down}'; a route has one (TT 691 §7.3.1); the downstream module reads '${down}'`, { route: route.number });
			}
		}
		// Flows from a zero source must be defined by a file (TT 689 p.xv; §2.2 p.4).
		if (route.upstreamPosition === 0) {
			const p = placed[route.downstreamPosition - 1]!;
			if (p.module?.kind === 'unparsed') {
				warning(`route ${route.number} starts at the zero module and enters ${placedLabel(p)}, which the engine can't read; its defined-flow file can't be checked`, { route: route.number });
			} else if (p.module && definedFileOn(p.module, route.number, 'in') === undefined) {
				error(`route ${route.number} starts at the zero module, but ${placedLabel(p)} gives it no defined-flow file (flows from a zero source must be defined by a file, TT 689 p.xv)`, { module: p.ref, route: route.number });
			}
		}
	}

	// 4. Module data the run needs.
	const childOf = new Map<number, number>();
	for (const p of placed) {
		const m = p.module;
		if (!m) continue;
		const label = placedLabel(p);
		const ref = { module: p.ref };
		// Defined-flow files named on route lines.
		if (m.kind === 'RV' || m.kind === 'CR') {
			for (const c of [...m.inflows, ...m.outflows]) {
				if (c.definedFlowFile && c.definedFlowFile !== '*' && !lookupFile(bundle.flowFiles, c.definedFlowFile)) {
					error(`${label}: route ${c.route} names defined-flow file '${c.definedFlowFile}', which is not in the network`, { ...ref, route: c.route });
				}
			}
		}
		if ((m.kind === 'RU' || m.kind === 'RV' || m.kind === 'RR') && !lookupFile(bundle.rainfall, m.rainfallFile)) {
			error(`${label}: rainfall file '${m.rainfallFile}' is not in the network`, ref);
		}
		if (m.kind === 'CR' && m.wetlandType !== 0 && m.wetlandRainfallFile && !lookupFile(bundle.rainfall, m.wetlandRainfallFile)) {
			error(`${label}: wetland rainfall file '${m.wetlandRainfallFile}' is not in the network`, ref);
		}
		if (m.kind === 'RR' && m.returnFlowRoute) {
			const supply = routes.get(m.abstractionRoute);
			const back = routes.get(m.returnFlowRoute);
			if (supply && back && supply.upstreamPosition > 0 && supply.upstreamPosition === back.downstreamPosition && back.upstreamPosition === p.position) {
				error(`${label}: return-flow route ${back.number} goes back into ${at(supply.upstreamPosition)}, which supplies it through route ${supply.number}; a return flow may only go to the zero sink or downstream of the supplier (TT 689 p.85, p.104)`, { ...ref, route: back.number });
			}
		}
		if (m.kind === 'RU') {
			// TT 689 p.133 ("All Runoff Modules must have at least one outflow route"); p.56 (100 % of all flows).
			const repeated = m.outflows.map((o) => o.route).filter((r, i, all) => all.indexOf(r) !== i);
			for (const r of new Set(repeated)) error(`${label}: outflow route ${r} is listed more than once in L.020`, { ...ref, route: r });
			if (m.outflows.length === 0) {
				error(`${label} has no outflow routes (L.019 is 0; TT 689 p.133)`, ref);
			} else {
				const sum = m.outflows.reduce((s, o) => s + o.percent, 0);
				const tolerance = PERCENT_TOLERANCE_PER_ROUTE * m.outflows.length;
				if (Math.abs(sum - 100) > tolerance + 1e-9) {
					error(`${label}: outflow route percentages (L.020) add up to ${round(sum)} %, not 100 % (±${round(tolerance)}); flows would be created or destroyed (TT 689 p.56)`, ref);
				}
			}
			if (m.upstreamGroundwaterModule) {
				const source = placed.find((q) => q.entry.type === 'RU' && q.entry.number === m.upstreamGroundwaterModule);
				if (!source) error(`${label}: upstream groundwater module RU ${m.upstreamGroundwaterModule} (L.021) is not in ${netFile}`, ref);
				else if (source.position === p.position) error(`${label}: names itself as its upstream groundwater module (L.021)`, ref);
			}
			for (const child of m.sfrChildren ?? []) {
				const c = placed.find((q) => q.entry.type === 'RU' && q.entry.number === child);
				if (!c) {
					error(`${label}: SFR child RU ${child} (L.039) is not in ${netFile}`, ref);
					continue;
				}
				const other = childOf.get(child);
				// TT 690 p.126: "A Child cannot be captured by more than one Parent"; run, both parents would add its flow.
				if (other !== undefined) error(`RU ${child} is an SFR child of both RU ${other} and RU ${m.number}; a child cannot be captured by more than one parent (TT 690 p.126; TT 689 p.135)`, { module: c.ref });
				childOf.set(child, m.number);
				if (c.module?.kind === 'RU') {
					// TT 689 p.133 rules A–C for a child's outflow.
					const outs = c.module.outflows;
					const toZero = outs.length === 1 && outs[0]!.percent === 100 && routes.get(outs[0]!.route)?.downstreamPosition === 0;
					if (!toZero) warning(`${placedLabel(c)}: an SFR child should have one outflow route carrying 100 % to the zero module, or its flow is counted twice or lost (TT 689 p.133)`, { module: c.ref });
				}
			}
		}
		// TT 689 Table 2.1 (p.5).
		const limit = ROUTE_LIMITS[p.entry.type];
		const list = named.get(p.position);
		if (limit && list) {
			const ins = new Set(list.filter((n) => n.direction === 'in').map((n) => n.route)).size;
			const outs = new Set(list.filter((n) => n.direction === 'out').map((n) => n.route)).size;
			if (ins > limit.in) warning(`${label} has ${ins} inflow routes; TT 689 Table 2.1 allows ${limit.in}`, ref);
			if (outs > limit.out) warning(`${label} has ${outs} outflow routes; TT 689 Table 2.1 allows ${limit.out}`, ref);
		}
	}

	// A WQT block can only lie in a parent: a child's runoff is already reduced at source (TT 689 p.165; TT 691 p.211 item 113).
	for (const p of placed) {
		const m = p.module;
		if (m?.kind !== 'RR' || m.layout === 'pitman' || m.modelType === 1 || !childOf.has(m.runoffModule)) continue;
		// A warning, not an error: nothing has yet shown a real network never does this, and a refusal would stop it running.
		warning(`${placedLabel(p)}: lies in RU ${m.runoffModule} (L.013), an SFR child of RU ${childOf.get(m.runoffModule)}; a WQT block can only lie in a parent (TT 689 p.165)`, { module: p.ref });
	}

	// 5. Sequence and cycles (TT 689 §6.1.16 pp.56–58, p.48, p.104; TT 691 §12.6 p.183).
	const dependencies = networkDependencies(bundle, placed);
	const cycles = findCycles(count, dependencies);
	const inCycle = new Map<number, number>();
	cycles.forEach((cycle, k) => cycle.forEach((position) => inCycle.set(position, k)));
	for (const cycle of cycles) {
		const members = cycle.map((position) => moduleLabel(placed[position - 1]!.ref)).join(', ');
		const k = inCycle.get(cycle[0]!);
		const via = dependencies.flatMap((d) => (d.route !== undefined && inCycle.get(d.before) === k && inCycle.get(d.after) === k ? [d.route] : []));
		error(`circular routing between ${members} (routes ${[...new Set(via)].sort((a, b) => a - b).join(', ')}): each waits for another, so no module order can solve it (TT 689 p.48, p.104)`, {
			module: placed[cycle[0]! - 1]!.ref
		});
	}
	for (const dep of dependencies) {
		const k = inCycle.get(dep.before);
		if (dep.kind === 'returnFlow' || (k !== undefined && k === inCycle.get(dep.after))) continue;
		const before = placed[dep.before - 1]!;
		const after = placed[dep.after - 1]!;
		if (!after.entry.solve) continue;
		const why =
			dep.kind === 'flow'
				? `${moduleLabel(after.ref)} takes route ${dep.route} from ${moduleLabel(before.ref)}`
				: dep.kind === 'demand'
					? `${moduleLabel(after.ref)} supplies irrigation route ${dep.route}, whose demand ${moduleLabel(before.ref)} sets`
					: `${moduleLabel(after.ref)} takes its groundwater state from ${moduleLabel(before.ref)}`;
		const where = { module: after.ref, ...(dep.route !== undefined ? { route: dep.route } : {}) };
		if (!before.entry.solve) {
			error(`sequence error: ${why}, which is not solved (Solve = N). Every module that depends on an unsolved module must also be unsolved (TT 689 p.58; TT 691 p.183)`, where);
		} else if (dep.before > dep.after) {
			error(`sequence error: ${why}, but ${moduleLabel(before.ref)} (position ${dep.before}) is solved after ${moduleLabel(after.ref)} (position ${dep.after}); move ${moduleLabel(before.ref)} above ${moduleLabel(after.ref)} in the module list (TT 689 §6.1.16, p.56)`, where);
		}
	}

	// 6. Gauges and summary lines (TT 691 §12.6 L.009–L.011, L.015–L.016).
	for (const gauge of network.gauges) {
		if (!routes.has(gauge.route)) error(`${netFile}: gauge '${gauge.label.trim() || gauge.observedFile}' is on route ${gauge.route}, which is not in the network`, { route: gauge.route });
		if (!lookupFile(bundle.observed, gauge.observedFile)) warning(`${netFile}: observed-flow file '${gauge.observedFile}' for route ${gauge.route} is not in the network; the gauge has nothing to compare`, { route: gauge.route });
	}
	for (const line of network.summaryLines) {
		if (line.kind === 'RT' && !routes.has(line.number)) warning(`${netFile}: summary line asks for route ${line.number}, which is not in the network`, { route: line.number });
		if (line.kind === 'RV' && !placed.some((p) => p.entry.type === 'RV' && p.entry.number === line.number)) warning(`${netFile}: summary line asks for reservoir RV ${line.number}, which is not in the network`);
	}

	return messages;
}

function round(x: number): number {
	return Math.round(x * 1000) / 1000;
}

/**
 * Groups of positions that depend on each other in a loop (strongly
 * connected components of more than one module, Tarjan's algorithm), each
 * sorted, in order of their first position.
 */
export function findCycles(count: number, dependencies: readonly Dependency[]): number[][] {
	const next = new Map<number, number[]>();
	for (const d of dependencies) next.set(d.before, [...(next.get(d.before) ?? []), d.after]);
	let counter = 0;
	const index = new Map<number, number>();
	const low = new Map<number, number>();
	const stack: number[] = [];
	const onStack = new Set<number>();
	const out: number[][] = [];
	// Iterative Tarjan, so a long chain of modules can't overflow the call stack.
	for (let start = 1; start <= count; start++) {
		if (index.has(start)) continue;
		const work: { node: number; edge: number }[] = [{ node: start, edge: 0 }];
		index.set(start, counter);
		low.set(start, counter++);
		stack.push(start);
		onStack.add(start);
		while (work.length > 0) {
			const frame = work[work.length - 1]!;
			const edges = next.get(frame.node) ?? [];
			if (frame.edge < edges.length) {
				const to = edges[frame.edge++]!;
				if (!index.has(to)) {
					index.set(to, counter);
					low.set(to, counter++);
					stack.push(to);
					onStack.add(to);
					work.push({ node: to, edge: 0 });
				} else if (onStack.has(to)) {
					low.set(frame.node, Math.min(low.get(frame.node)!, index.get(to)!));
				}
				continue;
			}
			work.pop();
			const parent = work[work.length - 1];
			if (parent) low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!));
			if (low.get(frame.node) === index.get(frame.node)) {
				const component: number[] = [];
				let member: number;
				do {
					member = stack.pop()!;
					onStack.delete(member);
					component.push(member);
				} while (member !== frame.node);
				if (component.length > 1) out.push(component.sort((a, b) => a - b));
			}
		}
	}
	return out.sort((a, b) => a[0]! - b[0]!);
}
