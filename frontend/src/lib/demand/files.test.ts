import { describe, expect, it } from 'vitest';
import { applyDemand, planDemand, syntheticBundle, type DemandSpec, type Monthly12, type NetworkBundle } from '@pitman/wrsm';
import { attachmentLabel, demandFiles, sourceLabel } from './files.js';

// The engine's synthetic network, invented values only (issue #3 rule 2).

const spec: DemandSpec = { annualVolumeMm3: 1.2, monthlyDistributionPercent: Array<number>(12).fill(100 / 12) as unknown as Monthly12, growth: [{ year: 1985, value: 1.2 }] };
const source = { kind: 'manual', note: 'town plan', date: '2025-01-02' } as const;
const sources = { annualVolume: source, monthlyDistribution: source, growth: {} };
const bundle = (): NetworkBundle => syntheticBundle({ startYear: 1985, years: 10 });

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
