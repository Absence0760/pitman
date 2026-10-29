/**
 * Whole-network comparison against WRSM2000's route answer files, for the
 * Round 6 discrepancy hunt (issue #3: "run the full comparison as modules
 * land, rank by error, trace each divergence to its first month and step").
 *
 * `referenceAnswers` finds a network's `<code>RQ<route>.ANS` files in its
 * folder (or its `Out/` subfolder, which wins when both have one);
 * `compareRunWithReference` compares every route that has one with
 * `compareSeries`, marks the routes that miss the thresholds
 * (`meetsThresholds`), and finds the **origins**: failing routes whose
 * upstream module has no failing inflow route, i.e. where a divergence
 * starts rather than where it is inherited. Rows are ranked worst first.
 *
 * Pure: the caller reads the folder (`readBundle`) and runs the network.
 */

import { readAnswer } from '../io/answer.js';
import type { LoadedBundle } from '../io/bundle.js';
import type { AnswerFile, ModuleRef, Network, RunResult } from '../types.js';
import { answerToSeries, compareSeries, type CompareOptions, type SeriesComparison, type YearMonth } from './compare.js';
import { meetsThresholds } from './expectations.js';

/** One route with a reference answer file. */
export interface RouteComparison {
	readonly route: number;
	/** The module that controls the route (its upstream end), `null` for a zero-source route. */
	readonly module: ModuleRef | null;
	/** 1-based `.NET` position of that module, 0 for the zero source. */
	readonly position: number;
	/** `null` when the series share no whole year, or the route has no simulated series. */
	readonly comparison: SeriesComparison | null;
	/** Misses the thresholds (|MAR diff| ≤ 1 %, NSE ≥ 0.99; `meetsThresholds`). */
	readonly fails: boolean;
	/** Fails while no compared inflow route of its module fails: the divergence starts here. */
	readonly origin: boolean;
	/** Why there is no comparison, when there isn't one. */
	readonly problem?: string;
}

/** A module's worst route. */
export interface ModuleComparison {
	readonly module: ModuleRef;
	readonly position: number;
	/** Route numbers compared for this module. */
	readonly routes: readonly number[];
	/** Largest |MAR % diff| over them; `null` when one has none (ranked worst). */
	readonly worstAbsMarPctDiff: number | null;
	/** Smallest NSE over them; `null` when undefined for one. */
	readonly worstNse: number | null;
	/** Earliest first-diverging month over them. */
	readonly firstDivergingMonth: YearMonth | null;
	readonly fails: boolean;
	readonly origin: boolean;
}

/** The comparison of one network run. */
export interface NetworkComparison {
	/** Every route with a reference, worst first. */
	readonly routes: readonly RouteComparison[];
	/** Every module controlling a compared route, worst first. */
	readonly modules: readonly ModuleComparison[];
	/** Reference files that could not be read, by path, with the reason. */
	readonly unreadable: readonly { readonly path: string; readonly problem: string }[];
}

const ANSWER_NAME = /^RQ(\d+)\.ANS$/i;

/**
 * The route answer files of `bundle`'s network, by route: `<code>RQ<n>.ANS`
 * beside the `.NET` or one folder below it named `Out` (case-insensitive),
 * the `Out/` one winning. Text as `readBundle` kept it (`files.other`).
 */
export function referenceAnswerTexts(bundle: LoadedBundle): Map<number, { readonly path: string; readonly text: string }> {
	const { root, other } = bundle.files;
	const code = bundle.network.code.toUpperCase();
	const found = new Map<number, { path: string; text: string; inOut: boolean }>();
	for (const [path, text] of Object.entries(other)) {
		if (!path.startsWith(root)) continue;
		const parts = path.slice(root.length).split('/');
		const inOut = parts.length === 2 && parts[0]!.toUpperCase() === 'OUT';
		if (!(parts.length === 1 || inOut)) continue;
		const name = parts[parts.length - 1]!;
		if (!name.toUpperCase().startsWith(code)) continue;
		const m = ANSWER_NAME.exec(name.slice(code.length));
		if (!m) continue;
		const route = Number(m[1]);
		const prev = found.get(route);
		if (!prev || (inOut && !prev.inOut)) found.set(route, { path, text, inOut });
	}
	return new Map([...found].map(([route, { path, text }]) => [route, { path, text }]));
}

/** `referenceAnswerTexts` parsed with `readAnswer`; unreadable files are listed, not thrown. */
export function referenceAnswers(bundle: LoadedBundle): { readonly answers: Map<number, AnswerFile>; readonly unreadable: { path: string; problem: string }[] } {
	const answers = new Map<number, AnswerFile>();
	const unreadable: { path: string; problem: string }[] = [];
	for (const [route, { path, text }] of referenceAnswerTexts(bundle)) {
		try {
			answers.set(route, readAnswer(text, path.slice(path.lastIndexOf('/') + 1)));
		} catch (error) {
			unreadable.push({ path, problem: error instanceof Error ? error.message : String(error) });
		}
	}
	return { answers, unreadable };
}

/** Worst first: undefined MAR difference, then |MAR % diff|, then NSE (lower worse). */
function errorOrder(a: { abs: number | null; nse: number | null }, b: { abs: number | null; nse: number | null }): number {
	const ka = a.abs ?? Infinity;
	const kb = b.abs ?? Infinity;
	if (ka !== kb) return kb - ka;
	return (a.nse ?? -Infinity) - (b.nse ?? -Infinity);
}

const earlier = (a: YearMonth | null, b: YearMonth | null): YearMonth | null =>
	!a ? b : !b ? a : a.year < b.year || (a.year === b.year && a.month <= b.month) ? a : b;

/** Compare a run of `network` with its reference answer files (by route number). */
export function compareRunWithReference(
	network: Network,
	result: RunResult,
	answers: ReadonlyMap<number, AnswerFile>,
	options: CompareOptions = {}
): Omit<NetworkComparison, 'unreadable'> {
	const refOf = (position: number): ModuleRef | null => {
		const entry = network.modules[position - 1];
		return entry ? { type: entry.type, number: entry.number } : null;
	};
	const raw = new Map<number, Omit<RouteComparison, 'origin'>>();
	for (const [route, answer] of answers) {
		const r = network.routes.find((x) => x.number === route);
		const position = r?.upstreamPosition ?? 0;
		const base = { route, module: r ? refOf(position) : null, position };
		const simulated = result.routeFlows[route];
		if (!r || !simulated) {
			raw.set(route, { ...base, comparison: null, fails: true, problem: r ? 'no simulated series' : 'route not in the network' });
			continue;
		}
		let comparison: SeriesComparison | null;
		try {
			comparison = compareSeries(simulated, answerToSeries(answer), options);
		} catch (error) {
			raw.set(route, { ...base, comparison: null, fails: true, problem: error instanceof Error ? error.message : String(error) });
			continue;
		}
		raw.set(route, { ...base, comparison, fails: !meetsThresholds(comparison), ...(comparison ? {} : { problem: 'no common year' }) });
	}

	const routes: RouteComparison[] = [...raw.values()].map((row) => {
		const inflows = network.routes.filter((x) => x.downstreamPosition === row.position && row.position > 0);
		const inherited = inflows.some((x) => raw.get(x.number)?.fails === true);
		return { ...row, origin: row.fails && !inherited };
	});
	const key = (c: SeriesComparison | null) => ({ abs: c?.marPctDiff == null ? null : Math.abs(c.marPctDiff), nse: c?.nse ?? null });
	routes.sort((a, b) => errorOrder(key(a.comparison), key(b.comparison)) || a.route - b.route);

	const byModule = new Map<number, RouteComparison[]>();
	for (const row of routes) if (row.module) byModule.set(row.position, [...(byModule.get(row.position) ?? []), row]);
	const modules: ModuleComparison[] = [...byModule.entries()].map(([position, rows]) => {
		let worstAbs: number | null = 0;
		let worstNse: number | null = Infinity;
		let first: YearMonth | null = null;
		for (const row of rows) {
			const k = key(row.comparison);
			worstAbs = worstAbs === null || k.abs === null ? null : Math.max(worstAbs, k.abs);
			worstNse = worstNse === null || k.nse === null ? null : Math.min(worstNse, k.nse);
			first = earlier(first, row.comparison?.firstDivergingMonth ?? null);
		}
		return {
			module: rows[0]!.module!,
			position,
			routes: rows.map((r) => r.route).sort((a, b) => a - b),
			worstAbsMarPctDiff: worstAbs,
			worstNse: worstNse === Infinity ? null : worstNse,
			firstDivergingMonth: first,
			fails: rows.some((r) => r.fails),
			origin: rows.some((r) => r.origin)
		};
	});
	modules.sort((a, b) => errorOrder({ abs: a.worstAbsMarPctDiff, nse: a.worstNse }, { abs: b.worstAbsMarPctDiff, nse: b.worstNse }) || a.position - b.position);
	return { routes, modules };
}

/**
 * Run `bundle` with `run` and compare it with the answer files in its
 * folder. `run` is the caller's (e.g. `runNetwork(bundle, { kind:
 * 'historical' }, { simulators, samiParts })`), so the Sami parts and every
 * option are injected there. A run that throws is returned as the error.
 */
export function compareNetworkWithReference(
	bundle: LoadedBundle,
	run: (bundle: LoadedBundle) => RunResult,
	options: CompareOptions = {}
): ({ readonly ok: true; readonly result: RunResult } & NetworkComparison) | { readonly ok: false; readonly error: unknown; readonly references: number } {
	const { answers, unreadable } = referenceAnswers(bundle);
	let result: RunResult;
	try {
		result = run(bundle);
	} catch (error) {
		return { ok: false, error, references: answers.size };
	}
	return { ok: true, result, ...compareRunWithReference(bundle.network, result, answers, options), unreadable };
}
