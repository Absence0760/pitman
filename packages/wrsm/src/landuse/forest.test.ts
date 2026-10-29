import { describe, expect, it } from 'vitest';
import { syntheticNetwork } from '../synthetic/index.js';
import type { Afforestation, MonthlySeries, RunMode, RunoffModule } from '../types.js';
import {
	DEFAULT_FOREST_OPTIONS,
	GENERA,
	SMOOTHED_GUSH_TABLE,
	forestChildTargets,
	forestReduction,
	gushReductionPercent,
	hasAfforestation,
	smoothedGushTargets
} from './forest.js';

const base = syntheticNetwork().runoff[0]!;

const species = (pine: number, eucalyptus: number, wattle: number): NonNullable<Afforestation['species']> => ({
	pine: { percent: pine, rotationYears: 20 },
	eucalyptus: { percent: eucalyptus, rotationYears: 10 },
	wattle: { percent: wattle, rotationYears: 10 }
});

const withForest = (afforestation: Partial<Afforestation>, mapMm = 800): RunoffModule => ({
	...base,
	mapMm,
	afforestation: { algorithm: 2, algorithmInFile: true, areaKm2: [{ year: 1990, value: 5 }], species: species(100, 0, 0), optimalPercent: 60, ...afforestation }
});

describe('TT 690 Table 11.1 (p.123)', () => {
	it('is transcribed as printed', () => {
		expect(SMOOTHED_GUSH_TABLE).toEqual({
			pine: { mar: { a: 112.92, b: 0.07, minimum: 6.0 }, lowFlow: { a: 119.34, b: 0.078, minimum: 2.9 } },
			eucalyptus: { mar: { a: 120.6, b: 0.064, minimum: 9.6 }, lowFlow: { a: 128.03, b: 0.054, minimum: 36.4 } },
			wattle: { mar: { a: 120.85, b: 0.079, minimum: 8.2 }, lowFlow: { a: 123.02, b: 0.067, minimum: 24.8 } }
		});
		expect(GENERA).toEqual(['pine', 'eucalyptus', 'wattle']);
	});
});

describe('gushReductionPercent (TT 690 p.122 eq. 11.1)', () => {
	it('is a − b × MAP inside its bounds', () => {
		expect(gushReductionPercent(SMOOTHED_GUSH_TABLE.pine.mar, 700)).toBeCloseTo(112.92 - 0.07 * 700, 10);
		expect(gushReductionPercent(SMOOTHED_GUSH_TABLE.wattle.lowFlow, 900)).toBeCloseTo(123.02 - 0.067 * 900, 10);
	});

	it('floors at the table minimum at high MAP', () => {
		expect(gushReductionPercent(SMOOTHED_GUSH_TABLE.pine.mar, 2000)).toBe(6.0);
		// Eucalypt low flow: 128.03 − 0.054 × 1800 = 30.83 < 36.4.
		expect(gushReductionPercent(SMOOTHED_GUSH_TABLE.eucalyptus.lowFlow, 1800)).toBe(36.4);
	});

	it('caps at 100 % ("the maximum reduction cannot exceed 100%")', () => {
		expect(gushReductionPercent(SMOOTHED_GUSH_TABLE.eucalyptus.lowFlow, 100)).toBe(100);
		expect(gushReductionPercent(SMOOTHED_GUSH_TABLE.pine.mar, 0)).toBe(100);
	});
});

describe('smoothedGushTargets', () => {
	it('gives one genus its own line', () => {
		const t = smoothedGushTargets(species(0, 100, 0), 800);
		expect(t.marPercent).toBeCloseTo(120.6 - 0.064 * 800, 10);
		expect(t.lowFlowPercent).toBeCloseTo(128.03 - 0.054 * 800, 10);
	});

	it('reproduces the worked example in docs/theory/afforestation.md §3.1', () => {
		const t = smoothedGushTargets(species(60, 30, 10), 800);
		expect(t.marPercent).toBeCloseTo(60.737, 9);
		expect(t.lowFlowPercent).toBeCloseTo(66.555, 9);
	});

	it('weights genera by their L.009 percentages (R6-F1)', () => {
		const t = smoothedGushTargets(species(50, 0, 50), 1000);
		expect(t.marPercent).toBeCloseTo(0.5 * (112.92 - 70) + 0.5 * (120.85 - 79), 10);
		expect(t.lowFlowPercent).toBeCloseTo(0.5 * (119.34 - 78) + 0.5 * (123.02 - 67), 10);
	});

	it('scales by shares as written, or normalises them, when they miss 100 (R6-F1)', () => {
		const asWritten = smoothedGushTargets(species(40, 0, 40), 1000);
		const normalised = smoothedGushTargets(species(40, 0, 40), 1000, 'normalised');
		const full = smoothedGushTargets(species(50, 0, 50), 1000);
		expect(asWritten.marPercent).toBeCloseTo(0.8 * full.marPercent, 10);
		expect(normalised.marPercent).toBeCloseTo(full.marPercent, 10);
		expect(smoothedGushTargets(species(0, 0, 0), 1000, 'normalised')).toEqual({ marPercent: 0, lowFlowPercent: 0 });
		expect(smoothedGushTargets(species(0, 0, 0), 1000)).toEqual({ marPercent: 0, lowFlowPercent: 0 });
	});

	it('stays within 0–100 % for any MAP', () => {
		for (const map of [0, 300, 650, 900, 1500, 3000]) {
			for (const s of [species(100, 0, 0), species(0, 100, 0), species(0, 0, 100), species(30, 30, 40)]) {
				const t = smoothedGushTargets(s, map);
				expect(t.marPercent).toBeGreaterThanOrEqual(0);
				expect(t.marPercent).toBeLessThanOrEqual(100);
				expect(t.lowFlowPercent).toBeGreaterThanOrEqual(0);
				expect(t.lowFlowPercent).toBeLessThanOrEqual(100);
			}
		}
	});
});

describe('forestChildTargets', () => {
	it('Smoothed Gush uses the (inherited) MAP of the child', () => {
		const r = forestChildTargets(withForest({ algorithm: 2, species: species(100, 0, 0) }, 600));
		expect(r.targets!.marPercent).toBeCloseTo(112.92 - 0.07 * 600, 10);
		expect(r.targets!.lowFlowPercent).toBeCloseTo(119.34 - 0.078 * 600, 10);
		expect(r.label).toBe('Smoothed Gush/Pitman');
		expect(r.messages).toEqual([]);
	});

	it('warns when genus shares miss 100 %', () => {
		const r = forestChildTargets(withForest({ species: species(60, 20, 10) }));
		expect(r.messages.map((m) => m.text).join()).toMatch(/90\.00 %/);
	});

	it('user defined returns L.010 vars 2–3 (UD_TPRM, UD_TPRL, TT 691 p.52)', () => {
		const r = forestChildTargets(withForest({ algorithm: 4, userDefinedReduction: { marPercent: 62.95, lowFlowPercent: 40 } }));
		expect(r.targets).toEqual({ marPercent: 62.95, lowFlowPercent: 40 });
	});

	it('user defined without L.010 vars 2–3 gives no reduction, with a warning', () => {
		const r = forestChildTargets(withForest({ algorithm: 4 }));
		expect(r.targets).toBeNull();
		expect(r.messages[0]!.level).toBe('warning');
	});

	it('Smoothed Gush without L.009 gives no reduction, with a warning', () => {
		const r = forestChildTargets(withForest({ algorithm: 2, species: undefined }));
		expect(r.targets).toBeNull();
		expect(r.messages[0]!.level).toBe('warning');
	});

	it('CSIR substitutes Smoothed Gush by default and warns (R6-F2)', () => {
		const m = withForest({ algorithm: 1, species: species(0, 0, 100) }, 900);
		const r = forestChildTargets(m);
		expect(DEFAULT_FOREST_OPTIONS.csirChild).toBe('smoothedGush');
		expect(r.targets).toEqual(smoothedGushTargets(species(0, 0, 100), 900));
		expect(r.messages[0]!.text).toMatch(/R6-F2/);
		expect(forestChildTargets(m, { csirChild: 'none' }).targets).toBeNull();
	});

	it('LUT Gush and Van der Zel give no reduction, with a warning (R6-F4, R6-F3)', () => {
		for (const algorithm of [3, 0] as const) {
			const r = forestChildTargets(withForest({ algorithm }));
			expect(r.targets).toBeNull();
			expect(r.messages).toHaveLength(1);
		}
	});
});

describe('forestReduction (free module, contract shape)', () => {
	const unreduced: MonthlySeries = { startYear: 1990, values: Array.from({ length: 24 }, (_, i) => 0.1 + i / 100), unit: 'Mm3' };
	const input = (module: RunoffModule, mode: RunMode) => ({
		module,
		parent: null,
		mode,
		startYear: 1990,
		endYear: 1991,
		unreducedRunoffMm3: unreduced,
		rainfallMm: new Array<number>(24).fill(50)
	});

	it('is zero, 0 ≤ reduction ≤ unreduced, with a warning saying why (R6-F3, R6-F5)', () => {
		for (const algorithm of [0, 1, 2, 3, 4] as const) {
			const out = forestReduction(input(withForest({ algorithm }), { kind: 'historical' }));
			expect(out.reductionMm3.values).toEqual(new Array<number>(24).fill(0));
			out.reductionMm3.values.forEach((r, i) => {
				expect(r).toBeGreaterThanOrEqual(0);
				expect(r).toBeLessThanOrEqual(unreduced.values[i]!);
			});
			expect(out.reductionMm3.startYear).toBe(1990);
			expect(out.messages).toHaveLength(1);
			expect(out.messages[0]!.text).toMatch(algorithm <= 1 ? /R6-F3/ : /R6-F5/);
		}
	});

	it('is silent in natural mode and without afforested area', () => {
		expect(forestReduction(input(withForest({}), { kind: 'natural' })).messages).toEqual([]);
		expect(forestReduction(input(withForest({ areaKm2: [] }), { kind: 'historical' })).messages).toEqual([]);
		expect(forestReduction(input(withForest({ areaKm2: [{ year: 1990, value: 0 }] }), { kind: 'presentDay', year: 2025 })).messages).toEqual([]);
	});
});

describe('hasAfforestation', () => {
	it('needs some area above zero', () => {
		expect(hasAfforestation(withForest({}))).toBe(true);
		expect(hasAfforestation(withForest({ areaKm2: [] }))).toBe(false);
		expect(hasAfforestation(withForest({ areaKm2: [{ year: 1990, value: 0 }] }))).toBe(false);
	});
});
