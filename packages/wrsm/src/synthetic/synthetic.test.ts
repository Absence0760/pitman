import { describe, expect, it } from 'vitest';
import { seededRandom, syntheticNetwork } from './synthetic.js';

describe('seededRandom', () => {
	it('repeats for a seed and differs between seeds', () => {
		const a = seededRandom(42);
		const b = seededRandom(42);
		const first = Array.from({ length: 5 }, a);
		expect(Array.from({ length: 5 }, b)).toEqual(first);
		expect(first.every((x) => x >= 0 && x < 1)).toBe(true);
		const c = seededRandom(43);
		expect(Array.from({ length: 5 }, c)).not.toEqual(first);
	});
});

describe('syntheticNetwork', () => {
	it('is deterministic', () => {
		expect(syntheticNetwork({ seed: 7 })).toEqual(syntheticNetwork({ seed: 7 }));
		expect(syntheticNetwork({ seed: 7 })).not.toEqual(syntheticNetwork({ seed: 8 }));
	});

	it('has the documented shape', () => {
		const { network, runoff, rainfall } = syntheticNetwork({ code: 'ZZ', startYear: 1980, years: 5 });
		expect(network.code).toBe('ZZ');
		expect([network.startYear, network.endYear]).toEqual([1980, 1984]);
		expect(network.modules.map((m) => `${m.number}${m.type}`)).toEqual(['1RU', '2RU', '3RU', '4CR']);
		expect(runoff.map((m) => m.number)).toEqual([1, 2, 3]);
		for (const m of runoff) {
			expect(m.groundwaterModel).toBe(0);
			expect(m.outflows).toHaveLength(1);
			expect(m.outflows[0]!.percent).toBe(100);
			// The outflow route starts at this module's position in the .NET list.
			const route = network.routes.find((r) => r.number === m.outflows[0]!.route)!;
			expect(network.modules[route.upstreamPosition - 1]).toMatchObject({ type: 'RU', number: m.number });
		}
		expect(runoff[1]!.inflowRoute).toBe(1);
		expect(rainfall.map((r) => r.fileName)).toEqual(['ZZA.RAN', 'ZZB.RAN']);
		// Every module names an existing file, ignoring case.
		const names = new Set(rainfall.map((r) => r.fileName.toUpperCase()));
		expect(runoff.every((m) => names.has(m.rainfallFile.toUpperCase()))).toBe(true);
		expect(runoff[2]!.rainfallFile).not.toBe('ZZB.RAN');
	});

	it('gives rainfall with summer seasonality around 100 % of MAP', () => {
		const { rainfall } = syntheticNetwork({ seed: 3, years: 60 });
		const rows = rainfall[0]!.series.rows;
		expect(rows).toHaveLength(60);
		expect(rows.map((r) => r.year)).toEqual(Array.from({ length: 60 }, (_, i) => 1990 + i));
		const monthMean = (m: number) => rows.reduce((a, r) => a + r.months[m]!, 0) / rows.length;
		const annualMean = rows.reduce((a, r) => a + r.months.reduce((x, y) => x + y, 0), 0) / rows.length;
		expect(annualMean).toBeGreaterThan(85);
		expect(annualMean).toBeLessThan(115);
		// January (index 3) is wetter than July (index 9).
		expect(monthMean(3)).toBeGreaterThan(2 * monthMean(9));
		expect(rows.every((r) => r.months.every((v) => v >= 0))).toBe(true);
	});
});
