import { describe, expect, it } from 'vitest';
import { readBundle, writeBundle, type LoadedBundle } from '../io/bundle.js';
import { syntheticBundle } from '../network/synthetic-bundle.js';
import { validateNetwork } from '../network/validate.js';
import { run } from '../run.js';
import type { ChannelModule, DemandSpec, Monthly12, NetworkBundle, ReservoirModule, ValueSource } from '../types.js';
import { DemandError, applyDemand, demandAttachments, demandFileKeys, demandFileName, demandSourcesOf, demandSpecOf, demandTargets, planDemand, type DemandRequest } from './attach.js';

// The engine's synthetic network, invented values only (issue #3 rule 2):
// RV5 spills on route 5; CR4 has principal route 4, route 7 to RR6, route 9 with
// SYRQ9.ABS, and defined inflow route 6 with SYTRANS.ABS.

const spec: DemandSpec = {
	annualVolumeMm3: 1.2,
	monthlyDistributionPercent: Array<number>(12).fill(100 / 12) as unknown as Monthly12,
	growth: [
		{ year: 1985, value: 1.2 },
		{ year: 2025, value: 2.4 }
	]
};
const manual = (note: string): ValueSource => ({ kind: 'manual', note, date: '2025-01-02' });
const sources = { annualVolume: manual('annual'), monthlyDistribution: manual('shares'), growth: { 2025: manual('forecast') } };
const onDam = { type: 'RV', number: 5 } as const;
const onRiver = { type: 'CR', number: 4 } as const;
const newOnDam: DemandRequest = { spec, sources, target: { kind: 'newRoute', module: onDam } };

function loaded(bundle: NetworkBundle = syntheticBundle({ startYear: 1985, years: 10 })): LoadedBundle {
	const result = readBundle(writeBundle(bundle));
	if (!result.ok) throw new Error(result.errors.map((e) => e.message).join('\n'));
	return result.bundle;
}

const reservoir = (b: NetworkBundle) => b.modules.find((m): m is ReservoirModule => m.kind === 'RV')!;
const channel = (b: NetworkBundle) => b.modules.find((m): m is ChannelModule => m.kind === 'CR')!;

describe('demandTargets', () => {
	const options = demandTargets(syntheticBundle());

	it('offers reservoirs first, then channel reaches', () => {
		expect(options.map((o) => o.module)).toEqual([onDam, onRiver]);
		expect(options.map((o) => o.name)).toEqual(['Synthetic dam', 'Synthetic river']);
	});

	it('says why a route cannot take a demand', () => {
		const dam = options[0]!;
		const river = options[1]!;
		expect(dam.routes).toEqual([{ route: 5, to: 'CR 4', blocked: 'it is the spill route' }]);
		expect(river.routes).toEqual([
			{ route: 4, to: 'the zero sink', blocked: 'it is the principal outflow route' },
			{ route: 7, to: 'RR 6', blocked: 'it feeds irrigation RR 6, which sets its own demand' },
			{ route: 9, to: 'the zero sink', blocked: 'it already carries SYRQ9.ABS' }
		]);
	});

	it('offers a free outflow route', () => {
		const bundle = syntheticBundle();
		const free = { ...bundle, modules: bundle.modules.map((m) => (m.kind === 'CR' ? { ...m, outflows: m.outflows.map((o) => ({ ...o, definedFlowFile: null })) } : m)) };
		expect(demandTargets(free)[1]?.routes[2]).toEqual({ route: 9, to: 'the zero sink', blocked: null });
	});

	it('offers the next route number until the module is full', () => {
		expect(options[0]?.newRoute).toBe(10);
		const bundle = syntheticBundle();
		const extra = [20, 21, 22, 23].map((route) => ({ route, definedFlowFile: null }));
		const full: NetworkBundle = {
			...bundle,
			network: { ...bundle.network, routes: [...bundle.network.routes, ...extra.map((e) => ({ number: e.route, upstreamPosition: 5, downstreamPosition: 0, cost: 0 }))] },
			modules: bundle.modules.map((m) => (m.kind === 'RV' ? { ...m, outflows: [...m.outflows, ...extra] } : m))
		};
		const dam = demandTargets(full)[0]!;
		expect(dam.newRoute).toBeNull();
		expect(dam.newRouteBlocked).toBe("RV 5 already has 5 outflow routes, WRSM2000's limit (TT 689 Table 2.1)");
	});

	it('says when a module is not solved', () => {
		const bundle = syntheticBundle();
		const off = { ...bundle, network: { ...bundle.network, modules: bundle.network.modules.map((e) => (e.type === 'RV' ? { ...e, solve: false } : e)) } };
		expect(demandTargets(off)[0]?.solved).toBe(false);
	});
});

describe('demandFileName', () => {
	it('is named after the route', () => {
		expect(demandFileName(syntheticBundle(), 11)).toBe('SYRQ11.abs');
	});

	it('never takes a name in use, even a file nothing reads', () => {
		const bundle = loaded();
		const withOther: LoadedBundle = { ...bundle, files: { ...bundle.files, other: { ...bundle.files.other, 'syrq11.ABS': 'kept' } } };
		expect(demandFileName(withOther, 11)).toBe('SYRQ11-2.abs');
		expect(demandFileName(bundle, 9)).toBe('SYRQ9-2.abs');
	});
});

describe('demandAttachments', () => {
	it('lists a demand and a defined inflow', () => {
		const bundle = syntheticBundle();
		expect(demandAttachments(bundle, 'SYRQ9.ABS')).toEqual([{ module: onRiver, name: 'Synthetic river', route: 9, direction: 'out', other: 'the zero sink' }]);
		expect(demandAttachments(bundle, 'SYTRANS.ABS')).toEqual([{ module: onRiver, name: 'Synthetic river', route: 6, direction: 'in', other: 'the zero source' }]);
	});
});

describe('planDemand', () => {
	it('shows everything an apply would do and changes nothing', () => {
		const bundle = loaded();
		const before = JSON.stringify(bundle);
		const plan = planDemand(bundle, newOnDam);
		expect(JSON.stringify(bundle)).toBe(before);
		expect(plan.fileName).toBe('SYRQ10.abs');
		expect(plan.key).toBe('SYRQ10.ABS');
		expect(plan.attach).toEqual({ module: onDam, moduleName: 'Synthetic dam', route: 10, newRoute: true });
		expect([plan.firstYear, plan.lastYear]).toEqual([1985, 2025]);
		expect(plan.series.rows).toHaveLength(41);
		expect(plan.text.split('\r\n')).toHaveLength(42);
		expect(plan.years).toHaveLength(41);
	});

	it('refuses what it cannot do, in words', () => {
		const bundle = syntheticBundle();
		expect(() => planDemand(bundle, { spec, sources })).toThrow(new DemandError('Choose the reservoir or channel reach this demand comes off'));
		expect(() => planDemand(bundle, { spec, sources, target: { kind: 'route', module: onDam, route: 5 } })).toThrow("Route 5 can't take a demand: it is the spill route");
		expect(() => planDemand(bundle, { spec, sources, target: { kind: 'route', module: onDam, route: 99 } })).toThrow('Route 99 is not an outflow of RV 5');
		expect(() => planDemand(bundle, { spec, sources, target: { kind: 'route', module: { type: 'RU', number: 1 }, route: 1 } })).toThrow('RU 1 is not a reservoir or channel reach');
		expect(() => planDemand(bundle, { spec, sources, file: 'NOPE.ABS' })).toThrow('NOPE.ABS is not a file of this network');
		expect(() => planDemand(bundle, { ...newOnDam, spec: { ...spec, growth: [{ year: 2000, value: 0 }] } })).toThrow(/zero in every year/);
	});

	it('refuses to move a defined inflow', () => {
		expect(() => planDemand(syntheticBundle(), { spec, sources, file: 'SYTRANS.ABS', target: { kind: 'newRoute', module: onDam } })).toThrow(/can only move when one outflow route/);
	});
});

describe('applyDemand on a new route', () => {
	const bundle = loaded();
	const next = applyDemand(bundle, planDemand(bundle, newOnDam));

	it('names the file on the route and adds the route to the zero sink', () => {
		expect(reservoir(next).outflows).toEqual([
			{ route: 5, definedFlowFile: null },
			{ route: 10, definedFlowFile: 'SYRQ10.abs' }
		]);
		expect(next.network.routes.at(-1)).toEqual({ number: 10, upstreamPosition: 5, downstreamPosition: 0, cost: 0 });
	});

	it('records the spec and each value’s source in the sidecar', () => {
		expect(next.sidecar?.demands?.['SYRQ10.ABS']).toEqual(spec);
		expect(demandSpecOf(next, 'SYRQ10.ABS')).toEqual(spec);
		const read = demandSourcesOf(next, 'SYRQ10.ABS');
		expect(read.annualVolume?.note).toBe('annual');
		expect(read.monthlyDistribution?.note).toBe('shares');
		expect(read.growth[2025]?.note).toBe('forecast');
		expect(read.growth[1985]?.note).toBe('annual');
	});

	it('leaves the network valid, and a run takes the demand', () => {
		expect(validateNetwork(next).filter((m) => m.level === 'error')).toEqual([]);
		const historical = run(next, { kind: 'historical' });
		const supplied = historical.routeFlows[10]?.values ?? [];
		expect(supplied.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
		// Natural mode removes the abstraction (D1, R3-2).
		expect(run(next, { kind: 'natural' }).routeFlows[10]?.values.every((v) => v === 0)).toBe(true);
	});

	it('survives a save and reload unchanged', () => {
		const files = writeBundle(next);
		expect(Object.keys(files)).toContain('SYRQ10.abs');
		expect(files['SYRQ10.abs']).toBe(planDemand(bundle, newOnDam).text);
		const again = readBundle(files);
		if (!again.ok) throw new Error('did not reload');
		expect(again.bundle.flowFiles['SYRQ10.ABS']?.rows).toEqual(next.flowFiles['SYRQ10.ABS']?.rows);
		expect(reservoir(again.bundle).outflows[1]).toEqual({ route: 10, definedFlowFile: 'SYRQ10.abs' });
		expect(again.bundle.sidecar?.demands?.['SYRQ10.ABS']).toEqual(spec);
		expect(writeBundle(again.bundle)).toEqual(files);
	});

	it('works on a bundle with no file index or sidecar', () => {
		const bare = syntheticBundle({ startYear: 1985, years: 10 });
		const made = applyDemand(bare, planDemand(bare, newOnDam));
		expect(made.sidecar?.schema).toBe('pitman-sidecar');
		expect(Object.keys(writeBundle(made))).toContain('SYRQ10.ABS');
	});
});

describe('applyDemand on an existing file', () => {
	const bundle = loaded();

	it('replaces the rows and keeps the name and the route', () => {
		const plan = planDemand(bundle, { spec, sources, file: 'SYRQ9.ABS' });
		const next = applyDemand(bundle, plan);
		expect(plan.fileName).toBe(bundle.flowFiles['SYRQ9.ABS']?.fileName);
		expect(next.flowFiles['SYRQ9.ABS']?.rows).toEqual(plan.series.rows);
		expect(channel(next)).toEqual(channel(bundle));
		expect(next.network).toEqual(bundle.network);
		expect(demandSpecOf(next, 'SYRQ9.ABS')).toEqual(spec);
	});

	it('editing again replaces the old sources rather than piling them up', () => {
		const once = applyDemand(bundle, planDemand(bundle, { spec, sources, file: 'SYRQ9.ABS' }));
		const shorter = { ...spec, growth: [{ year: 1985, value: 1.2 }] };
		const twice = applyDemand(once, planDemand(once, { spec: shorter, sources, file: 'SYRQ9.ABS' }));
		expect(twice.sidecar?.values?.filter((v) => v.target.file === 'SYRQ9.ABS')).toHaveLength(3);
	});

	it('keeps other files’ sources and the sidecar’s other sections', () => {
		const withOther: LoadedBundle = {
			...bundle,
			sidecar: { schema: 'pitman-sidecar', schemaVersion: 1, savedAt: '2025-01-01', values: [{ target: { module: { type: 'RU', number: 1 }, field: 'pitman.ST' }, source: manual('kept') }] }
		};
		const next = applyDemand(withOther, planDemand(withOther, { spec, sources, file: 'SYRQ9.ABS' }));
		expect(next.sidecar?.savedAt).toBe('2025-01-01');
		expect(next.sidecar?.values?.[0]?.source.note).toBe('kept');
	});

	it('replaces a file under every name that resolves to it', () => {
		const record = bundle.flowFiles['SYRQ9.ABS']!;
		const aliased: LoadedBundle = {
			...bundle,
			flowFiles: { ...bundle.flowFiles, '.\\SYRQ9.ABS': record },
			files: { ...bundle.files, flowFiles: { ...bundle.files.flowFiles, '.\\SYRQ9.ABS': bundle.files.flowFiles['SYRQ9.ABS']! } }
		};
		expect(demandFileKeys(aliased, 'SYRQ9.ABS')).toEqual(['SYRQ9.ABS', '.\\SYRQ9.ABS']);
		const next = applyDemand(aliased, planDemand(aliased, { spec, sources, file: 'SYRQ9.ABS' }));
		expect(next.flowFiles['.\\SYRQ9.ABS']).toBe(next.flowFiles['SYRQ9.ABS']);
		expect(() => writeBundle(next)).not.toThrow();
	});
});

describe('moving a demand', () => {
	const bundle = loaded();
	const made = applyDemand(bundle, planDemand(bundle, newOnDam));

	it('takes it off the old route and renames a file named after that route', () => {
		const plan = planDemand(made, { spec, sources, file: 'SYRQ10.ABS', target: { kind: 'newRoute', module: onRiver } });
		expect(plan.fileName).toBe('SYRQ11.abs');
		expect(plan.renamedFrom).toBe('SYRQ10.abs');
		expect(plan.detach?.route).toBe(10);
		const next = applyDemand(made, plan);
		expect(reservoir(next).outflows[1]).toEqual({ route: 10, definedFlowFile: null });
		expect(channel(next).outflows.at(-1)).toEqual({ route: 11, definedFlowFile: 'SYRQ11.abs' });
		expect(next.flowFiles['SYRQ10.ABS']).toBeUndefined();
		expect(next.sidecar?.demands?.['SYRQ10.ABS']).toBeUndefined();
		expect(demandSpecOf(next, 'SYRQ11.ABS')).toEqual(spec);
		expect(next.sidecar?.values?.some((v) => v.target.file === 'SYRQ10.ABS')).toBe(false);
		expect(validateNetwork(next).filter((m) => m.level === 'error')).toEqual([]);
		const files = writeBundle(next);
		expect(Object.keys(files)).toContain('SYRQ11.abs');
		expect(Object.keys(files)).not.toContain('SYRQ10.abs');
	});

	it('keeps a free-form name', () => {
		const custom = bundle.flowFiles['SYTRANS.ABS']!;
		const bundleNamed: LoadedBundle = {
			...made,
			flowFiles: { ...made.flowFiles, 'TOWN.ABS': { ...custom, fileName: 'TOWN.abs' } },
			files: { ...made.files, flowFiles: { ...made.files.flowFiles, 'TOWN.ABS': 'TOWN.abs' } },
			modules: made.modules.map((m) => (m.kind === 'RV' ? { ...m, outflows: m.outflows.map((o) => (o.route === 10 ? { ...o, definedFlowFile: 'TOWN.abs' } : o)) } : m))
		};
		const plan = planDemand(bundleNamed, { spec, sources, file: 'TOWN.ABS', target: { kind: 'newRoute', module: onRiver } });
		expect(plan.fileName).toBe('TOWN.abs');
		expect(plan.renamedFrom).toBeUndefined();
		expect(channel(applyDemand(bundleNamed, plan)).outflows.at(-1)?.definedFlowFile).toBe('TOWN.abs');
	});
});
