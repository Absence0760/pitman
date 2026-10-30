import { describe, expect, it } from 'vitest';
import { applyDemand, planDemand, planDemandRemoval, syntheticBundle, type DemandSpec, type Monthly12, type NetworkBundle } from '@pitman/wrsm';
import { attachmentLabel, demandFiles, removalConsequences, removalRoutes, sourceLabel } from './files.js';

// The engine's synthetic network, invented values only (issue #3 rule 2).

const spec: DemandSpec = { annualVolumeMm3: 1.2, monthlyDistributionPercent: Array<number>(12).fill(100 / 12) as unknown as Monthly12, growth: [{ year: 1985, value: 1.2 }] };
const source = { kind: 'manual', note: 'town plan', date: '2025-01-02' } as const;
const sources = { annualVolume: source, monthlyDistribution: source, growth: {} };
const bundle = (): NetworkBundle => syntheticBundle({ startYear: 1985, years: 10 });

describe('removal', () => {
	it('says what happens to a network’s own file, the route and how it can come back', () => {
		const plan = planDemandRemoval(bundle(), 'SYRQ9.ABS');
		expect(removalRoutes(plan)).toBe('CR 4 route 9');
		const lines = removalConsequences(plan);
		expect(lines[0]).toBe('Route 9 stays on CR 4 and carries nothing. A new demand can use it.');
		expect(lines[1]).toBe('The file leaves the working copy and the next saved zip.');
		expect(lines[2]).toContain('one of the network’s own files');
		expect(lines[2]).toContain('only the zip you loaded can');
	});

	it('says the spec goes, and asks for no reason, for a file Pitman made', () => {
		const b = bundle();
		const made = applyDemand(b, planDemand(b, { spec, sources, file: 'SYRQ9.ABS' }));
		expect(removalConsequences(planDemandRemoval(made, 'SYRQ9.ABS'))).toEqual(['Route 9 stays on CR 4 and carries nothing. A new demand can use it.', 'The file leaves the working copy and the next saved zip.', 'Its spec and sources leave pitman.json.']);
	});

	it('says a route from the zero source goes with its file', () => {
		expect(removalConsequences(planDemandRemoval(bundle(), 'SYTRANS.ABS'))[0]).toBe('Route 6 goes too: a route from the zero source must have a file (TT 689 p.xv).');
	});

	it('says where a shared file stays', () => {
		const b = bundle();
		const position = b.network.modules.findIndex((e) => e.type === 'RV') + 1;
		const shared: NetworkBundle = {
			...b,
			network: { ...b.network, routes: [...b.network.routes, { number: 12, upstreamPosition: position, downstreamPosition: 0, cost: 0 }] },
			modules: b.modules.map((m) => (m.kind === 'RV' ? { ...m, outflows: [...m.outflows, { route: 12, definedFlowFile: 'SYRQ9.ABS' }] } : m))
		};
		const plan = planDemandRemoval(shared, 'SYRQ9.ABS', { module: { type: 'CR', number: 4 }, route: 9, direction: 'out' });
		expect(removalConsequences(plan)).toEqual(['Route 9 stays on CR 4 and carries nothing. A new demand can use it.', 'The file stays, on RV 5 Synthetic dam, route 12 to the zero sink.', 'Your reason stays in pitman.json.']);
		expect(removalRoutes(planDemandRemoval(shared, 'SYRQ9.ABS'))).toBe('RV 5 route 12, CR 4 route 9');
	});
});

describe('demandFiles', () => {
	it('lists each file once, demands before defined inflows', () => {
		const rows = demandFiles(bundle());
		expect(rows.map((r) => r.name)).toEqual(['SYRQ9.ABS', 'SYTRANS.ABS']);
		expect(rows[0]?.attachments[0]?.direction).toBe('out');
		expect(rows[1]?.attachments[0]?.direction).toBe('in');
	});

	it('gives the years and the mean annual volume', () => {
		const [row] = demandFiles(bundle());
		expect([row?.firstYear, row?.lastYear]).toEqual([1985, 1994]);
		expect(row?.meanAnnualMm3).toBeCloseTo(0.294, 6); // 12 × (0.02 + 0.001 × mean of 0…9)
		expect(row?.shortfall).toBeNull();
	});

	it('has no spec for a loaded file', () => {
		expect(demandFiles(bundle())[0]?.spec).toBeUndefined();
	});

	it('finds the spec of an applied demand, and says when its rows changed', () => {
		const b = bundle();
		const next = applyDemand(b, planDemand(b, { spec, sources, file: 'SYRQ9.ABS' }));
		const row = demandFiles(next)[0]!;
		expect(row.spec).toEqual(spec);
		expect(row.specStale).toBe(false);
		const series = next.flowFiles['SYRQ9.ABS']!;
		const edited = { ...next, flowFiles: { ...next.flowFiles, 'SYRQ9.ABS': { ...series, rows: series.rows.slice(0, -1).concat({ ...series.rows.at(-1)!, year: 1994, months: Array<number>(12).fill(0.5) as unknown as Monthly12 }) } } };
		expect(demandFiles(edited)[0]?.specStale).toBe(true);
	});

	it('says when a file falls short of the run', () => {
		const b = bundle();
		const longer = { ...b, network: { ...b.network, endYear: 1999 } };
		expect(demandFiles(longer)[0]?.shortfall).toBe('It holds 1985/86 to 1994/95, and the run is 1985/86 to 1999/00: a historical run stops at the first missing year.');
	});
});

describe('attachmentLabel', () => {
	const a = { module: { type: 'RV', number: 5 }, name: 'Synthetic dam', route: 10, other: 'the zero sink' } as const;

	it('says an outflow and an inflow apart', () => {
		expect(attachmentLabel({ ...a, direction: 'out' })).toBe('RV 5 Synthetic dam, route 10 to the zero sink');
		expect(attachmentLabel({ ...a, direction: 'in', other: 'the zero source' })).toBe('Inflow to RV 5 Synthetic dam, route 10 from the zero source');
	});

	it('leaves a blank name out', () => {
		expect(attachmentLabel({ ...a, name: '', direction: 'out' })).toBe('RV 5, route 10 to the zero sink');
	});
});

describe('sourceLabel', () => {
	it('says who gave the value and when', () => {
		expect(sourceLabel({ kind: 'manual', note: ' town plan ', date: '2025-01-02T10:00:00Z' })).toBe('Typed in on 2025-01-02: town plan');
		expect(sourceLabel({ kind: 'manual', date: '2025-01-02' })).toBe('Typed in on 2025-01-02, no reference given');
		expect(sourceLabel({ kind: 'networkFile', note: 'estimated' })).toBe('From the network file: estimated');
		expect(sourceLabel(undefined)).toBe('No source recorded');
	});
});
