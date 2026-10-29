import { describe, expect, it } from 'vitest';
import { fakeSamiParts, syntheticSamiParameters } from '../groundwater/sami/fake-parts.js';
import type { ReductionInput, StreamflowReduction } from '../landuse/contract.js';
import type { Module, NetworkBundle, RunMode, RunoffModule } from '../types.js';
import { fakeSimulators } from './fake-simulators.js';
import { runNetwork } from './run-network.js';
import { syntheticBundle } from './synthetic-bundle.js';

// The network runner with Sami modules and streamflow reductions (Round 6
// plumbing). Synthetic network only (issue #3 rule 2).

function replace(bundle: NetworkBundle, ...modules: Module[]): NetworkBundle {
	return { ...bundle, modules: bundle.modules.map((m) => modules.find((x) => x.kind === m.kind && x.number === m.number) ?? m) };
}
const ru = (bundle: NetworkBundle, n: number) => bundle.modules.find((m): m is RunoffModule => m.kind === 'RU' && m.number === n)!;
const asSami = (m: RunoffModule): RunoffModule => ({ ...m, groundwaterModel: 2, sami: syntheticSamiParameters(m.pitman) });

describe('runNetwork with Sami modules', () => {
	it('runs every Sami module through the injected parts and keeps its §3.12 diagnostics', () => {
		const bundle = syntheticBundle();
		const sami = replace(bundle, asSami(ru(bundle, 1)), asSami(ru(bundle, 3)));
		const parts = fakeSamiParts();
		const result = runNetwork(sami, { kind: 'historical' }, { ...fakeSimulators(), samiParts: parts });
		expect(parts.calls.filter((c) => c === 'soilPass')).toHaveLength(2);
		expect(result.runoff![1]!.aquiferStorageMm!.values).toHaveLength(result.routeFlows[1]!.values.length);
		// RU3's only outflow route carries its Qfinal (L.020 at 100 %).
		expect(result.routeFlows[3]!.values).toEqual(result.runoff![3]!.netRunoff!.values);
	});

	it('passes the Sami options through', () => {
		const bundle = syntheticBundle();
		const sami = replace(bundle, asSami(ru(bundle, 3)));
		const a = runNetwork(sami, { kind: 'historical' }, { ...fakeSimulators(), samiParts: fakeSamiParts() });
		const b = runNetwork(sami, { kind: 'historical' }, { ...fakeSimulators(), samiParts: fakeSamiParts(), sami: { finalRunoff: 'totalPlusBaseflow' } });
		expect(b.routeFlows[3]!.values).not.toEqual(a.routeFlows[3]!.values);
	});
});

describe('runNetwork with streamflow reductions', () => {
	const MODES: readonly RunMode[] = [{ kind: 'historical' }, { kind: 'presentDay', year: 1994 }, { kind: 'natural' }];

	it.each(MODES.map((m) => [m.kind, m] as const))('gives each child its parent, in the run mode, and collects virgin MAR (%s)', (_kind, mode) => {
		const bundle = syntheticBundle();
		// RU3 is the SFR parent of RU1 (validation only warns that RU1 doesn't drain to the zero sink).
		const parent = { ...ru(bundle, 3), sfrChildren: [1], paved: { fraction: [{ year: 1990, value: 0.1 }] } };
		const withSfr = replace(bundle, parent);
		const seen: ReductionInput[] = [];
		const record: StreamflowReduction = (inp) => {
			seen.push(inp);
			return {
				reductionMm3: { ...inp.unreducedRunoffMm3, values: inp.unreducedRunoffMm3.values.map(() => 0) },
				...(inp.parent ? { virginMarMm3: 2.5 } : {}),
				messages: []
			};
		};
		const result = runNetwork(withSfr, mode, { ...fakeSimulators(), reductions: [record] });
		const child = seen.find((s) => s.module.number === 1)!;
		expect(child.parent?.number).toBe(3);
		expect(child.parent?.paved?.fraction).toEqual(mode.kind === 'natural' ? [] : mode.kind === 'presentDay' ? [{ year: 1994, value: 0.1 }] : parent.paved.fraction);
		expect(child.mode).toEqual(mode);
		expect(seen.find((s) => s.module.number === 3)!.parent).toBeNull();
		expect(result.virginMarMm3).toEqual({ 1: 2.5 });
		expect(result.messages.some((m) => /not modelled yet/.test(m.text))).toBe(false);
	});

	it('reduces the routes the module feeds', () => {
		const bundle = syntheticBundle();
		const half: StreamflowReduction = (inp) => ({ reductionMm3: { ...inp.unreducedRunoffMm3, values: inp.unreducedRunoffMm3.values.map((v) => 0.5 * Math.max(0, v)) }, messages: [] });
		const base = runNetwork(bundle, { kind: 'historical' }, fakeSimulators());
		const reduced = runNetwork(bundle, { kind: 'historical' }, { ...fakeSimulators(), reductions: [half] });
		reduced.routeFlows[3]!.values.forEach((v, i) => {
			const q = base.routeFlows[3]!.values[i]!;
			expect(v).toBeCloseTo(q - 0.5 * Math.max(0, q), 12);
		});
		expect(base.virginMarMm3).toBeUndefined();
	});
});
