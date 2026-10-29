import { describe, expect, it } from 'vitest';
import type { ChannelModule, Module, Network, NetworkBundle, ReservoirModule, Route, RunoffModule } from '../types.js';
import { syntheticBundle } from './synthetic-bundle.js';
import { findCycles, networkDependencies, validateNetwork } from './validate.js';

function replace(bundle: NetworkBundle, module: Module): NetworkBundle {
	return { ...bundle, modules: bundle.modules.map((m) => (m.kind === module.kind && m.number === module.number ? module : m)) };
}
const withNetwork = (bundle: NetworkBundle, patch: Partial<Network>): NetworkBundle => ({ ...bundle, network: { ...bundle.network, ...patch } });
const ru = (b: NetworkBundle, n: number) => b.modules.find((m): m is RunoffModule => m.kind === 'RU' && m.number === n)!;
const cr = (b: NetworkBundle) => b.modules.find((m): m is ChannelModule => m.kind === 'CR')!;
const rv = (b: NetworkBundle) => b.modules.find((m): m is ReservoirModule => m.kind === 'RV')!;
const route = (b: NetworkBundle, n: number) => b.network.routes.find((r) => r.number === n)!;
const setRoute = (b: NetworkBundle, r: Route) => withNetwork(b, { routes: b.network.routes.map((x) => (x.number === r.number ? r : x)) });
const errors = (b: NetworkBundle) => validateNetwork(b).filter((m) => m.level === 'error').map((m) => m.text);
const warnings = (b: NetworkBundle) => validateNetwork(b).filter((m) => m.level === 'warning').map((m) => m.text);

describe('validateNetwork', () => {
	it('passes the synthetic bundle', () => {
		expect(validateNetwork(syntheticBundle())).toEqual([]);
	});

	it('reports a module list entry without a file, naming the file it looked for', () => {
		const b = syntheticBundle();
		expect(errors({ ...b, modules: b.modules.filter((m) => m.kind !== 'CR') })).toContain('SY.NET: module list position 6 is CR 4, but the network has no file SYCR4.DAT');
	});

	it('reports a module listed twice', () => {
		const b = syntheticBundle();
		expect(errors(withNetwork(b, { modules: [...b.network.modules, { number: 1, type: 'RU', solve: true }] }))).toContainEqual(
			expect.stringMatching(/RU 1 is listed twice in the module list \(positions 1 and 7\)/)
		);
	});

	it('reports route endpoints outside the module list, duplicate routes and routes that go nowhere', () => {
		const b = syntheticBundle();
		const bad = withNetwork(b, {
			routes: [
				...b.network.routes,
				{ number: 20, upstreamPosition: 7, downstreamPosition: 0, cost: 0 },
				{ number: 21, upstreamPosition: 0, downstreamPosition: -1, cost: 0 },
				{ number: 22, upstreamPosition: 0, downstreamPosition: 0, cost: 0 },
				{ number: 23, upstreamPosition: 6, downstreamPosition: 6, cost: 0 },
				{ number: 4, upstreamPosition: 6, downstreamPosition: 0, cost: 0 }
			]
		});
		const e = errors(bad);
		expect(e).toEqual(
			expect.arrayContaining([
				'SY.NET: route 20 upstream module is position 7, outside the module list (0–6)',
				'SY.NET: route 21 downstream module is position -1, outside the module list (0–6)',
				'SY.NET: route 22 runs from the zero module to the zero module',
				'SY.NET: route 23 starts and ends in CR 4 (position 6) (TT 689 p.48)',
				'SY.NET: route 4 is defined twice'
			])
		);
	});

	it('reports a route a module file names but the .NET lacks', () => {
		const b = syntheticBundle();
		const e = errors(replace(b, { ...rv(b), outflows: [...rv(b).outflows, { route: 77, definedFlowFile: null }] }));
		expect(e).toContain('RV 5 (SYRV5.DAT) names outflow route (L.013) 77, which is not a route in SY.NET');
	});

	it('reports a module file and the .NET disagreeing on where a route goes', () => {
		const b = syntheticBundle();
		const moved = setRoute(b, { ...route(b, 5), downstreamPosition: 0 });
		expect(errors(moved)).toContainEqual('CR 4 (SYCR4.DAT) names inflow route (L.008) 5, but SY.NET routes it to the zero module');
		const unnamed = replace(b, { ...ru(b, 3), outflows: [{ route: 2, percent: 100 }] });
		expect(errors(unnamed)).toEqual(
			expect.arrayContaining([
				'RU 3 (SYRU3.DAT) names outflow route (L.020) 2, but SY.NET routes it from RU 2 (position 2)',
				"route 3 leaves RU 3 in SY.NET, but SYRU3.DAT doesn't name it as an outflow route"
			])
		);
	});

	it('reports a zero-source route with no defined-flow file, and a defined-flow file the bundle lacks', () => {
		const b = syntheticBundle();
		const blank = replace(b, { ...cr(b), inflows: cr(b).inflows.map((c) => (c.route === 6 ? { ...c, definedFlowFile: null } : c)) });
		expect(errors(blank)).toContainEqual(expect.stringMatching(/^route 6 starts at the zero module, but CR 4 \(SYCR4\.DAT\) gives it no defined-flow file/));
		expect(errors({ ...b, flowFiles: {} })).toEqual(
			expect.arrayContaining([
				"CR 4 (SYCR4.DAT): route 6 names defined-flow file 'SYTRANS.ABS', which is not in the network",
				"CR 4 (SYCR4.DAT): route 9 names defined-flow file 'SYRQ9.ABS', which is not in the network"
			])
		);
	});

	it('warns when the two ends of a route name different defined-flow files', () => {
		const b = syntheticBundle();
		const both = replace(replace(b, { ...rv(b), outflows: [{ route: 5, definedFlowFile: 'SYRQ9.ABS' }] }), {
			...cr(b),
			inflows: cr(b).inflows.map((c) => (c.route === 5 ? { ...c, definedFlowFile: 'SYTRANS.ABS' } : c))
		});
		expect(warnings(both)).toEqual([
			"route 5: its upstream module names defined-flow file 'SYRQ9.ABS' and its downstream module 'SYTRANS.ABS'; a route has one (TT 691 §7.3.1); the downstream module reads 'SYTRANS.ABS'"
		]);
	});

	it('reports a missing rainfall file', () => {
		const b = syntheticBundle();
		expect(errors({ ...b, rainfall: {} })).toEqual(
			expect.arrayContaining(["RU 1 (SYRU1.DAT): rainfall file 'SYA.RAN' is not in the network", "RV 5 (SYRV5.DAT): rainfall file 'SYA.RAN' is not in the network"])
		);
	});

	it('checks RU outflow percentages against 100 % within half the F6.1 resolution per route', () => {
		const b = syntheticBundle();
		const three = (p: number) => {
			const routes: Route[] = [...b.network.routes, { number: 30, upstreamPosition: 3, downstreamPosition: 0, cost: 0 }, { number: 31, upstreamPosition: 3, downstreamPosition: 0, cost: 0 }];
			return replace(withNetwork(b, { routes }), { ...ru(b, 3), outflows: [{ route: 3, percent: p }, { route: 30, percent: p }, { route: 31, percent: p }] });
		};
		expect(errors(three(33.3))).toEqual([]);
		expect(errors(three(33))).toContainEqual('RU 3 (SYRU3.DAT): outflow route percentages (L.020) add up to 99 %, not 100 % (±0.15); flows would be created or destroyed (TT 689 p.56)');
		expect(errors(replace(b, { ...ru(b, 3), outflows: [{ route: 3, percent: 99.9 }] }))).toHaveLength(1);
		expect(errors(replace(b, { ...ru(b, 3), outflows: [] }))).toContainEqual(expect.stringMatching(/RU 3 \(SYRU3\.DAT\) has no outflow routes/));
	});

	it('reports a sequence error naming both modules, the route and the fix', () => {
		const b = syntheticBundle();
		// Swap RV5 (position 5) below CR4 (position 6).
		const modules = [...b.network.modules];
		[modules[4], modules[5]] = [modules[5]!, modules[4]!];
		const routes = b.network.routes.map((r) => ({
			...r,
			upstreamPosition: r.upstreamPosition === 5 ? 6 : r.upstreamPosition === 6 ? 5 : r.upstreamPosition,
			downstreamPosition: r.downstreamPosition === 5 ? 6 : r.downstreamPosition === 6 ? 5 : r.downstreamPosition
		}));
		const e = validateNetwork(withNetwork(b, { modules, routes })).filter((m) => m.level === 'error');
		expect(e).toEqual([
			{
				level: 'error',
				module: { type: 'CR', number: 4 },
				route: 5,
				text: 'sequence error: CR 4 takes route 5 from RV 5, but RV 5 (position 6) is solved after CR 4 (position 5); move RV 5 above CR 4 in the module list (TT 689 §6.1.16, p.56)'
			}
		]);
	});

	it('requires an irrigation module to come before the module that supplies it (TT 691 p.183)', () => {
		const b = syntheticBundle();
		// Move RR6 (position 4) to the end, after CR4.
		const modules = [...b.network.modules.slice(0, 3), ...b.network.modules.slice(4), b.network.modules[3]!];
		const map = (p: number) => (p === 4 ? 6 : p > 4 ? p - 1 : p);
		const routes = b.network.routes.map((r) => ({ ...r, upstreamPosition: map(r.upstreamPosition), downstreamPosition: map(r.downstreamPosition) }));
		expect(errors(withNetwork(b, { modules, routes }))).toEqual([
			'sequence error: CR 4 supplies irrigation route 7, whose demand RR 6 sets, but RR 6 (position 6) is solved after CR 4 (position 5); move RR 6 above CR 4 in the module list (TT 689 §6.1.16, p.56)'
		]);
	});

	it('lets a route read from a defined-flow file at its downstream end run against the module order', () => {
		const b = syntheticBundle();
		const modules = [...b.network.modules];
		[modules[4], modules[5]] = [modules[5]!, modules[4]!];
		const routes = b.network.routes.map((r) => ({
			...r,
			upstreamPosition: r.upstreamPosition === 5 ? 6 : r.upstreamPosition === 6 ? 5 : r.upstreamPosition,
			downstreamPosition: r.downstreamPosition === 5 ? 6 : r.downstreamPosition === 6 ? 5 : r.downstreamPosition
		}));
		const defined = replace(withNetwork(b, { modules, routes }), { ...cr(b), inflows: cr(b).inflows.map((c) => (c.route === 5 ? { ...c, definedFlowFile: 'SYTRANS.ABS' } : c)) });
		expect(errors(defined)).toEqual([]);
	});

	it('reports a solved module that depends on an unsolved one (TT 689 p.58)', () => {
		const b = syntheticBundle();
		const modules = b.network.modules.map((e) => (e.type === 'RU' && e.number === 1 ? { ...e, solve: false } : e));
		expect(errors(withNetwork(b, { modules }))).toEqual([
			'sequence error: RU 2 takes route 1 from RU 1, which is not solved (Solve = N). Every module that depends on an unsolved module must also be unsolved (TT 689 p.58; TT 691 p.183)'
		]);
		// Leaving everything downstream of it unsolved too is fine.
		const downstream = b.network.modules.map((e) => (['RU1', 'RU2', 'RV5', 'CR4'].includes(`${e.type}${e.number}`) ? { ...e, solve: false } : e));
		expect(errors(withNetwork(b, { modules: downstream }))).toEqual([]);
	});

	it('rejects an irrigation return flow into its own supplier or upstream of it (TT 689 p.85)', () => {
		const b = syntheticBundle();
		// Return flow route 8 from RR6 back into CR4, its supplier.
		let own = setRoute(b, { ...route(b, 8), downstreamPosition: 6 });
		own = replace(own, { ...cr(own), inflows: [...cr(own).inflows, { route: 8, definedFlowFile: null }] });
		const e = errors(own);
		expect(e).toContain(
			'RR 6 (SYRR6.DAT): return-flow route 8 goes back into CR 4 (position 6), which supplies it through route 7; a return flow may only go to the zero sink or downstream of the supplier (TT 689 p.85, p.104)'
		);
		// Return flow into RV5, which drains into CR4 (upstream of the supplier): a loop.
		let up = setRoute(b, { ...route(b, 8), downstreamPosition: 5 });
		up = replace(up, { ...rv(up), inflows: [...rv(up).inflows, { route: 8, definedFlowFile: null }] });
		expect(errors(up).filter((t) => t.startsWith('circular'))).toEqual([expect.stringMatching(/^circular routing between RV 5, CR 4 \(routes 5, 8\)/)]);

		// A return into a channel listed after the irrigation module but before its supplier, on a branch
		// the supplier doesn't drain into, is accepted (R3-N22).
		const shift = (p: number) => (p >= 5 ? p + 1 : p);
		const modules = [...b.network.modules.slice(0, 4), { number: 9, type: 'CR' as const, solve: true }, ...b.network.modules.slice(4)];
		const routes = [
			...b.network.routes.map((r) => ({ ...r, upstreamPosition: shift(r.upstreamPosition), downstreamPosition: r.number === 8 ? 5 : shift(r.downstreamPosition) })),
			{ number: 40, upstreamPosition: 5, downstreamPosition: 0, cost: 0 }
		];
		const cr9: ChannelModule = { ...cr(b), number: 9, inflows: [{ route: 8, definedFlowFile: null }], outflows: [{ route: 40, definedFlowFile: null }], principalOutflowRoute: 40 };
		const side: NetworkBundle = { ...withNetwork(b, { modules, routes }), modules: [...b.modules, cr9] };
		expect(errors(side)).toEqual([]);
	});

	it('rejects an RU outflow route listed twice in L.020', () => {
		const b = syntheticBundle();
		expect(errors(replace(b, { ...ru(b, 3), outflows: [{ route: 3, percent: 50 }, { route: 3, percent: 50 }] }))).toContain('RU 3 (SYRU3.DAT): outflow route 3 is listed more than once in L.020');
	});

	it('reports circular routing once, naming every module in the loop', () => {
		const b = syntheticBundle();
		// CR4's principal route goes back into RV5 (CR4 -> RV5 -> CR4).
		let loop = setRoute(b, { ...route(b, 4), downstreamPosition: 5 });
		loop = replace(loop, { ...rv(loop), inflows: [...rv(loop).inflows, { route: 4, definedFlowFile: null }] });
		const e = errors(loop);
		expect(e.filter((t) => t.startsWith('circular'))).toEqual([
			'circular routing between RV 5, CR 4 (routes 4, 5): each waits for another, so no module order can solve it (TT 689 p.48, p.104)'
		]);
		expect(e.filter((t) => t.startsWith('sequence'))).toEqual([]);
	});

	it('checks gauges and summary lines', () => {
		const b = syntheticBundle();
		const n = withNetwork(b, {
			gauges: [...b.network.gauges, { route: 99, label: 'G2', observedFile: 'G2.OBS' }],
			summaryLines: [
				{ kind: 'RT', number: 98, quantity: 'Q' },
				{ kind: 'RV', number: 7, quantity: 'Q' },
				{ kind: 'RV', number: 5, quantity: 'Q' }
			]
		});
		expect(errors(n)).toEqual(["SY.NET: gauge 'G2' is on route 99, which is not in the network"]);
		expect(warnings(n)).toEqual([
			"SY.NET: observed-flow file 'G2.OBS' for route 99 is not in the network; the gauge has nothing to compare",
			'SY.NET: summary line asks for route 98, which is not in the network',
			'SY.NET: summary line asks for reservoir RV 7, which is not in the network'
		]);
	});

	it('checks SFR children and the upstream groundwater module', () => {
		const b = syntheticBundle();
		const parent = replace(b, { ...ru(b, 1), sfrChildren: [3, 40] });
		expect(errors(parent)).toEqual(['RU 1 (SYRU1.DAT): SFR child RU 40 (L.039) is not in SY.NET']);
		expect(warnings(parent)).toEqual([expect.stringMatching(/RU 3 \(SYRU3\.DAT\): an SFR child should have one outflow route carrying 100 % to the zero module/)]);
		expect(errors(replace(b, { ...ru(b, 2), upstreamGroundwaterModule: 9 }))).toEqual(['RU 2 (SYRU2.DAT): upstream groundwater module RU 9 (L.021) is not in SY.NET']);
		// RU 3 taking its groundwater state from RU 2, which is solved first: fine. The other way round is a sequence error.
		expect(errors(replace(b, { ...ru(b, 3), upstreamGroundwaterModule: 2 }))).toEqual([]);
		expect(errors(replace(b, { ...ru(b, 1), upstreamGroundwaterModule: 3 }))).toEqual([
			'sequence error: RU 1 takes its groundwater state from RU 3, but RU 3 (position 3) is solved after RU 1 (position 1); move RU 3 above RU 1 in the module list (TT 689 §6.1.16, p.56)'
		]);
	});

	it('warns when a module has more routes than TT 689 Table 2.1 allows', () => {
		const b = syntheticBundle();
		const extra = [30, 31, 32, 33, 34];
		const n = replace(withNetwork(b, { routes: [...b.network.routes, ...extra.map((number) => ({ number, upstreamPosition: 5, downstreamPosition: 0, cost: 0 }))] }), {
			...rv(b),
			outflows: [...rv(b).outflows, ...extra.map((r) => ({ route: r, definedFlowFile: null }))]
		});
		expect(warnings(n)).toEqual(['RV 5 (SYRV5.DAT) has 6 outflow routes; TT 689 Table 2.1 allows 5']);
	});

	it('reports every problem at once', () => {
		const b = syntheticBundle();
		const many = withNetwork({ ...b, rainfall: {}, flowFiles: {} }, { routes: [...b.network.routes, { number: 60, upstreamPosition: 0, downstreamPosition: 0, cost: 0 }] });
		expect(errors(many).length).toBeGreaterThanOrEqual(6);
	});
});

describe('networkDependencies and findCycles', () => {
	it('lists flow, demand and groundwater dependencies', () => {
		const b = replace(syntheticBundle(), { ...ru(syntheticBundle(), 3), upstreamGroundwaterModule: 1 });
		expect(networkDependencies(b)).toEqual([
			{ before: 1, after: 2, kind: 'flow', route: 1 },
			{ before: 2, after: 5, kind: 'flow', route: 2 },
			{ before: 3, after: 6, kind: 'flow', route: 3 },
			{ before: 5, after: 6, kind: 'flow', route: 5 },
			{ before: 4, after: 6, kind: 'demand', route: 7 },
			{ before: 1, after: 3, kind: 'groundwater' }
		]);
	});

	it('finds every loop, including long chains', () => {
		expect(findCycles(4, [{ before: 1, after: 2, kind: 'flow' }, { before: 2, after: 1, kind: 'flow' }, { before: 3, after: 4, kind: 'flow' }])).toEqual([[1, 2]]);
		const n = 20000;
		const chain = Array.from({ length: n }, (_, i) => ({ before: i + 1, after: ((i + 1) % n) + 1, kind: 'flow' as const }));
		expect(findCycles(n, chain)).toHaveLength(1);
		expect(findCycles(n, chain.slice(0, -1))).toEqual([]);
	});
});
