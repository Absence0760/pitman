import { describe, expect, it } from 'vitest';
import { fakeSamiParts, syntheticSamiParameters } from '../groundwater/sami/fake-parts.js';
import { answerFromSeries, writeAnswer } from '../io/answer.js';
import { readBundle, writeBundle, type LoadedBundle } from '../io/bundle.js';
import { fakeSimulators } from '../network/fake-simulators.js';
import { runNetwork } from '../network/run-network.js';
import { syntheticBundle } from '../network/synthetic-bundle.js';
import { SAMI_PARTS_NOT_WIRED } from '../runoff/wiring.js';
import type { MonthlySeries, NetworkBundle, RunoffModule, RunResult } from '../types.js';
import { compareNetworkWithReference, compareRunWithReference, referenceAnswerTexts, withAnnualReferenceMar } from './network.js';
import { compareSeries, answerToSeries } from './compare.js';
import { readAnswer } from '../io/answer.js';

// The comparison harness on a synthetic network (issue #3 rule 2): the
// "reference" answer files are written from one run and then perturbed, so
// the expected ranking and origins are known.
//
//   RU1 --1--> RU2 --2--> RV5 --5--> CR4 --4--> sink
//   RU3 --3--> CR4

const asSami = (m: RunoffModule): RunoffModule => ({ ...m, groundwaterModel: 2, sami: syntheticSamiParameters(m.pitman) });

function samiBundle(): NetworkBundle {
	const b = syntheticBundle();
	return { ...b, modules: b.modules.map((m) => (m.kind === 'RU' ? asSami(m) : m)) };
}

const runIt = (bundle: NetworkBundle): RunResult =>
	runNetwork(bundle, { kind: 'historical' }, { ...fakeSimulators(), samiParts: fakeSamiParts() });

const scaled = (s: MonthlySeries, f: number): MonthlySeries => ({ ...s, values: s.values.map((v) => v * f) });
const ans = (route: number, s: MonthlySeries) => writeAnswer(answerFromSeries('RQ', route, s));

/** The synthetic network as a folder, with answer files from `reference`, route 1 and 2 scaled ×1.1. */
function folder(reference: RunResult): LoadedBundle {
	const files: Record<string, string> = { ...writeBundle(samiBundle()) };
	const code = 'SY';
	const flows = reference.routeFlows;
	files[`${code}RQ1.ANS`] = ans(1, scaled(flows[1]!, 1.1));
	files[`${code}RQ2.ANS`] = ans(2, scaled(flows[2]!, 1.1)); // inherits route 1's error
	files[`Out/${code}RQ3.ANS`] = ans(3, flows[3]!);
	files[`${code}RQ3.ANS`] = ans(3, scaled(flows[3]!, 2)); // stale copy beside the .NET: Out/ wins
	files[`${code}RQ4.ANS`] = ans(4, flows[4]!);
	files[`${code}RQ1_old.ANS`] = ans(1, flows[1]!); // not a route answer file name
	files[`other/${code}RQ9.ANS`] = ans(9, flows[4]!); // not beside the .NET or in Out/
	const read = readBundle(files);
	if (!read.ok) throw new Error(read.errors.map((e) => e.message).join('; '));
	return read.bundle;
}

describe('referenceAnswerTexts', () => {
	it('takes <code>RQ<n>.ANS beside the .NET or in Out/, preferring Out/', () => {
		const loaded = folder(runIt(samiBundle()));
		const found = referenceAnswerTexts(loaded);
		expect([...found.keys()].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
		expect(found.get(3)!.path).toBe('Out/SYRQ3.ANS');
	});
});

describe('compareNetworkWithReference', () => {
	const reference = runIt(samiBundle());
	const loaded = folder(reference);
	const c = compareNetworkWithReference(loaded, runIt);

	it('compares every referenced route and ranks the worst first', () => {
		if (!c.ok) throw c.error;
		expect(c.routes.map((r) => r.route).slice(0, 2).sort()).toEqual([1, 2]);
		const r1 = c.routes.find((r) => r.route === 1)!;
		expect(r1.comparison!.marPctDiff).toBeCloseTo(100 * (1 / 1.1 - 1), 1);
		expect(r1.comparison!.firstDivergingMonth).not.toBeNull();
		expect(c.routes.find((r) => r.route === 3)!.fails).toBe(false);
		expect(c.routes.find((r) => r.route === 4)!.fails).toBe(false);
		expect(c.unreadable).toEqual([]);
	});

	it('marks where a divergence starts, not where it is inherited', () => {
		if (!c.ok) throw c.error;
		const byRoute = new Map(c.routes.map((r) => [r.route, r]));
		expect(byRoute.get(1)).toMatchObject({ fails: true, origin: true, module: { type: 'RU', number: 1 }, position: 1 });
		expect(byRoute.get(2)).toMatchObject({ fails: true, origin: false, module: { type: 'RU', number: 2 } });
		// Routes 1 and 2 are both 10 % off by construction, so which ranks first is a tie; look RU 1 up.
		expect(c.modules.find((m) => m.module.number === 1)).toMatchObject({ module: { type: 'RU', number: 1 }, origin: true, fails: true });
		expect(c.modules.find((m) => m.module.number === 2)).toMatchObject({ origin: false, fails: true });
	});

	it('returns the error of a run that throws, with the reference count', () => {
		const failed = compareNetworkWithReference(loaded, (b) =>
			runNetwork(b, { kind: 'historical' }, { ...fakeSimulators(), samiParts: SAMI_PARTS_NOT_WIRED })
		);
		expect(failed.ok).toBe(false);
		if (failed.ok) return;
		expect(String(failed.error)).toMatch(/not wired/);
		expect(failed.references).toBe(4);
	});
});

describe('compareRunWithReference', () => {
	it('reports a route the network lacks or has no common year with', () => {
		const result = runIt(samiBundle());
		const ref = answerFromSeries('RQ', 1, { ...result.routeFlows[1]!, startYear: 1800 });
		const out = compareRunWithReference(samiBundle().network, result, new Map([[1, ref], [77, ref]]));
		expect(out.routes.find((r) => r.route === 77)).toMatchObject({ problem: 'route not in the network', fails: true, module: null });
		expect(out.routes.find((r) => r.route === 1)).toMatchObject({ problem: 'no common year', fails: true, comparison: null });
	});
});

describe('withAnnualReferenceMar', () => {
	// A small route: 0.004 million m³ every month. WRSM2000 prints each month as 0.00 but the annual total,
	// summed from the unrounded months, as 0.05: the reference MAR comes from that column.
	const small: MonthlySeries = { startYear: 2000, values: new Array<number>(36).fill(0.004), unit: 'Mm3' };
	const answer = readAnswer(ans(7, small), 'SYRQ7.ANS');

	it('the printed months lose the flow; the annual column keeps it', () => {
		expect(answerToSeries(answer).values.every((v) => v === 0)).toBe(true);
		expect(answer.rows.map((r) => r.annualTotal)).toEqual([0.05, 0.05, 0.05]);
		const monthly = compareSeries(small, answerToSeries(answer))!;
		expect(monthly.marReference).toBe(0);
		const c = withAnnualReferenceMar(monthly, answer)!;
		expect(c.marReference).toBeCloseTo(0.05, 12);
		expect(c.marPctDiff).toBeCloseTo((100 * (0.048 - 0.05)) / 0.05, 9);
		// NSE and the divergence month stay monthly.
		expect(c.nse).toBe(monthly.nse);
		expect(c.firstDivergingMonth).toEqual(monthly.firstDivergingMonth);
	});

	it('leaves the comparison alone when the answer lacks a year of the overlap', () => {
		const monthly = compareSeries(small, answerToSeries(answer))!;
		const short = { ...answer, rows: answer.rows.slice(1) };
		expect(withAnnualReferenceMar(monthly, short)).toBe(monthly);
		expect(withAnnualReferenceMar(null, answer)).toBeNull();
	});
});
