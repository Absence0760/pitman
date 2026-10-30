import { describe, expect, it } from 'vitest';
import { PitmanRunError, runRunoffModule } from '../runoff/pitman.js';
import type { Module, MonthlySeries, NetworkBundle, RunMode, RunoffModule, RunResult } from '../types.js';
import { monthCount, zeroSeries, type ModuleSimulators } from './contract.js';
import { fakeSimulators, type Ledger } from './fake-simulators.js';
import { applyRunMode } from './modes.js';
import { runNetwork } from './run-network.js';
import { syntheticBundle } from './synthetic-bundle.js';
import { NetworkError } from './validate.js';

const MODES: readonly RunMode[] = [{ kind: 'historical' }, { kind: 'presentDay', year: 1994 }, { kind: 'natural' }];

function replace(bundle: NetworkBundle, module: Module): NetworkBundle {
	return { ...bundle, modules: bundle.modules.map((m) => (m.kind === module.kind && m.number === module.number ? module : m)) };
}

function ru(bundle: NetworkBundle, n: number): RunoffModule {
	return bundle.modules.find((m): m is RunoffModule => m.kind === 'RU' && m.number === n)!;
}

/**
 * Network water balance per month: runoff generated + defined inflows +
 * irrigation return flows = flow leaving (to the zero sink, or into a module
 * that isn't simulated, an irrigation block taking what its route brings)
 * + storage change + losses the simulators report.
 */
function balance(bundle: NetworkBundle, result: RunResult, ledger: Ledger): number[] {
	const { network } = bundle;
	const length = monthCount(result.startYear, result.endYear);
	const consumes = (position: number) => {
		if (position === 0) return true;
		const entry = network.modules[position - 1]!;
		return !entry.solve || entry.type === 'RR' || entry.type === 'MM' || bundle.modules.some((m) => m.kind === 'unparsed' && m.number === entry.number && m.moduleType === entry.type);
	};
	const residual: number[] = [];
	for (let i = 0; i < length; i++) {
		let gain = 0;
		for (const d of Object.values(result.runoff ?? {})) gain += d.netRunoff!.values[i]!;
		let leave = 0;
		for (const r of network.routes) {
			const v = result.routeFlows[r.number]!.values[i]!;
			if (r.upstreamPosition === 0 || network.modules[r.upstreamPosition - 1]?.type === 'RR') gain += v;
			if (consumes(r.downstreamPosition) && r.upstreamPosition !== 0) leave += v;
		}
		let storage = 0;
		for (const [n, s] of Object.entries(result.reservoirStorage)) {
			const before = i === 0 ? ledger.initialStorage.get(Number(n))! : s.values[i - 1]!;
			storage += s.values[i]! - before;
		}
		residual.push(gain - leave - storage - (ledger.lossPerMonth[i] ?? 0));
	}
	return residual;
}

describe('runNetwork on the synthetic bundle', () => {
	for (const mode of MODES) {
		it(`closes the network water balance every month (${mode.kind})`, () => {
			const bundle = syntheticBundle();
			const { simulators, ledger } = fakeSimulators();
			const result = runNetwork(bundle, mode, { simulators });
			const residual = balance(bundle, result, ledger);
			expect(Math.max(...residual.map(Math.abs))).toBeLessThan(1e-9);
			// Something actually flowed and was stored, so the check isn't vacuous.
			expect(result.routeFlows[4]!.values.some((v) => v > 0)).toBe(true);
			if (mode.kind !== 'natural') expect(result.routeFlows[6]!.values.every((v) => v > 0)).toBe(true);
		});

		it(`gives every route a series covering the run (${mode.kind})`, () => {
			const bundle = syntheticBundle({ years: 7 });
			const result = runNetwork(bundle, mode, fakeSimulators());
			expect(Object.keys(result.routeFlows).map(Number)).toEqual(bundle.network.routes.map((r) => r.number));
			for (const s of Object.values(result.routeFlows)) {
				expect(s.startYear).toBe(bundle.network.startYear);
				expect(s.values).toHaveLength(7 * 12);
				expect(s.unit).toBe('Mm3');
				expect(s.values.every(Number.isFinite)).toBe(true);
			}
			expect(result).toMatchObject({ mode, startYear: bundle.network.startYear, endYear: bundle.network.endYear });
		});
	}

	it('is deterministic', () => {
		const bundle = syntheticBundle({ seed: 7 });
		const a = runNetwork(bundle, { kind: 'historical' }, fakeSimulators());
		const b = runNetwork(bundle, { kind: 'historical' }, fakeSimulators());
		expect(b).toEqual(a);
	});

	it('does not change the bundle', () => {
		const bundle = syntheticBundle();
		const before = structuredClone(bundle);
		runNetwork(bundle, { kind: 'natural' }, fakeSimulators());
		expect(bundle).toEqual(before);
	});

	it('solves in .NET order, so the irrigation module comes before the channel that supplies it', () => {
		const { simulators, ledger } = fakeSimulators();
		const result = runNetwork(syntheticBundle(), { kind: 'historical' }, { simulators });
		expect(ledger.calls).toEqual(['RV5', 'CR4']);
		// The demand reached CR4, which is listed after RR6, and the supply came back.
		const demand = result.irrigation![6]!.demand.values.reduce((s, v) => s + v, 0);
		expect(demand).toBeGreaterThan(0);
		expect(result.irrigation![6]!.supply.values).toEqual(result.routeFlows[7]!.values);
	});

	it('adds the RTIN inflow to the generated runoff and splits the total by the L.020 percentages', () => {
		let bundle = syntheticBundle();
		bundle = {
			...bundle,
			network: { ...bundle.network, routes: [...bundle.network.routes, { number: 10, upstreamPosition: 2, downstreamPosition: 0, cost: 0 }] }
		};
		bundle = replace(bundle, { ...ru(bundle, 2), outflows: [{ route: 2, percent: 70 }, { route: 10, percent: 30 }] });
		const result = runNetwork(bundle, { kind: 'historical' }, fakeSimulators());
		const generated = result.runoff![2]!.netRunoff!.values;
		const inflow = result.routeFlows[1]!.values;
		expect(inflow.some((v) => v > 0)).toBe(true);
		result.routeFlows[2]!.values.forEach((v, i) => expect(v).toBeCloseTo((generated[i]! + inflow[i]!) * 0.7, 12));
		result.routeFlows[10]!.values.forEach((v, i) => expect(v).toBeCloseTo((generated[i]! + inflow[i]!) * 0.3, 12));
		// RU 1 sends all its runoff down route 1.
		expect(result.routeFlows[1]!.values).toEqual(result.runoff![1]!.netRunoff!.values);
	});

	it('runs each runoff module on its mode-applied form', () => {
		let bundle = syntheticBundle();
		const paved: RunoffModule = { ...ru(bundle, 3), paved: { fraction: [{ year: 1990, value: 0 }, { year: 1999, value: 0.3 }] } };
		bundle = replace(bundle, paved);
		const rain = bundle.rainfall['SYB.RAN']!;
		const period = { startYear: bundle.network.startYear, endYear: bundle.network.endYear };
		for (const mode of MODES) {
			const result = runNetwork(bundle, mode, fakeSimulators());
			expect(result.routeFlows[3]!.values).toEqual(runRunoffModule(applyRunMode(paved, mode), rain, period).outflow.values);
		}
		const natural = runNetwork(bundle, { kind: 'natural' }, fakeSimulators()).routeFlows[3]!.values;
		const present = runNetwork(bundle, { kind: 'presentDay', year: 1999 }, fakeSimulators()).routeFlows[3]!.values;
		expect(natural).not.toEqual(present);
	});

	it('passes Pitman options through to every runoff module', () => {
		const bundle = syntheticBundle();
		const a = runNetwork(bundle, { kind: 'historical' }, fakeSimulators());
		const b = runNetwork(bundle, { kind: 'historical' }, { ...fakeSimulators(), pitman: { initialSoilMoisture: 'zero' } });
		expect(b.routeFlows[1]!.values).not.toEqual(a.routeFlows[1]!.values);
	});

	it('reads the zero-source defined inflow per mode (zero in natural mode, R3-2)', () => {
		const bundle = syntheticBundle();
		const file = bundle.flowFiles['SYTRANS.ABS']!;
		const historical = runNetwork(bundle, { kind: 'historical' }, fakeSimulators()).routeFlows[6]!.values;
		expect(historical).toEqual(file.rows.flatMap((r) => [...r.months]));
		expect(runNetwork(bundle, { kind: 'natural' }, fakeSimulators()).routeFlows[6]).toEqual(zeroSeries(1990, 1999));
		const present = runNetwork(bundle, { kind: 'presentDay', year: 1992 }, fakeSimulators()).routeFlows[6]!.values;
		expect(present).toEqual(new Array(10).fill(file.rows[2]!.months).flat());
	});

	it('keys reservoir storage by module number and passes only simulated inflows to simulators', () => {
		const seen: Record<string, number[]> = {};
		const { simulators } = fakeSimulators();
		const spy: ModuleSimulators = {
			reservoir: (m, inflows, ctx) => ((seen[`RV${m.number}`] = Object.keys(inflows).map(Number)), simulators.reservoir(m, inflows, ctx)),
			channel: (m, inflows, ctx) => ((seen[`CR${m.number}`] = Object.keys(inflows).map(Number)), simulators.channel(m, inflows, ctx))
		};
		const result = runNetwork(syntheticBundle(), { kind: 'historical' }, { simulators: spy });
		expect(Object.keys(result.reservoirStorage)).toEqual(['5']);
		expect(seen).toEqual({ RV5: [2], CR4: [3, 5] });
	});

	it('gives the simulators a context that resolves file names case-insensitively', () => {
		const { simulators } = fakeSimulators();
		let checked = false;
		const spy: ModuleSimulators = {
			...simulators,
			reservoir: (m, inflows, ctx) => {
				expect(ctx.rainfall('sya.ran')).toBeDefined();
				expect(ctx.rainfall('C:\\RAIN\\SYA.RAN')).toBeDefined();
				expect(ctx.flowFile('syrq9.abs')).toBeDefined();
				expect(ctx.flowFile('NOPE.ABS')).toBeUndefined();
				checked = true;
				return simulators.reservoir(m, inflows, ctx);
			}
		};
		runNetwork(syntheticBundle(), { kind: 'presentDay', year: 2025 }, { simulators: spy });
		expect(checked).toBe(true);
	});
});

describe('runNetwork: modules it does not simulate', () => {
	it('sends zero down the routes of an unsolved module (Solve = N) with no solved module downstream', () => {
		let bundle = syntheticBundle();
		// Leave RU 3 unsolved and route it to the zero sink so nothing solved depends on it.
		bundle = {
			...bundle,
			network: {
				...bundle.network,
				modules: bundle.network.modules.map((e) => (e.type === 'RU' && e.number === 3 ? { ...e, solve: false } : e)),
				routes: bundle.network.routes.map((r) => (r.number === 3 ? { ...r, downstreamPosition: 0 } : r))
			}
		};
		bundle = replace(bundle, { ...bundle.modules.find((m): m is Extract<Module, { kind: 'CR' }> => m.kind === 'CR')!, inflows: [{ route: 5, definedFlowFile: null }, { route: 6, definedFlowFile: 'SYTRANS.ABS' }] });
		const { simulators, ledger } = fakeSimulators();
		const result = runNetwork(bundle, { kind: 'historical' }, { simulators });
		expect(result.routeFlows[3]).toEqual(zeroSeries(1990, 1999));
		expect(result.runoff![3]).toBeUndefined();
		expect(result.messages).toContainEqual(expect.objectContaining({ level: 'info', text: expect.stringMatching(/RU 3 \(SYRU3\.DAT\) is not solved/) }));
		expect(Math.max(...balance(bundle, result, ledger).map(Math.abs))).toBeLessThan(1e-9);
	});

	it('sends zero down the routes of an unparsed module, with a warning naming it (R3-N7)', () => {
		let bundle = syntheticBundle();
		bundle = {
			...bundle,
			modules: bundle.modules.map((m) =>
				m.kind === 'RR' ? { kind: 'unparsed', moduleType: 'RR', number: 6, name: 'x', reason: 'file version 99 is not documented', lines: [] } : m
			)
		};
		const result = runNetwork(bundle, { kind: 'historical' }, fakeSimulators());
		expect(result.routeFlows[8]).toEqual(zeroSeries(1990, 1999));
		expect(result.messages).toContainEqual(
			expect.objectContaining({ level: 'warning', module: { type: 'RR', number: 6 }, text: expect.stringMatching(/RR 6 \(SYRR6\.DAT\) is not simulated \(file version 99.*routes 8 carry zero/) })
		);
	});

	it('reports irrigation as removed, not missing, in natural mode', () => {
		const result = runNetwork(syntheticBundle(), { kind: 'natural' }, fakeSimulators());
		expect(result.messages).toContainEqual(expect.objectContaining({ level: 'info', module: { type: 'RR', number: 6 }, text: expect.stringMatching(/removed in natural mode/) }));
		expect(result.routeFlows[8]).toEqual(zeroSeries(1990, 1999));
	});
});

describe('runNetwork failures', () => {
	it('throws one NetworkError carrying every validation problem', () => {
		const bundle = syntheticBundle();
		const broken: NetworkBundle = {
			...bundle,
			modules: bundle.modules.filter((m) => m.kind !== 'RV'),
			network: { ...bundle.network, routes: [...bundle.network.routes, { number: 50, upstreamPosition: 9, downstreamPosition: 0, cost: 0 }] }
		};
		let caught: unknown;
		try {
			runNetwork(broken, { kind: 'historical' }, fakeSimulators());
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(NetworkError);
		const texts = (caught as NetworkError).messages.filter((m) => m.level === 'error').map((m) => m.text);
		expect(texts).toEqual(expect.arrayContaining([expect.stringMatching(/no file SYRV5\.DAT/), expect.stringMatching(/route 50 upstream module is position 9/)]));
	});

	it('lets a Sami runoff module fail the run with the module named (R2-2)', () => {
		const bundle = syntheticBundle();
		const sami = replace(bundle, { ...ru(bundle, 3), groundwaterModel: 2 });
		expect(() => runNetwork(sami, { kind: 'historical' }, fakeSimulators())).toThrow(PitmanRunError);
		expect(() => runNetwork(sami, { kind: 'historical' }, fakeSimulators())).toThrow(/RU 3: groundwater model 2 \(Sami\)/);
	});

	it('wraps a simulator error in a NetworkError naming the module', () => {
		const { simulators } = fakeSimulators();
		const failing: ModuleSimulators = {
			...simulators,
			channel: () => {
				throw new Error('wetland volume negative');
			}
		};
		expect(() => runNetwork(syntheticBundle(), { kind: 'historical' }, { simulators: failing })).toThrow(/CR 4 \(SYCR4\.DAT\): wetland volume negative/);
		try {
			runNetwork(syntheticBundle(), { kind: 'historical' }, { simulators: failing });
		} catch (error) {
			expect(error).toBeInstanceOf(NetworkError);
			expect((error as NetworkError).messages[0]!.module).toEqual({ type: 'CR', number: 4 });
			expect((error as Error).cause).toBeInstanceOf(Error);
		}
	});

	it('rejects a simulator series of the wrong length', () => {
		const { simulators } = fakeSimulators();
		const short: ModuleSimulators = {
			...simulators,
			reservoir: (m, inflows, ctx) => ({ ...simulators.reservoir(m, inflows, ctx), outflows: { 5: { startYear: 1990, values: [1, 2, 3], unit: 'Mm3' } } })
		};
		expect(() => runNetwork(syntheticBundle(), { kind: 'historical' }, { simulators: short })).toThrow(/RV 5 \(SYRV5\.DAT\): simulator returned route 5 with 3 months; the run has 120/);
	});

	it('fills a route a simulator leaves out with zeros and ignores one that is not its own, warning about both', () => {
		const { simulators } = fakeSimulators();
		const odd: ModuleSimulators = {
			...simulators,
			channel: (m, inflows, ctx) => {
				const r = simulators.channel(m, inflows, ctx);
				const outflows: Record<number, MonthlySeries> = { ...r.outflows, 1: zeroSeries(ctx.startYear, ctx.endYear) };
				delete outflows[9];
				return { ...r, outflows };
			}
		};
		const result = runNetwork(syntheticBundle(), { kind: 'historical' }, { simulators: odd });
		expect(result.routeFlows[9]).toEqual(zeroSeries(1990, 1999));
		expect(result.routeFlows[1]!.values.some((v) => v > 0)).toBe(true);
		expect(result.messages).toContainEqual(expect.objectContaining({ level: 'warning', route: 9, text: expect.stringMatching(/returned nothing for outflow route 9/) }));
		expect(result.messages).toContainEqual(expect.objectContaining({ level: 'warning', route: 1, text: expect.stringMatching(/route 1, which doesn't leave CR 4/) }));
	});
});
