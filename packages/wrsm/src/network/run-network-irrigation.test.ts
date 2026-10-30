/**
 * Irrigation through the whole network, on the real simulators: the demand
 * stream to the supplier, the supply stream back, the return flow on its
 * route, and the order of solution (docs/theory/irrigation.md §2).
 */

import { describe, expect, it } from 'vitest';
import { IrrigationRunError } from '../irrigation/demand.js';
import { pitmanBlock, twelve, wqt4Block, wqtBlock } from '../irrigation/fixtures.js';
import { DEFAULT_SIMULATORS, run } from '../run.js';
import type { ChannelModule, IrrigationModule, Module, MonthlySeries, NetworkBundle, ReservoirModule, RunMode, RunResult, RunoffModule } from '../types.js';
import { zeroSeries, type ModuleSimulators } from './contract.js';
import { fakeSimulators } from './fake-simulators.js';
import { runNetwork } from './run-network.js';
import { syntheticBundle } from './synthetic-bundle.js';
import { NetworkError } from './validate.js';

const HISTORICAL: RunMode = { kind: 'historical' };

function replace(bundle: NetworkBundle, module: Module): NetworkBundle {
	return { ...bundle, modules: bundle.modules.map((m) => (m.kind === module.kind && m.number === module.number ? module : m)) };
}

const withBlock = (bundle: NetworkBundle, over: Partial<IrrigationModule> = {}, block: IrrigationModule = pitmanBlock()): NetworkBundle => {
	const rr = bundle.modules.find((m): m is IrrigationModule => m.kind === 'RR')!;
	const rainfallFile = rr.rainfallFile;
	return replace(bundle, { ...block, number: rr.number, abstractionRoute: rr.abstractionRoute, returnFlowRoute: rr.returnFlowRoute, rainfallFile, ...over } as IrrigationModule);
};

const sum = (s: MonthlySeries): number => s.values.reduce((a, b) => a + b, 0);
const channel = (b: NetworkBundle) => b.modules.find((m): m is ChannelModule => m.kind === 'CR')!;
const runoff = (b: NetworkBundle, n: number) => b.modules.find((m): m is RunoffModule => m.kind === 'RU' && m.number === n)!;
const span = (b: NetworkBundle) => [{ year: b.network.startYear, value: 2 }, { year: b.network.endYear, value: 2 }];

describe('the demand and supply streams', () => {
	const bundle = syntheticBundle();

	it('puts the demand on the supplier, the supply back on the block, and the return on its route', () => {
		const result = run(bundle, HISTORICAL);
		const rr = result.irrigation![6]!;
		expect(sum(rr.demand)).toBeGreaterThan(0);
		expect(rr.supply.values).toEqual(result.routeFlows[7]!.values);
		rr.supply.values.forEach((v, t) => expect(v).toBeLessThanOrEqual(rr.demand.values[t]! + 1e-9));
		expect(result.routeFlows[8]!.values).toEqual(rr.returnFlow.values);
		// Pitman block: RRPERC 10 % of the supply (eq. 3.4).
		result.routeFlows[8]!.values.forEach((v, t) => expect(v).toBeCloseTo(0.1 * rr.supply.values[t]!, 12));
	});

	it('takes the abstraction out of the river', () => {
		const without = run(replace(bundle, { ...bundle.modules.find((m): m is IrrigationModule => m.kind === 'RR')!, areaKm2: [] }), HISTORICAL);
		const withIt = run(bundle, HISTORICAL);
		const gone = sum(without.routeFlows[4]!) - sum(withIt.routeFlows[4]!);
		expect(gone).toBeCloseTo(sum(withIt.routeFlows[7]!), 6);
	});

	it('cuts the block back when the river runs short, and its return with it', () => {
		const huge = withBlock(bundle, { areaKm2: [{ year: bundle.network.startYear, value: 5000 }] });
		const result = run(huge, HISTORICAL);
		const rr = result.irrigation![6]!;
		expect(sum(rr.supply)).toBeLessThan(sum(rr.demand));
		rr.returnFlow.values.forEach((v, t) => expect(v).toBeCloseTo(0.1 * rr.supply.values[t]!, 12));
		expect(result.messages).toContainEqual(expect.objectContaining({ module: { type: 'CR', number: 4 }, text: expect.stringContaining('failures to supply calculated demands') }));
		expect(result.messages).toContainEqual(expect.objectContaining({ module: { type: 'RR', number: 6 }, text: expect.stringContaining('fell short of demand') }));
	});

	it('supplies from a reservoir too, drawing it down', () => {
		// RR6 draws from RV5 instead of CR4.
		const net = bundle.network;
		const rv = bundle.modules.find((m): m is ReservoirModule => m.kind === 'RV')!;
		const cr = channel(bundle);
		const moved: NetworkBundle = {
			...bundle,
			network: { ...net, routes: net.routes.map((r) => (r.number === 7 ? { ...r, upstreamPosition: 5 } : r)) },
			modules: bundle.modules.map((m) =>
				m === rv ? { ...rv, outflows: [...rv.outflows, { route: 7, definedFlowFile: null }] } : m === cr ? { ...cr, outflows: cr.outflows.filter((o) => o.route !== 7) } : m
			)
		};
		const a = run(moved, HISTORICAL);
		const noBlock = run(withBlock(moved, { areaKm2: [] }), HISTORICAL);
		expect(sum(a.routeFlows[7]!)).toBeGreaterThan(0);
		expect(sum(a.reservoirStorage[5]!)).toBeLessThan(sum(noBlock.reservoirStorage[5]!) + 1e-9);
		expect(a.irrigation![6]!.supply.values).toEqual(a.routeFlows[7]!.values);
	});
});

describe('every method through the network', () => {
	const bundle = syntheticBundle();
	const span2 = { areaKm2: span(bundle) };
	const blocks: readonly [string, IrrigationModule][] = [
		['Pitman', pitmanBlock(span2)],
		['WQT', wqtBlock(span2)],
		['SAPWAT', wqtBlock({ ...span2, modelType: 3, crops: [{ factors: twelve(120), percent: 100, description: 'r' }] })],
		['type 4', wqt4Block({ ...span2, rainfallFactors: twelve(0.5), maxRainfallFactors: twelve(0.5) })]
	];

	for (const [name, block] of blocks) {
		it(`${name}: demands, returns, and the supply never tops the demand`, () => {
			const result = run(withBlock(bundle, {}, block), HISTORICAL);
			const rr = result.irrigation![6]!;
			expect(sum(rr.demand)).toBeGreaterThan(0);
			expect(sum(result.routeFlows[8]!)).toBeGreaterThan(0);
			rr.supply.values.forEach((v, t) => expect(v).toBeLessThanOrEqual(rr.demand.values[t]! + 1e-9));
			expect(result.messages.filter((m) => m.level === 'error')).toEqual([]);
		});
	}
});

describe('the run modes (D1)', () => {
	const bundle = syntheticBundle();
	const growing = { areaKm2: [{ year: bundle.network.startYear, value: 1 }, { year: bundle.network.endYear, value: 3 }] };

	it('natural removes the block: no demand, no supply, zeros on both routes', () => {
		const result = run(withBlock(bundle, growing), { kind: 'natural' });
		expect(result.irrigation).toBeUndefined();
		expect(sum(result.routeFlows[7]!)).toBe(0);
		expect(sum(result.routeFlows[8]!)).toBe(0);
		expect(result.messages).toContainEqual(expect.objectContaining({ level: 'info', module: { type: 'RR', number: 6 } }));
	});

	it('historical follows the area table; present day holds it', () => {
		const { startYear, endYear } = bundle.network;
		const historical = run(withBlock(bundle, growing), HISTORICAL).irrigation![6]!;
		const held = run(withBlock(bundle, growing), { kind: 'presentDay', year: endYear }).irrigation![6]!;
		expect(historical.areaKm2[0]).toBe(1);
		expect(historical.areaKm2[historical.areaKm2.length - 1]).toBe(3);
		expect(new Set(held.areaKm2)).toEqual(new Set([3]));
		expect(startYear).toBeLessThan(endYear);
		expect(sum(held.demand)).toBeGreaterThan(sum(historical.demand));
	});

	it('a solved supplier of an unsolved block stays a sequence error (R3-N21)', () => {
		const net = bundle.network;
		const off: NetworkBundle = { ...bundle, network: { ...net, modules: net.modules.map((e) => (e.type === 'RR' ? { ...e, solve: false } : e)) } };
		expect(() => run(off, HISTORICAL)).toThrow(NetworkError);
	});
});

describe('the water balance of the network', () => {
	it('closes with the block as a sink and its return as a source (fake simulators, every month)', () => {
		const bundle = syntheticBundle();
		const { simulators, ledger } = fakeSimulators();
		const result = runNetwork(bundle, HISTORICAL, { simulators });
		const { network } = bundle;
		for (let t = 0; t < result.routeFlows[4]!.values.length; t++) {
			let gain = 0;
			for (const d of Object.values(result.runoff ?? {})) gain += d.netRunoff!.values[t]!;
			let leave = 0;
			for (const r of network.routes) {
				const v = result.routeFlows[r.number]!.values[t]!;
				if (r.upstreamPosition === 0 || network.modules[r.upstreamPosition - 1]?.type === 'RR') gain += v;
				if (r.upstreamPosition !== 0 && (r.downstreamPosition === 0 || network.modules[r.downstreamPosition - 1]?.type === 'RR')) leave += v;
			}
			const s = result.reservoirStorage[5]!.values;
			const change = s[t]! - (t === 0 ? ledger.initialStorage.get(5)! : s[t - 1]!);
			expect(gain - leave - change - (ledger.lossPerMonth[t] ?? 0)).toBeCloseTo(0, 8);
		}
		expect(sum(result.routeFlows[7]!)).toBeGreaterThan(0);
	});

	it('supplied = return + used, month by month, on the real simulators', () => {
		const bundle = syntheticBundle();
		const rr = run(bundle, HISTORICAL).irrigation![6]!;
		rr.supply.values.forEach((v, t) => expect(rr.returnFlow.values[t]! + rr.evapotranspiration.values[t]!).toBeCloseTo(v, 12));
	});
});

describe('the order of solution (R7-I2)', () => {
	it('solves the supplier ahead of a module listed earlier that takes the return flow (R3-N22)', () => {
		// RU1 RU2 RU3 RR6 | CR9 (takes the return) | RV5 CR4 (supplies RR6). CR9 drains to the zero sink, on its own branch.
		const bundle = syntheticBundle();
		const net = bundle.network;
		const cr = channel(bundle);
		const branch: ChannelModule = { ...cr, number: 9, bedLossMm3PerMonth: 0, inflows: [{ route: 8, definedFlowFile: null }], outflows: [{ route: 10, definedFlowFile: null }], principalOutflowRoute: 10 };
		const position = (p: number) => (p >= 5 ? p + 1 : p);
		const modules = [...net.modules.slice(0, 4), { number: 9, type: 'CR' as const, solve: true }, ...net.modules.slice(4)];
		const routes = net.routes.map((r) => ({ ...r, upstreamPosition: position(r.upstreamPosition), downstreamPosition: r.number === 8 ? 5 : position(r.downstreamPosition) }));
		const listed: NetworkBundle = {
			...bundle,
			network: { ...net, modules, routes: [...routes, { number: 10, upstreamPosition: 5, downstreamPosition: 0, cost: 0 }] },
			modules: [...bundle.modules, branch]
		};
		const calls: string[] = [];
		const simulators: ModuleSimulators = {
			reservoir: (m, i, c, d) => {
				calls.push(`RV${m.number}`);
				return DEFAULT_SIMULATORS.reservoir(m, i, c, d);
			},
			channel: (m, i, c, d) => {
				calls.push(`CR${m.number}`);
				return DEFAULT_SIMULATORS.channel(m, i, c, d);
			}
		};
		const result = runNetwork(listed, HISTORICAL, { simulators });
		expect(calls).toEqual(['RV5', 'CR4', 'CR9']);
		expect(sum(result.routeFlows[8]!)).toBeGreaterThan(0);
		expect(result.routeFlows[10]!.values).toEqual(result.routeFlows[8]!.values);
		expect(result.messages).toContainEqual(expect.objectContaining({ level: 'info', route: 8, text: expect.stringContaining('solved ahead of') }));
	});

	it('still rejects a return into the supplier (TT 689 p.85)', () => {
		const bundle = syntheticBundle();
		const net = bundle.network;
		const cr = channel(bundle);
		const back: NetworkBundle = {
			...bundle,
			network: { ...net, routes: net.routes.map((r) => (r.number === 8 ? { ...r, downstreamPosition: 6 } : r)) },
			modules: bundle.modules.map((m) => (m === cr ? { ...cr, inflows: [...cr.inflows, { route: 8, definedFlowFile: null }] } : m))
		};
		expect(() => run(back, HISTORICAL)).toThrow(NetworkError);
	});
});

describe('routes the supplier does not control by demand', () => {
	const bundle = syntheticBundle();

	it('a route defined by file keeps the file; the block takes what it brings (R7-I19)', () => {
		const cr = channel(bundle);
		const defined = replace(bundle, { ...cr, outflows: cr.outflows.map((o) => (o.route === 7 ? { ...o, definedFlowFile: 'SYRQ9.ABS' } : o)) });
		const result = run(defined, HISTORICAL);
		expect(result.irrigation![6]!.supply.values).toEqual(result.routeFlows[9]!.values);
		expect(result.messages).toContainEqual(expect.objectContaining({ level: 'info', route: 7, text: expect.stringContaining("defined by 'SYRQ9.ABS'") }));
	});

	it('a block drawing straight on a runoff module takes all of it, as TT 689 p.168 warns (R7-I16)', () => {
		// RU3's only route goes to the block, which is listed first.
		const net = bundle.network;
		const ru3 = runoff(bundle, 3);
		const cr = channel(bundle);
		const modules = [net.modules[3]!, net.modules[0]!, net.modules[1]!, net.modules[2]!, net.modules[4]!, net.modules[5]!];
		const move = (p: number) => (p === 0 ? 0 : p === 4 ? 1 : p <= 3 ? p + 1 : p);
		const routes = net.routes.filter((r) => r.number !== 3).map((r) => ({ ...r, upstreamPosition: move(r.upstreamPosition), downstreamPosition: move(r.downstreamPosition) }));
		const direct: NetworkBundle = {
			...bundle,
			network: { ...net, modules, routes: routes.map((r) => (r.number === 7 ? { ...r, upstreamPosition: 4 } : r)) },
			modules: bundle.modules.map((m) => (m === ru3 ? { ...ru3, outflows: [{ route: 7, percent: 100 }] } : m === cr ? { ...cr, inflows: cr.inflows.filter((c) => c.route !== 3), outflows: cr.outflows.filter((o) => o.route !== 7) } : m))
		};
		const result = run(direct, HISTORICAL);
		const rr = result.irrigation![6]!;
		expect(rr.supply.values).toEqual(result.routeFlows[7]!.values);
		expect(sum(rr.supply)).toBeGreaterThan(0);
		expect(result.messages).toContainEqual(expect.objectContaining({ level: 'warning', route: 7, text: expect.stringContaining('more than the block demanded') }));
	});
});

describe('the runoff module a WQT block lies in', () => {
	const bundle = syntheticBundle();
	const block = (over = {}) => wqtBlock({ areaKm2: span(bundle), runoffModule: 3, ...over });

	it('net return: the runoff module keeps all its area, the block reads its unit runoff (eqs. 4.18, 4.19)', () => {
		const withQc = run(withBlock(bundle, {}, block()), HISTORICAL);
		const noQc = run(withBlock(bundle, {}, block({ runoffModule: 0 })), HISTORICAL);
		expect(withQc.routeFlows[3]!.values).toEqual(noQc.routeFlows[3]!.values);
		expect(withQc.irrigation![6]!.soilMoistureMm.values).not.toEqual(noQc.irrigation![6]!.soilMoistureMm.values);
	});

	it('total return: the module gives up the block\'s area and the flow comes back on the return route (TT 689 p.106, R7-I13)', () => {
		const net = run(withBlock(bundle, {}, block()), HISTORICAL);
		const total = run(withBlock(bundle, {}, block({ netReturnFlows: false })), HISTORICAL);
		const ru = runoff(bundle, 3);
		const share = 2 / ru.areaKm2;
		const diff = sum(net.routeFlows[3]!) - sum(total.routeFlows[3]!);
		expect(diff).toBeCloseTo(sum(net.routeFlows[3]!) * share, 8);
		expect(sum(total.routeFlows[8]!)).toBeGreaterThan(sum(net.routeFlows[8]!));
	});

	it('type 4 is always net: the flag changes nothing (TT 691 p.172, R7-I13)', () => {
		const t4 = (over = {}) => wqt4Block({ areaKm2: span(bundle), runoffModule: 3, ...over });
		const a = run(withBlock(bundle, {}, t4()), HISTORICAL);
		const b = run(withBlock(bundle, {}, t4({ netReturnFlows: false })), HISTORICAL);
		expect(b.routeFlows[3]!.values).toEqual(a.routeFlows[3]!.values);
		expect(b.routeFlows[8]!.values).toEqual(a.routeFlows[8]!.values);
	});

	it('warns when the module is missing, or comes later in the list, and carries on without QC (R7-I12)', () => {
		const missing = run(withBlock(bundle, {}, block({ runoffModule: 77 })), HISTORICAL);
		expect(missing.messages).toContainEqual(expect.objectContaining({ level: 'warning', text: expect.stringContaining('RU 77 (L.013) is not in the network') }));
		expect(sum(missing.routeFlows[7]!)).toBeGreaterThan(0);
	});
});

describe('errors', () => {
	const bundle = syntheticBundle();

	it('a block with a rainfall file the network lacks fails validation', () => {
		const lost = withBlock(bundle, { rainfallFile: 'NOPE.RAN' });
		expect(() => run(lost, HISTORICAL)).toThrow(NetworkError);
	});

	it('a block that can\'t compute fails the run naming it', () => {
		const bad = withBlock(bundle, {}, wqtBlock({ efficiencyFactor: 0, areaKm2: span(bundle) }));
		let caught: unknown;
		try {
			run(bad, HISTORICAL);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(NetworkError);
		expect((caught as NetworkError).cause).toBeInstanceOf(IrrigationRunError);
		expect(String((caught as Error).message)).toContain('RR 6');
	});
});

describe('the contract', () => {
	it('tells simulators nothing they did not ask for: no block, no demands', () => {
		const bundle = syntheticBundle();
		const noBlock = withBlock(bundle, { areaKm2: [] });
		const seen: number[] = [];
		const simulators: ModuleSimulators = {
			...DEFAULT_SIMULATORS,
			channel: (m, i, c, d) => {
				seen.push(Object.keys(d ?? {}).length);
				return DEFAULT_SIMULATORS.channel(m, i, c, d);
			}
		};
		const result: RunResult = runNetwork(noBlock, { kind: 'natural' }, { simulators });
		expect(seen).toEqual([0]);
		expect(result.routeFlows[7]).toEqual(zeroSeries(bundle.network.startYear, bundle.network.endYear));
	});
});
