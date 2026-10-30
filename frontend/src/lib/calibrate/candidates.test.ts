import { run, type NetworkBundle, type RunoffModule } from '@pitman/wrsm';
import { describe, expect, it } from 'vitest';
import { syntheticBundle } from '#lib/network/synthetic.js';
import { calibrationCandidates, calibrationTargets, downstreamRoutes, gaugeSituation, modelGaps, sfrParent } from './candidates.js';

const bundle = syntheticBundle();

function edited(change: (m: RunoffModule) => RunoffModule): NetworkBundle {
	return { ...bundle, modules: bundle.modules.map((m) => (m.kind === 'RU' ? change(m) : m)) };
}

describe('calibrationCandidates', () => {
	it('lists runoff modules in .NET order, all editable on a classic network', () => {
		const list = calibrationCandidates(bundle);
		expect(list.map((c) => c.number)).toEqual([1, 2, 3]);
		expect(list.every((c) => c.editable)).toBe(true);
		expect(list[0]?.label).toMatch(/^RU 1/);
	});

	it('sends an SFR child to its parent', () => {
		const withChild = edited((m) => (m.number === 2 ? { ...m, sfrChildren: [3] } : m));
		const child = calibrationCandidates(withChild).find((c) => c.number === 3);
		expect(child?.editable).toBe(false);
		expect(child?.why).toContain('edit RU 2');
		expect(sfrParent(withChild, 3)?.number).toBe(2);
		expect(sfrParent(withChild, 2)).toBeUndefined();
	});

	it('says Hughes isn’t modelled', () => {
		const list = calibrationCandidates(edited((m) => (m.number === 1 ? { ...m, groundwaterModel: 1 } : m)));
		expect(list[0]).toMatchObject({ editable: false, why: 'Hughes groundwater isn’t modelled yet' });
	});

	it('refuses a Sami module with no Sami block', () => {
		const list = calibrationCandidates(edited((m) => (m.number === 1 ? { ...m, groundwaterModel: 2 } : m)));
		expect(list[0]?.editable).toBe(false);
	});
});

describe('downstreamRoutes', () => {
	it('follows the routes nearest first, through every module below', () => {
		// RU1 → route 1 → RU2 → route 2 → RV5 → route 5 → CR4 → routes 4, 7, 9; route 7 → RR6 → route 8.
		expect(downstreamRoutes(bundle, 1)).toEqual([1, 2, 5, 4, 7, 9, 8]);
	});

	it('starts at the module’s own outflow', () => {
		expect(downstreamRoutes(bundle, 3)[0]).toBe(3);
	});

	it('is empty for a module that isn’t in the network', () => {
		expect(downstreamRoutes(bundle, 99)).toEqual([]);
	});

	it('stops at a cycle', () => {
		const network = { ...bundle.network, routes: [...bundle.network.routes, { number: 50, upstreamPosition: 6, downstreamPosition: 1, cost: 0 }] };
		expect(downstreamRoutes({ ...bundle, network }, 1)).toContain(50);
	});
});

describe('gaugeSituation', () => {
	it('sees a gauge below the module', () => {
		expect(gaugeSituation(bundle, 1)).toBe('gauged');
	});

	it('tells “no gauge here” from “no gauges at all”', () => {
		const network = { ...bundle.network, gauges: [{ route: 1, label: 'G', observedFile: 'G.OBS' }] };
		expect(gaugeSituation({ ...bundle, network }, 3)).toBe('noneDownstream');
		expect(gaugeSituation({ ...bundle, network: { ...bundle.network, gauges: [] } }, 3)).toBe('noGauges');
	});
});

describe('calibrationTargets', () => {
	const result = run(bundle, { kind: 'historical' });

	it('puts the gauge with observed flow first, then the routes nearest the module', () => {
		const list = calibrationTargets(bundle, 1, [result]);
		expect(list[0]?.number).toBe(4);
		expect(list[0]?.observed).not.toBeNull();
		expect(list.slice(1).map((t) => t.number)).toEqual([1, 2, 5, 7, 9, 8]);
	});

	it('offers the routes alone when there’s no gauge', () => {
		const noGauges = { ...bundle, network: { ...bundle.network, gauges: [] } };
		expect(calibrationTargets(noGauges, 3, [result]).every((t) => t.gauge === null)).toBe(true);
	});

	it('never offers a reservoir or a route above the module', () => {
		const list = calibrationTargets(bundle, 3, [result]);
		expect(list.every((t) => t.kind === 'route')).toBe(true);
		expect(list.map((t) => t.number)).not.toContain(1);
	});
});

describe('modelGaps', () => {
	it('says irrigation isn’t simulated, and what that does to a fit', () => {
		expect(modelGaps(bundle).join(' ')).toContain('isn’t simulated yet');
	});

	it('counts several irrigation modules', () => {
		const rr = bundle.modules.find((m) => m.kind === 'RR')!;
		expect(modelGaps({ ...bundle, modules: [...bundle.modules, { ...rr, number: 60 }] })[0]).toContain('2 irrigation modules');
	});

	it('names modules it keeps but doesn’t simulate', () => {
		const mine = { kind: 'unparsed' as const, moduleType: 'MM' as const, number: 7, name: '', reason: 'mine modules are not modelled yet', lines: [] };
		expect(modelGaps({ ...bundle, modules: [...bundle.modules.filter((m) => m.kind !== 'RR'), mine] })).toEqual([expect.stringContaining('One module isn’t')]);
	});

	it('is silent when there’s nothing to say', () => {
		expect(modelGaps({ ...bundle, modules: bundle.modules.filter((m) => m.kind !== 'RR') })).toEqual([]);
	});
});
