/**
 * Which runoff modules can be calibrated here, and where their water goes.
 *
 * An SFR child copies its parent's climate and parameters and is calibrated
 * by the run itself (`inheritFromParent`, decision R6-F0), so it has nothing to
 * edit: its parent is what's edited. A Hughes module can't run yet.
 */

import type { NetworkBundle, RunResult, RunoffModule } from '@pitman/wrsm';
import { resultTargets, type ResultTarget } from '#lib/results/targets.js';
import { groundwaterKind } from './parameters.js';

export interface Candidate {
	readonly number: number;
	readonly label: string;
	readonly editable: boolean;
	/** Said beside the module when it can't be edited, and in the picker. */
	readonly why?: string;
}

function runoffModules(bundle: NetworkBundle): RunoffModule[] {
	const byNumber = new Map(bundle.modules.flatMap((m) => (m.kind === 'RU' ? [[m.number, m] as const] : [])));
	return bundle.network.modules.flatMap((entry) => {
		const module = entry.type === 'RU' ? byNumber.get(entry.number) : undefined;
		return module ? [module] : [];
	});
}

/** The module a child belongs to, by its parent's L.039 list. */
export function sfrParent(bundle: NetworkBundle, childNumber: number): RunoffModule | undefined {
	return runoffModules(bundle).find((m) => m.sfrChildren?.includes(childNumber));
}

/** Every runoff module in `.NET` order, each with whether it can be edited. */
export function calibrationCandidates(bundle: NetworkBundle): Candidate[] {
	return runoffModules(bundle).map((m) => {
		const label = `RU ${m.number}${m.name.trim() === '' ? '' : ` ${m.name.trim()}`}`;
		const parent = sfrParent(bundle, m.number);
		if (parent) return { number: m.number, label, editable: false, why: `SFR child: it takes RU ${parent.number}’s parameters, so edit RU ${parent.number}` };
		if (groundwaterKind(m) === 'hughes') return { number: m.number, label, editable: false, why: 'Hughes groundwater isn’t modelled yet' };
		if (groundwaterKind(m) === 'sami' && !m.sami) return { number: m.number, label, editable: false, why: 'Sami module with no Sami parameters' };
		return { number: m.number, label, editable: true };
	});
}

/** Routes the module's water can reach, nearest first (its own outflows, then on down the network). */
export function downstreamRoutes(bundle: NetworkBundle, moduleNumber: number): number[] {
	const { modules, routes } = bundle.network;
	const start = modules.findIndex((m) => m.type === 'RU' && m.number === moduleNumber) + 1;
	if (start === 0) return [];
	const seenPositions = new Set([start]);
	const found: number[] = [];
	let frontier = [start];
	while (frontier.length > 0) {
		const next: number[] = [];
		for (const position of frontier) {
			for (const route of routes) {
				if (route.upstreamPosition !== position || found.includes(route.number)) continue;
				found.push(route.number);
				const down = route.downstreamPosition;
				if (down !== 0 && !seenPositions.has(down)) {
					seenPositions.add(down);
					next.push(down);
				}
			}
		}
		frontier = next;
	}
	return found;
}

/** What the gauges offer this module, for the words on the screen. */
export type GaugeSituation = 'gauged' | 'noneDownstream' | 'noGauges';

export function gaugeSituation(bundle: NetworkBundle, moduleNumber: number): GaugeSituation {
	if (bundle.network.gauges.length === 0) return 'noGauges';
	const reached = new Set(downstreamRoutes(bundle, moduleNumber));
	return bundle.network.gauges.some((g) => reached.has(g.route)) ? 'gauged' : 'noneDownstream';
}

/** The routes to compare at: gauges with observed flows first, then other gauges, then the rest, each nearest first. */
export function calibrationTargets(bundle: NetworkBundle, moduleNumber: number, runs: readonly RunResult[]): ResultTarget[] {
	const order = downstreamRoutes(bundle, moduleNumber);
	const byRoute = new Map(
		resultTargets(bundle, runs)
			.flatMap((g) => g.targets)
			.filter((t) => t.kind === 'route')
			.map((t) => [t.number, t])
	);
	const targets = order.flatMap((route) => {
		const target = byRoute.get(route);
		return target ? [target] : [];
	});
	const rank = (t: ResultTarget) => (t.observed !== null ? 0 : t.gauge !== null ? 1 : 2);
	return targets.map((t, i) => ({ t, i })).sort((a, b) => rank(a.t) - rank(b.t) || a.i - b.i).map(({ t }) => t);
}

/** What the model leaves out that a fit in this network has to be read against. */
export function modelGaps(bundle: NetworkBundle): string[] {
	const gaps: string[] = [];
	const irrigation = bundle.modules.filter((m) => m.kind === 'RR').length;
	if (irrigation > 0) {
		gaps.push(
			`${irrigation === 1 ? 'This network’s irrigation module isn’t' : `This network’s ${irrigation} irrigation modules aren’t`} simulated yet: abstraction and return-flow routes carry zero, so flows below them are not reduced. Don’t tune parameters to make up for that difference.`
		);
	}
	const skipped = bundle.modules.filter((m) => m.kind === 'unparsed').length;
	if (skipped > 0) gaps.push(`${skipped === 1 ? 'One module isn’t' : `${skipped} modules aren’t`} simulated (see “Kept but not modelled” above), and ${skipped === 1 ? 'its routes carry' : 'their routes carry'} zero.`);
	return gaps;
}
