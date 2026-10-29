/**
 * What the results screen can show: every route with a simulated flow and
 * every reservoir with a simulated storage, grouped by the module they leave
 * (routes) or are (reservoirs), in `.NET` solve order. Routes with a gauge
 * (`.NET` L.009–L.011) carry it and its observed flows.
 */

import type { Gauge, Module, ModuleTypeCode, MonthlySeries, NetworkBundle, ObservedFlow, RunResult } from '@pitman/wrsm';

export type TargetKind = 'route' | 'reservoir';

export interface ResultTarget {
	/** Stable key: `route-4`, `reservoir-2`. */
	readonly id: string;
	readonly kind: TargetKind;
	/** Route number or reservoir module number. */
	readonly number: number;
	/** What the picker shows, e.g. `Route 3: CR 3 to outside the network (gauge X1H001)`. */
	readonly label: string;
	/** The gauge on this route, when there is one. */
	readonly gauge: Gauge | null;
	/** The gauge's observed flows, when the bundle has the file. */
	readonly observed: ObservedFlow | null;
}

export interface TargetGroup {
	readonly label: string;
	readonly targets: readonly ResultTarget[];
}

function moduleFile(bundle: NetworkBundle, type: ModuleTypeCode, number: number): Module | undefined {
	return bundle.modules.find((m) => (m.kind === 'unparsed' ? m.moduleType : m.kind) === type && m.number === number);
}

/** `RU 12 Upper catchment` for the module at a 1-based `.NET` position; `outside the network` for 0. */
export function moduleLabel(bundle: NetworkBundle, position: number): string {
	const entry = bundle.network.modules[position - 1];
	if (position === 0 || entry === undefined) return 'outside the network';
	const name = moduleFile(bundle, entry.type, entry.number)?.name.trim() ?? '';
	return `${entry.type} ${entry.number}${name === '' ? '' : ` ${name}`}`;
}

/** The observed flows of a gauge: bundle keys are upper-cased file names, without a directory. */
export function observedFor(bundle: NetworkBundle, gauge: Gauge): ObservedFlow | null {
	const name = gauge.observedFile.trim().toUpperCase();
	const base = name.split(/[\\/]/).pop() ?? name;
	return bundle.observed[name] ?? bundle.observed[base] ?? null;
}

/** The gauge's label, or its file name when the label is blank. */
export function gaugeName(gauge: Gauge): string {
	return gauge.label.trim() || gauge.observedFile.trim();
}

/** A target's series in one run, or null when the run did not produce it. */
export function targetSeries(run: RunResult, target: Pick<ResultTarget, 'kind' | 'number'>): MonthlySeries | null {
	return (target.kind === 'route' ? run.routeFlows[target.number] : run.reservoirStorage[target.number]) ?? null;
}

/** Every route and reservoir any run has a result for, grouped for the picker. */
export function resultTargets(bundle: NetworkBundle, runs: readonly RunResult[]): TargetGroup[] {
	const routeNumbers = new Set(runs.flatMap((r) => Object.keys(r.routeFlows).map(Number)));
	const reservoirNumbers = new Set(runs.flatMap((r) => Object.keys(r.reservoirStorage).map(Number)));
	const placed = new Set<string>();

	const routeTarget = (number: number, from: string, to: string): ResultTarget => {
		const gauge = bundle.network.gauges.find((g) => g.route === number) ?? null;
		const where = from === '' ? '' : `: ${from} to ${to}`;
		placed.add(`route-${number}`);
		return {
			id: `route-${number}`,
			kind: 'route',
			number,
			label: `Route ${number}${where}${gauge === null ? '' : ` (gauge ${gaugeName(gauge)})`}`,
			gauge,
			observed: gauge === null ? null : observedFor(bundle, gauge)
		};
	};
	const reservoirTarget = (number: number, label: string): ResultTarget => {
		placed.add(`reservoir-${number}`);
		return { id: `reservoir-${number}`, kind: 'reservoir', number, label, gauge: null, observed: null };
	};

	const routes = bundle.network.routes;
	const groups: TargetGroup[] = [];
	const routesFrom = (position: number) =>
		routes
			.filter((r) => r.upstreamPosition === position && routeNumbers.has(r.number))
			.map((r) => routeTarget(r.number, moduleLabel(bundle, r.upstreamPosition), moduleLabel(bundle, r.downstreamPosition)));

	bundle.network.modules.forEach((entry, i) => {
		const position = i + 1;
		const targets: ResultTarget[] = [];
		if (entry.type === 'RV' && reservoirNumbers.has(entry.number)) {
			targets.push(reservoirTarget(entry.number, `Reservoir ${moduleLabel(bundle, position)}: storage`));
		}
		targets.push(...routesFrom(position));
		if (targets.length > 0) groups.push({ label: moduleLabel(bundle, position), targets });
	});
	const inflows = routesFrom(0);
	if (inflows.length > 0) groups.push({ label: 'Flows from outside the network', targets: inflows });

	const others = [
		...[...routeNumbers].filter((n) => !placed.has(`route-${n}`)).map((n) => routeTarget(n, '', '')),
		...[...reservoirNumbers].filter((n) => !placed.has(`reservoir-${n}`)).map((n) => reservoirTarget(n, `Reservoir ${n}: storage`))
	].sort((a, b) => a.kind.localeCompare(b.kind) || a.number - b.number);
	if (others.length > 0) groups.push({ label: 'Not in the network file', targets: others });
	return groups;
}

/** The first gauged route, else the first target: what the screen opens on. */
export function defaultTarget(groups: readonly TargetGroup[]): ResultTarget | null {
	const all = groups.flatMap((g) => g.targets);
	return all.find((t) => t.gauge !== null) ?? all[0] ?? null;
}
