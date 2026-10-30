import { describe, expect, it } from 'vitest';
import { readBundle, writeBundle, type LoadedBundle } from '../io/bundle.js';
import { syntheticBundle } from '../network/synthetic-bundle.js';
import { validateNetwork } from '../network/validate.js';
import { run } from '../run.js';
import type { ChannelModule, DemandSpec, Monthly12, NetworkBundle, ReservoirModule, ValueSource } from '../types.js';
import { applyDemand, DemandError, demandFileName, demandTargets, planDemand } from './attach.js';
import { applyDemandRemoval, demandRemovals, planDemandRemoval, type DemandRouteChoice } from './remove.js';

// The engine's synthetic network, invented values only (issue #3 rule 2): CR4 reads
// SYRQ9.ABS on outflow route 9 to the zero sink, and SYTRANS.ABS on inflow route 6 from
// the zero source.

const spec: DemandSpec = { annualVolumeMm3: 1.2, monthlyDistributionPercent: Array<number>(12).fill(100 / 12) as unknown as Monthly12, growth: [{ year: 1985, value: 1.2 }] };
const manual = (note: string): ValueSource => ({ kind: 'manual', note, date: '2026-10-30' });
const sources = { annualVolume: manual('annual'), monthlyDistribution: manual('shares'), growth: {} };
const reason = manual('Scheme decommissioned in 2019');

function loaded(bundle: NetworkBundle = syntheticBundle({ startYear: 1985, years: 10 })): LoadedBundle {
	const result = readBundle(writeBundle(bundle));
	if (!result.ok) throw new Error(result.errors.map((e) => e.message).join('\n'));
	return result.bundle;
}

const channel = (b: NetworkBundle) => b.modules.find((m): m is ChannelModule => m.kind === 'CR')!;
const reservoir = (b: NetworkBundle) => b.modules.find((m): m is ReservoirModule => m.kind === 'RV')!;
const onRoute9: DemandRouteChoice = { module: { type: 'CR', number: 4 }, route: 9, direction: 'out' };

/** RV 5 reads CR 4's demand file too, on a route of its own to the zero sink. */
function shared(): LoadedBundle {
	const bundle = syntheticBundle({ startYear: 1985, years: 10 });
	const position = bundle.network.modules.findIndex((e) => e.type === 'RV') + 1;
	return loaded({
		...bundle,
		network: { ...bundle.network, routes: [...bundle.network.routes, { number: 12, upstreamPosition: position, downstreamPosition: 0, cost: 0 }] },
		modules: bundle.modules.map((m) => (m.kind === 'RV' ? { ...m, outflows: [...m.outflows, { route: 12, definedFlowFile: 'SYRQ9.ABS' }] } : m))
	});
}

function generated() {
	const bundle = loaded();
	const plan = planDemand(bundle, { spec, sources, target: { kind: 'newRoute', module: { type: 'RV', number: 5 } } });
	return { bundle, plan, after: applyDemand(bundle, plan) };
}

const errors = (b: NetworkBundle) => validateNetwork(b).filter((m) => m.level === 'error');
const inZip = (b: NetworkBundle, name: RegExp) => Object.keys(writeBundle(b)).some((p) => name.test(p));
const flow = (b: NetworkBundle, route: number) => run(b, { kind: 'historical' }).routeFlows[route]!.values;

describe('planDemandRemoval', () => {
	it('refuses a removal that would leave the network unable to run (R7-X14)', () => {
		const bundle = syntheticBundle({ startYear: 1985, years: 10 });
		const at = (type: string) => bundle.network.modules.findIndex((e) => e.type === type) + 1;
		const ordered = at('RV') < at('CR');
		const [up, down] = ordered ? ['CR', 'RV'] : ['RV', 'CR']; // upstream listed after downstream: only a file lets that run
		const wired = loaded({
			...bundle,
			network: { ...bundle.network, routes: [...bundle.network.routes, { number: 20, upstreamPosition: at(up), downstreamPosition: at(down), cost: 0 }] },
			modules: bundle.modules.map((m) =>
				m.kind === up ? ({ ...m, outflows: [...(m as ChannelModule).outflows, { route: 20, definedFlowFile: null }] } as typeof m)
				: m.kind === down ? ({ ...m, inflows: [...(m as ChannelModule).inflows, { route: 20, definedFlowFile: 'SYRQ9.ABS' }] } as typeof m)
				: m)
		});
		expect(errors(wired)).toEqual([]);
		const plan = planDemandRemoval(wired, 'SYRQ9.ABS', { module: { type: down as 'RV', number: wired.modules.find((m) => m.kind === down)!.number as number }, route: 20, direction: 'in' });
		expect(plan.refused).toMatch(/couldn’t run without this file/);
		expect(() => applyDemandRemoval(wired, plan)).toThrow(DemandError);
	});

	it('calls a stale wetland number on a type 0 reach an ordinary route (OQ-CR15)', () => {
		const bundle = loaded();
		const stale = { ...bundle, modules: bundle.modules.map((m) => (m.kind === 'CR' ? { ...m, localWetlandOutflowRoute: 9 } : m)) };
		expect(planDemandRemoval(stale, 'SYRQ9.ABS').routes[0]?.effect).toBe('Route 9 stays on CR 4 and carries nothing. A new demand can use it.');
	});

	it('takes the volume off a route in historical and present-day modes, and leaves natural alone', () => {
		const bundle = loaded();
		const after = applyDemandRemoval(bundle, planDemandRemoval(bundle, 'SYRQ9.ABS'), reason);
		const total = (b: NetworkBundle, mode: Parameters<typeof run>[1]) => run(b, mode).routeFlows[4]!.values.reduce((s, v) => s + v, 0);
		for (const mode of [{ kind: 'historical' }, { kind: 'presentDay', year: 1990 }] as const) expect(total(after, mode)).toBeGreaterThan(total(bundle, mode));
		expect(total(after, { kind: 'natural' })).toBeCloseTo(total(bundle, { kind: 'natural' }), 10);
	});

	it('says what would happen and changes nothing', () => {
		const bundle = loaded();
		const before = JSON.stringify(bundle);
		const plan = planDemandRemoval(bundle, 'SYRQ9.ABS');
		expect(JSON.stringify(bundle)).toBe(before);
		expect(plan).toMatchObject({ fileName: 'SYRQ9.ABS', fileGoes: true, specGoes: false, needsReason: true, refused: null, stillInZip: null, stays: [] });
		expect(plan.routes).toHaveLength(1);
		expect(plan.routes[0]?.effect).toBe('Route 9 stays on CR 4 and carries nothing. A new demand can use it.');
		expect(plan.routes[0]?.routeGoes).toBe(false);
	});

	it('takes a route from the zero source with its file, because it can’t stay without one', () => {
		const plan = planDemandRemoval(loaded(), 'SYTRANS.ABS');
		expect(plan.routes[0]).toMatchObject({ routeGoes: true, effect: 'Route 6 goes too: a route from the zero source must have a file (TT 689 p.xv).' });
		expect(plan.refused).toBeNull();
	});

	it('refuses to take away a route a gauge or summary line names, and says what to do', () => {
		const bundle = loaded();
		const gauged: LoadedBundle = { ...bundle, network: { ...bundle.network, gauges: [{ route: 6, label: 'Transfer gauge', observedFile: 'X.OBS' }] as unknown as typeof bundle.network.gauges } };
		expect(planDemandRemoval(gauged, 'SYTRANS.ABS').refused).toBe('Route 6 starts at the zero source, so it can’t stay without a file (TT 689 p.xv), and it can’t go because gauge Transfer gauge is on it. Change the network in WRSM2000 first.');
		const reported: LoadedBundle = { ...bundle, network: { ...bundle.network, summaryLines: [{ kind: 'RT', number: 6, quantity: 'Q' }] } };
		expect(planDemandRemoval(reported, 'SYTRANS.ABS').refused).toContain('a summary line reports it');
		expect(() => applyDemandRemoval(reported, planDemandRemoval(reported, 'SYTRANS.ABS'), reason)).toThrow(DemandError);
	});

	it('lets the principal outflow fall back to the simulation', () => {
		const bundle = loaded();
		const defined: LoadedBundle = { ...bundle, modules: bundle.modules.map((m) => (m.kind === 'CR' ? { ...m, outflows: m.outflows.map((o) => (o.route === 4 ? { ...o, definedFlowFile: 'SYRQ9.ABS' } : o)) } : m)) };
		const plan = planDemandRemoval(defined, 'SYRQ9.ABS', { ...onRoute9, route: 4 });
		expect(plan.routes[0]?.effect).toBe('Route 4 is the principal outflow route: with no file, a run simulates it again.');
	});

	it('names the module that takes over on a route to an irrigation block', () => {
		const bundle = loaded();
		const toBlock: LoadedBundle = { ...bundle, modules: bundle.modules.map((m) => (m.kind === 'CR' ? { ...m, outflows: m.outflows.map((o) => (o.route === 7 ? { ...o, definedFlowFile: 'SYRQ9.ABS' } : o)) } : m)) };
		expect(planDemandRemoval(toBlock, 'SYRQ9.ABS', { ...onRoute9, route: 7 }).routes[0]?.effect).toBe('Route 7 goes back to the demand RR 6 calculates.');
	});

	it('refuses a file or a route that isn’t there', () => {
		const bundle = loaded();
		expect(() => planDemandRemoval(bundle, 'NOPE.ABS')).toThrow(new DemandError('NOPE.ABS is not a file of this network'));
		expect(() => planDemandRemoval(bundle, 'SYRQ9.ABS', { ...onRoute9, route: 4 })).toThrow(new DemandError('SYRQ9.ABS is not on route 4 of CR 4'));
	});
});

describe('applyDemandRemoval: a network’s own file', () => {
	it('needs a reason', () => {
		const bundle = loaded();
		const plan = planDemandRemoval(bundle, 'SYRQ9.ABS');
		expect(() => applyDemandRemoval(bundle, plan)).toThrow(DemandError);
		expect(() => applyDemandRemoval(bundle, plan, manual('  '))).toThrow('Say why SYRQ9.ABS goes');
	});

	it('clears the route’s reference and the record, and a save no longer writes the file', () => {
		const bundle = loaded();
		const after = applyDemandRemoval(bundle, planDemandRemoval(bundle, 'SYRQ9.ABS'), reason);
		expect(channel(after).outflows.find((o) => o.route === 9)?.definedFlowFile).toBeNull();
		expect(after.flowFiles['SYRQ9.ABS']).toBeUndefined();
		expect(after.flowFiles['SYTRANS.ABS']).toBeDefined();
		expect(after.network.routes.some((r) => r.number === 9)).toBe(true);
		expect(inZip(bundle, /SYRQ9\.ABS$/i)).toBe(true);
		expect(inZip(after, /SYRQ9\.ABS$/i)).toBe(false);
		expect(inZip(after, /SYTRANS\.ABS$/i)).toBe(true);
	});

	it('leaves a network that loads, validates and runs as if the demand had never been there', () => {
		const bundle = loaded();
		const after = applyDemandRemoval(bundle, planDemandRemoval(bundle, 'SYRQ9.ABS'), reason);
		expect(errors(after)).toEqual([]);
		const again = loaded(after);
		expect(again.flowFiles['SYRQ9.ABS']).toBeUndefined();
		expect(channel(again).outflows.find((o) => o.route === 9)?.definedFlowFile).toBeNull();

		const never: NetworkBundle = { ...bundle, modules: bundle.modules.map((m) => (m.kind === 'CR' ? { ...m, outflows: m.outflows.map((o) => (o.route === 9 ? { ...o, definedFlowFile: null } : o)) } : m)) };
		expect(flow(after, 4)).toEqual(flow(never, 4));
		expect(flow(after, 9).every((v) => v === 0)).toBe(true);
		expect(flow(after, 4).every((v, t) => v >= flow(bundle, 4)[t]! - 1e-9)).toBe(true);
	});

	it('frees the route and the name for a new demand', () => {
		const bundle = loaded();
		const after = applyDemandRemoval(bundle, planDemandRemoval(bundle, 'SYRQ9.ABS'), reason);
		expect(demandTargets(after)[1]?.routes.find((r) => r.route === 9)?.blocked).toBeNull();
		expect(demandFileName(after, 9)).toBe('SYRQ9.abs');
	});

	it('records the removal and what the file held, so the saved network says it went', () => {
		const bundle = loaded();
		const after = applyDemandRemoval(bundle, planDemandRemoval(bundle, 'SYRQ9.ABS'), reason);
		expect(after.sidecar?.values).toEqual([
			{
				target: { file: 'SYRQ9.ABS', field: 'demandRemoved' },
				source: { kind: 'manual', date: '2026-10-30', note: 'Demand removed: SYRQ9.ABS, on CR 4 route 9 (1985 to 1994, mean 0.30 million m³/a); Scheme decommissioned in 2019' }
			}
		]);
		expect(demandRemovals(after.sidecar)).toEqual([{ file: 'SYRQ9.ABS', date: '2026-10-30', note: 'SYRQ9.ABS, on CR 4 route 9 (1985 to 1994, mean 0.30 million m³/a); Scheme decommissioned in 2019' }]);
		expect(demandRemovals(loaded(after).sidecar)).toHaveLength(1);
	});

	it('takes a zero-source route out of the .NET and the module, and the network still validates', () => {
		const bundle = loaded();
		const after = applyDemandRemoval(bundle, planDemandRemoval(bundle, 'SYTRANS.ABS'), reason);
		expect(after.network.routes.some((r) => r.number === 6)).toBe(false);
		expect(channel(after).inflows.some((c) => c.route === 6)).toBe(false);
		expect(errors(after)).toEqual([]);
		const again = loaded(after);
		expect(errors(again)).toEqual([]);
		expect(flow(again, 4).length).toBeGreaterThan(0);
	});

	it('keeps the file in the zip when a gauge reads it as its observed flow', () => {
		const bundle = loaded();
		const key = 'SYRQ9.ABS';
		const path = bundle.files.flowFiles[key]!;
		const series = bundle.flowFiles[key]!;
		const gauged: LoadedBundle = {
			...bundle,
			observed: { ...bundle.observed, [key]: { fileName: series.fileName, rows: [] } as unknown as (typeof bundle.observed)[string] },
			files: { ...bundle.files, observed: { ...bundle.files.observed, [key]: path } }
		};
		const plan = planDemandRemoval(gauged, key);
		expect(plan.stillInZip).toBe('A gauge reads it as its observed flow, so the file stays in the zip.');
		const after = applyDemandRemoval(gauged, plan, reason);
		expect(after.flowFiles[key]).toBeUndefined();
		expect(after.files.sources[path]).toBe(bundle.files.sources[path]);
	});
});

describe('applyDemandRemoval: a file Pitman generated', () => {
	it('needs no reason, and leaves nothing in the sidecar', () => {
		const { after, plan: made } = generated();
		const plan = planDemandRemoval(after, made.key);
		expect(plan).toMatchObject({ needsReason: false, specGoes: true, fileGoes: true });
		const gone = applyDemandRemoval(after, plan);
		expect(gone.sidecar?.demands).toBeUndefined();
		expect(gone.sidecar?.values).toBeUndefined();
		expect(gone.flowFiles[made.key]).toBeUndefined();
		expect(inZip(gone, /SYRQ10\.abs$/i)).toBe(false);
	});

	it('leaves other demands’ specs and sources, and every other value, alone', () => {
		const bundle = loaded();
		const first = applyDemand(bundle, planDemand(bundle, { spec, sources, file: 'SYRQ9.ABS' }));
		const second = applyDemand(first, planDemand(first, { spec, sources, target: { kind: 'newRoute', module: { type: 'RV', number: 5 } } }));
		const other = { target: { module: { type: 'RU', number: 1 } as const, field: 'afforestation.areaKm2', year: 2000 }, source: manual('Land use: 1 → 2; survey') };
		const withOther: LoadedBundle = { ...second, sidecar: { ...second.sidecar!, values: [other, ...(second.sidecar?.values ?? [])] } };
		const gone = applyDemandRemoval(withOther, planDemandRemoval(withOther, 'SYRQ10.ABS'));
		expect(Object.keys(gone.sidecar?.demands ?? {})).toEqual(['SYRQ9.ABS']);
		expect(gone.sidecar?.values?.filter((v) => v.target.file === 'SYRQ10.ABS')).toEqual([]);
		expect(gone.sidecar?.values?.filter((v) => v.target.file === 'SYRQ9.ABS')).toHaveLength(3);
		expect(gone.sidecar?.values?.[0]).toEqual(other);
	});

	it('leaves the route Pitman made for it idle, so the rest of a run is unchanged', () => {
		const { bundle, after, plan: made } = generated();
		const gone = applyDemandRemoval(after, planDemandRemoval(after, made.key));
		expect(reservoir(gone).outflows.find((o) => o.route === 10)).toEqual({ route: 10, definedFlowFile: null });
		expect(gone.network.routes.some((r) => r.number === 10)).toBe(true);
		expect(errors(gone)).toEqual([]);
		expect(flow(gone, 4)).toEqual(flow(bundle, 4));
	});
});

describe('a file shared by more than one route', () => {
	it('names every route, and removing it takes it off them all', () => {
		const bundle = shared();
		const plan = planDemandRemoval(bundle, 'SYRQ9.ABS');
		expect(plan.routes.map((r) => r.attachment.route).sort((a, b) => a - b)).toEqual([9, 12]);
		const after = applyDemandRemoval(bundle, plan, reason);
		expect(channel(after).outflows.find((o) => o.route === 9)?.definedFlowFile).toBeNull();
		expect(reservoir(after).outflows.find((o) => o.route === 12)?.definedFlowFile).toBeNull();
		expect(after.flowFiles['SYRQ9.ABS']).toBeUndefined();
		expect(inZip(after, /SYRQ9\.ABS$/i)).toBe(false);
	});

	it('can come off one route; the other keeps the file and it stays in the zip', () => {
		const bundle = shared();
		const plan = planDemandRemoval(bundle, 'SYRQ9.ABS', onRoute9);
		expect(plan).toMatchObject({ fileGoes: false, specGoes: false });
		expect(plan.stays.map((a) => a.route)).toEqual([12]);
		const after = applyDemandRemoval(bundle, plan, reason);
		expect(channel(after).outflows.find((o) => o.route === 9)?.definedFlowFile).toBeNull();
		expect(reservoir(after).outflows.find((o) => o.route === 12)?.definedFlowFile).toBe('SYRQ9.ABS');
		expect(after.flowFiles['SYRQ9.ABS']).toBe(bundle.flowFiles['SYRQ9.ABS']);
		expect(inZip(after, /SYRQ9\.ABS$/i)).toBe(true);
		expect(after.sidecar?.values?.[0]?.source.note).toContain('on CR 4 route 9 (');
	});

	it('keeps the spec and its sources while a route still reads the file', () => {
		const bundle = shared();
		const withSpec = applyDemand(bundle, planDemand(bundle, { spec, sources, file: 'SYRQ9.ABS' }));
		const after = applyDemandRemoval(withSpec, planDemandRemoval(withSpec, 'SYRQ9.ABS', onRoute9));
		expect(after.sidecar?.demands?.['SYRQ9.ABS']).toBeDefined();
		expect(after.sidecar?.values?.filter((v) => v.target.file === 'SYRQ9.ABS')).toHaveLength(3);
	});
});
