import { describe, expect, it } from 'vitest';
import { fakeSamiParts, syntheticSamiParameters } from '../groundwater/sami/fake-parts.js';
import type { ReductionInput, StreamflowReduction } from '../landuse/contract.js';
import type { Module, NetworkBundle, RunMode, RunoffModule } from '../types.js';
import { fakeSimulators } from './fake-simulators.js';
import { runNetwork } from './run-network.js';
import { samiOnArea } from './sfr-groups.js';
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

describe('runNetwork with SFR groups (landuse/sfr.ts)', () => {
	const MODES: readonly RunMode[] = [{ kind: 'historical' }, { kind: 'presentDay', year: 1994 }, { kind: 'natural' }];
	const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

	/** RU3 is the parent of RU1 (listed before it, at position 1), whose afforested area grows from 10 to 20 km². */
	function sfrBundle(): NetworkBundle {
		const bundle = syntheticBundle();
		const parent: RunoffModule = { ...ru(bundle, 3), sfrChildren: [1] };
		const child: RunoffModule = { ...ru(bundle, 1), afforestation: { algorithm: 4, algorithmInFile: true, areaKm2: [{ year: 1990, value: 10 }, { year: 1999, value: 20 }] } };
		return replace(bundle, parent, child);
	}

	it.each(MODES.map((m) => [m.kind, m] as const))('runs the group once, puts child and parent flows on their routes, and collects virgin MAR (%s)', (_kind, mode) => {
		const calls: number[] = [];
		const virginOnly = ({ child }: { child: RunoffModule }) => (calls.push(child.number), { targets: null, label: 'test', messages: [] });
		const result = runNetwork(sfrBundle(), mode, { ...fakeSimulators(), sfr: { targets: { forest: virginOnly } } });
		const child = result.runoff![1]!;
		const parent = result.runoff![3]!;
		// RU1's route 1 (into RU2) carries the child's flow; RU3's route 3 its own plus the child's.
		expect(result.routeFlows[1]!.values).toEqual(child.netRunoff!.values);
		expect(result.routeFlows[3]!.values).toEqual(parent.netRunoff!.values);
		if (mode.kind === 'natural') {
			expect(calls).toEqual([]); // TT 689 p.13: children have no effect
			expect(sum(child.netRunoff!.values)).toBe(0);
			expect(result.virginMarMm3).toBeUndefined();
		} else {
			expect(calls).toEqual([1]);
			expect(sum(child.netRunoff!.values)).toBeGreaterThan(0);
			expect(result.virginMarMm3?.[1]).toBeGreaterThan(0);
		}
	});

	it('takes the child area out of the parent and weights the parent depths by area (TT 689 p.140, pp.13–14)', () => {
		const bundle = sfrBundle();
		const free = runNetwork(syntheticBundle(), { kind: 'historical' }, fakeSimulators());
		const result = runNetwork(bundle, { kind: 'historical' }, { ...fakeSimulators(), sfr: { targets: { forest: () => ({ targets: null, label: 'test', messages: [] }) } } });
		// A virgin child inherits the parent's climate and parameters, so the group's total equals the parent run on its full area.
		result.routeFlows[3]!.values.forEach((v, i) => expect(v).toBeCloseTo(free.routeFlows[3]!.values[i]!, 9));
		const s = result.runoff![3]!.soilMoistureMm!.values;
		s.forEach((v, i) => expect(v).toBeCloseTo(free.runoff![3]!.soilMoistureMm!.values[i]!, 9));
	});
});

describe('the SFR simulator (network/sfr-groups.ts)', () => {
	it('keeps the groundwater evaporation area a share of the catchment on a smaller area (R6-R5)', () => {
		const bundle = syntheticBundle();
		const m = { ...asSami(ru(bundle, 3)), areaKm2: 25 };
		const scaled = samiOnArea(m, 100);
		expect(scaled.sami!.gwEvaporationArea).toBeCloseTo((m.sami!.gwEvaporationArea * 25) / 100, 12);
		expect(samiOnArea({ ...m, areaKm2: 100 }, 100)).toEqual({ ...m, areaKm2: 100 });
		expect(samiOnArea(ru(bundle, 3), 100)).toBe(ru(bundle, 3));
	});

	it("runs a paved parent on its active area with AI·AREA/active (R6-P1)", () => {
		const bundle = syntheticBundle();
		const parent: RunoffModule = { ...ru(bundle, 3), sfrChildren: [1], paved: { fraction: [{ year: 1990, value: 0.1 }] } };
		const child: RunoffModule = { ...ru(bundle, 1), afforestation: { algorithm: 4, algorithmInFile: true, areaKm2: [{ year: 1990, value: parent.areaKm2 / 2 }] } };
		const result = runNetwork(replace(bundle, parent, child), { kind: 'historical' }, { ...fakeSimulators(), sfr: { targets: { forest: () => ({ targets: null, label: 'test', messages: [] }) } } });
		// Paved km² are conserved: 0.1·AREA over the remaining half of the area is AI 0.2 there, and the child has none.
		const pavedMm3 = result.runoff![3]!.pavedFlow!.values;
		const rainMm = (bundle.rainfall[parent.rainfallFile.toUpperCase()] ?? Object.values(bundle.rainfall)[0]!).rows[0]!.months[2] / 100 * parent.mapMm;
		expect(pavedMm3[2]).toBeCloseTo((0.1 * parent.areaKm2 * rainMm) / 1000, 9);
	});
});
