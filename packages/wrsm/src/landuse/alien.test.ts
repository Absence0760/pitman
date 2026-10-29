import { describe, expect, it } from 'vitest';
import { syntheticSamiParameters } from '../groundwater/sami/fake-parts.js';
import { syntheticBundle } from '../network/synthetic-bundle.js';
import { potentialEvaporation, simulatePitman } from '../runoff/pitman.js';
import type { AlienVegetation, MonthlySeries, RunMode, RunoffModule } from '../types.js';
import {
	DEFAULT_ALIEN_OPTIONS,
	TALL_SHRUB_C_REFERENCE_FIT,
	alienAreaByMonth,
	alienBiomass,
	alienClassReduction,
	alienReductionTargets,
	alienVegetationReduction,
	evaporationDeficit,
	sfrFlowStatistics,
	longLagAnnualReduction,
	longLagLowFlowReduction,
	mediumTreeBiomass,
	riparianDeduction,
	riparianVolume,
	shortLagAnnualReduction,
	shortLagLowFlowReduction,
	tallShrubBiomass,
	tallTreeBiomass,
	type AlienOptions
} from './alien.js';
import type { StreamflowReduction } from './contract.js';

// Expected values were computed independently (Python, double precision)
// from the printed equations of TT 690 pp.133–135; all fixtures are synthetic.

const opts = (o: Partial<AlienOptions>): AlienOptions => ({ ...DEFAULT_ALIEN_OPTIONS, ...o });

/** Seeded uniform [0, 1) generator (mulberry32). */
function random(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

describe('age → biomass (TT 690 §12.4.3 p.133)', () => {
	it('eq. 12.3: tall trees (pine)', () => {
		expect(tallTreeBiomass(20)).toBeCloseTo(190.04632132584413, 9);
		expect(tallTreeBiomass(40)).toBeCloseTo(246.38955940150888, 9);
		expect(tallTreeBiomass(0)).toBe(0);
	});

	it('eq. 12.4: medium trees, floored at 0 below age ≈ 1.12 (R6-V5)', () => {
		expect(mediumTreeBiomass(20)).toBeCloseTo(120.18601497942481, 9);
		expect(mediumTreeBiomass(1)).toBe(0);
		expect(mediumTreeBiomass(1.1)).toBe(0);
		expect(mediumTreeBiomass(1.2)).toBeGreaterThan(0);
	});

	it('eq. 12.5: tall shrubs; c switchable (R6-V6)', () => {
		expect(tallShrubBiomass(9)).toBeCloseTo(34.22827110383494, 9);
		expect(tallShrubBiomass(20)).toBeCloseTo(53.82208709554647, 9);
		expect(tallShrubBiomass(20, TALL_SHRUB_C_REFERENCE_FIT)).toBeLessThan(tallShrubBiomass(20));
		expect(alienBiomass('tallShrubs', 20, { tallShrubBiomassC: TALL_SHRUB_C_REFERENCE_FIT })).toBe(tallShrubBiomass(20, TALL_SHRUB_C_REFERENCE_FIT));
	});

	it('every class grows with age towards its asymptote (300, –, 76 t/ha)', () => {
		for (const cls of ['tallTrees', 'mediumTrees', 'tallShrubs'] as const) {
			let prev = -1;
			for (let a = 2; a <= 60; a++) {
				const b = alienBiomass(cls, a);
				expect(b).toBeGreaterThan(prev);
				prev = b;
			}
		}
		expect(tallTreeBiomass(1e6)).toBeLessThan(300);
		expect(tallShrubBiomass(1e6)).toBeLessThan(76);
	});
});

describe('biomass → flow reduction (TT 690 §12.4.5–12.4.7 pp.134–135)', () => {
	it('eq. 12.6: long lag, annual, asymptote 115', () => {
		expect(longLagAnnualReduction(150)).toBeCloseTo(69.0271438455758, 9);
	});

	it('eq. 12.7: long lag, low flow, asymptote 122', () => {
		expect(longLagLowFlowReduction(150)).toBeCloseTo(74.8038340023903, 9);
	});

	it('eq. 12.8: short lag, annual, asymptote 103', () => {
		expect(shortLagAnnualReduction(150)).toBeCloseTo(80.7008404446752, 9);
		expect(shortLagAnnualReduction(0)).toBeCloseTo(9.421554308599426, 9);
	});

	it('eq. 12.9: short lag, low flow, asymptote 102', () => {
		expect(shortLagLowFlowReduction(150)).toBeCloseTo(86.81278567274347, 9);
		expect(shortLagLowFlowReduction(0)).toBeCloseTo(12.508886698908658, 9);
	});

	it('§12.4.7: the asymptote scales the curve linearly (the printed 75 and 100 models)', () => {
		expect(longLagAnnualReduction(150, 75)).toBeCloseTo((69.0271438455758 * 75) / 115, 9);
		expect(shortLagLowFlowReduction(150, 100)).toBeCloseTo((86.81278567274347 * 100) / 102, 9);
	});

	it('long lag: no reduction without biomass; short lag starts at ~9 % (annual) and ~12.5 % (low)', () => {
		expect(longLagAnnualReduction(0)).toBe(0);
		expect(longLagLowFlowReduction(0)).toBe(0);
		expect(longLagAnnualReduction(-1)).toBe(0);
	});

	it('long vs short lag: a young stand reduces flow far more on the short-lag curves; both rise with biomass', () => {
		const young = tallTreeBiomass(3);
		expect(shortLagAnnualReduction(young)).toBeGreaterThan(5 * longLagAnnualReduction(young));
		let prevLong = -1;
		let prevShort = -1;
		for (let b = 1; b <= 300; b += 1) {
			expect(longLagAnnualReduction(b)).toBeGreaterThan(prevLong);
			expect(shortLagAnnualReduction(b)).toBeGreaterThan(prevShort);
			prevLong = longLagAnnualReduction(b);
			prevShort = shortLagAnnualReduction(b);
		}
	});

	it('low-flow reduction is at least the annual one on both curves for 30–240 t/ha (tall trees up to ~age 37)', () => {
		for (let b = 30; b <= 240; b += 10) {
			expect(longLagLowFlowReduction(b)).toBeGreaterThanOrEqual(longLagAnnualReduction(b));
			expect(shortLagLowFlowReduction(b)).toBeGreaterThanOrEqual(shortLagAnnualReduction(b));
		}
	});
});

describe('class reductions (R6-V1, R6-V2, R6-V4, R6-V5)', () => {
	it('R6-V1: the optimal share on short lag, the rest on long lag', () => {
		expect(alienClassReduction('tallTrees', 20, 100).annualPercent).toBeCloseTo(93.1122233265365, 9);
		expect(alienClassReduction('tallTrees', 20, 0).annualPercent).toBeCloseTo(86.22112764706037, 9);
		expect(alienClassReduction('tallTrees', 20, 50).annualPercent).toBeCloseTo(89.66667548679843, 9);
	});

	it('R6-V5: each curve is capped at 100 % (old tall trees exceed it uncapped)', () => {
		expect(longLagAnnualReduction(tallTreeBiomass(200))).toBeGreaterThan(100);
		const r = alienClassReduction('tallTrees', 200, 0);
		expect(r.annualPercent).toBe(100);
		expect(r.lowFlowPercent).toBe(100);
	});

	it('R6-V4: the Table 12.4 maximum scales the asymptotes', () => {
		const r = alienClassReduction('tallTrees', 20, 0, opts({ maxReductionPercent: 80 }));
		expect(r.annualPercent).toBeCloseTo(longLagAnnualReduction(tallTreeBiomass(20), 0.8 * 115), 9);
	});

	it('R6-V2: ageClassMean averages ages 1 … round(2 × age) (TT 690 §12.4.8)', () => {
		const mean = alienClassReduction('mediumTrees', 15, 40, opts({ age: 'ageClassMean' }));
		let s = 0;
		for (let a = 1; a <= 30; a++) s += alienClassReduction('mediumTrees', a, 40).annualPercent;
		expect(mean.annualPercent).toBeCloseTo(s / 30, 12);
		// Age 0.2 still averages one age class (age 1).
		expect(alienClassReduction('tallTrees', 0.2, 50, opts({ age: 'ageClassMean' }))).toEqual(alienClassReduction('tallTrees', 1, 50));
	});
});

const composition = {
	tallTrees: { percent: 30, ageYears: 20 },
	mediumTrees: { percent: 50, ageYears: 15 },
	tallShrubs: { percent: 20, ageYears: 25 }
};
const alienBlock = (over: Partial<AlienVegetation> = {}): AlienVegetation => ({
	algorithm: 1,
	riparianArea: 0,
	areaKm2: [{ year: 2000, value: 2 }, { year: 2002, value: 4 }, { year: 2004, value: 4 }],
	composition,
	optimalPercent: 40,
	...over
});

describe('targets TPRM / TPRL (TT 691 p.56 RU_GetSFReduction)', () => {
	it('area-weighted sum of the class reductions', () => {
		const t = alienReductionTargets(alienBlock());
		expect(t.tprm).toBeCloseTo(54.67728979960187, 9);
		expect(t.tprl).toBeCloseTo(62.952036753974504, 9);
		expect(t.messages).toEqual([]);
	});

	it('R6-V2 ageClassMean and R6-V6 the fitted shrub constant change TPRM', () => {
		expect(alienReductionTargets(alienBlock(), opts({ age: 'ageClassMean' })).tprm).toBeCloseTo(47.63109661027517, 9);
		expect(alienReductionTargets(alienBlock(), opts({ tallShrubBiomassC: TALL_SHRUB_C_REFERENCE_FIT })).tprm).toBeCloseTo(54.37193479409205, 9);
	});

	it('R6-V7: TPRL is never below TPRM; `tprm` makes them equal', () => {
		const young = alienBlock({ composition: { ...composition, tallTrees: { percent: 30, ageYears: 2 } } });
		const t = alienReductionTargets(young);
		expect(t.tprl).toBeGreaterThanOrEqual(t.tprm);
		const e = alienReductionTargets(alienBlock(), opts({ lowFlowTarget: 'tprm' }));
		expect(e.tprl).toBe(e.tprm);
	});

	it('algorithm 0 and a missing class split give no reduction', () => {
		expect(alienReductionTargets(alienBlock({ algorithm: 0 }))).toMatchObject({ tprm: 0, tprl: 0 });
		const t = alienReductionTargets({ algorithm: 1, riparianArea: 0, areaKm2: [{ year: 2000, value: 1 }] });
		expect(t).toMatchObject({ tprm: 0, tprl: 0 });
		expect(t.messages[0]!.level).toBe('warning');
	});

	it('warns on shares not adding to 100 (TT 689 p.128) and on ages under 10 (TT 691 p.211); notes algorithm 2', () => {
		const t = alienReductionTargets(alienBlock({ algorithm: 2, composition: { ...composition, tallShrubs: { percent: 10, ageYears: 5 } } }));
		const texts = t.messages.map((m) => m.text).join('\n');
		expect(texts).toMatch(/add up to 90 %/);
		expect(texts).toMatch(/5 years old/);
		expect(texts).toMatch(/algorithm 2/);
	});

	it('rejects an optimal % or share outside 0–100', () => {
		expect(alienReductionTargets(alienBlock({ optimalPercent: 120 })).messages[0]!.level).toBe('error');
		expect(alienReductionTargets(alienBlock({ composition: { ...composition, tallTrees: { percent: -1, ageYears: 20 } } })).messages[0]!.level).toBe('error');
	});

	it('stays within 0–100 for random inputs', () => {
		const r = random(7);
		for (let i = 0; i < 500; i++) {
			const p1 = r() * 100;
			const p2 = r() * (100 - p1);
			const t = alienReductionTargets(
				alienBlock({
					composition: {
						tallTrees: { percent: p1, ageYears: 1 + r() * 80 },
						mediumTrees: { percent: p2, ageYears: 1 + r() * 80 },
						tallShrubs: { percent: 100 - p1 - p2, ageYears: 1 + r() * 80 }
					},
					optimalPercent: r() * 100
				}),
				opts({ age: r() < 0.5 ? 'single' : 'ageClassMean' })
			);
			expect(t.tprm).toBeGreaterThanOrEqual(0);
			expect(t.tprm).toBeLessThanOrEqual(100);
			expect(t.tprl).toBeGreaterThanOrEqual(t.tprm);
			expect(t.tprl).toBeLessThanOrEqual(100);
		}
	});
});

describe('riparian deduction (TT 690 §12.5.2 pp.139–140)', () => {
	it('eq. 12.10: ETDEF = max(0, PEACT − EAVE)', () => {
		expect(evaporationDeficit(120, 80)).toBe(40);
		expect(evaporationDeficit(80, 120)).toBe(0);
	});

	it('eq. 12.11: ETVOL = 0.001 × ETDEF × PRIP × AREA, million m³ (PRIP as a proportion)', () => {
		// 40 mm over 2 % of 50 km² = 0.04 m × 1 km² = 0.04 million m³.
		expect(riparianVolume(40, 2, 50)).toBeCloseTo(0.04, 15);
	});

	it('eq. 12.12: TotalOutflow = max(0, TotalOutflow − ETVOL)', () => {
		const r = riparianDeduction({ outflowMm3: [0.1, 0.01, 0], potentialEvaporationMm: [140, 140, 50], actualEvaporationMm: [40, 40, 60], riparianPercent: 2, areaKm2: [50, 50, 50] });
		expect(r.demandMm3[0]).toBeCloseTo(0.1, 15);
		expect(r.outflowMm3[0]).toBeCloseTo(0, 15);
		expect(r.outflowMm3[1]).toBe(0);
		expect(r.lossMm3[1]).toBeCloseTo(0.01, 15);
		expect(r.demandMm3[2]).toBe(0);
	});

	it('rejects series of different lengths', () => {
		expect(() => riparianDeduction({ outflowMm3: [1, 2], potentialEvaporationMm: [1], actualEvaporationMm: [1, 2], riparianPercent: 1, areaKm2: [1, 1] })).toThrow(RangeError);
	});
});

describe('areas and flow statistics', () => {
	const table = [{ year: 2000, value: 2 }, { year: 2002, value: 4 }];

	it('historical: the year table month by month, linear between years, flat beyond', () => {
		const a = alienAreaByMonth(table, { kind: 'historical' }, 1999, 2003);
		expect(a.length).toBe(60);
		expect([a[0], a[12], a[24], a[36], a[48]]).toEqual([2, 2, 3, 4, 4]);
		expect(new Set(a.slice(24, 36)).size).toBe(1);
	});

	it('present day holds the area at the chosen year; natural is zero (D1)', () => {
		expect(new Set(alienAreaByMonth(table, { kind: 'presentDay', year: 2001 }, 1990, 2010))).toEqual(new Set([3]));
		expect(new Set(alienAreaByMonth(table, { kind: 'natural' }, 1990, 2010))).toEqual(new Set([0]));
	});

	it('MAR = mean year total; low flow = mean of the lowest quarter (TT 689 p.138)', () => {
		const v = Array.from({ length: 24 }, (_, i) => i + 1);
		const s = sfrFlowStatistics(v);
		expect(s.marMm3).toBeCloseTo(300 / 2, 12);
		expect(s.lowFlowMm3).toBeCloseTo((1 + 2 + 3 + 4 + 5 + 6) / 6, 12);
		expect(sfrFlowStatistics([])).toEqual({ marMm3: 0, lowFlowMm3: 0 });
	});
});

// ---------------------------------------------------------------------------
// The module reduction
// ---------------------------------------------------------------------------

const base = syntheticBundle().modules.find((m): m is RunoffModule => m.kind === 'RU')!;
const START = 2000;
const END = 2004;
const N = 12 * (END - START + 1);
const freeModule = (alien: AlienVegetation, FT = 0): RunoffModule => ({ ...base, areaKm2: 10, pitman: { ...base.pitman, FT }, alienVegetation: alien });
const series = (values: number[]): MonthlySeries => ({ startYear: START, values, unit: 'Mm3' });
const runoff = (seed: number): number[] => {
	const r = random(seed);
	return Array.from({ length: N }, () => (r() < 0.2 ? 0 : r() * 2));
};
const call = (module: RunoffModule, q: number[], mode: RunMode = { kind: 'historical' }, extra: object = {}, parent: RunoffModule | null = null) =>
	alienVegetationReduction({ module, parent, mode, startYear: START, endYear: END, unreducedRunoffMm3: series(q), rainfallMm: new Array(N).fill(50), ...extra });

describe('alienVegetationReduction', () => {
	it('is a StreamflowReduction', () => {
		const f: StreamflowReduction = alienVegetationReduction;
		expect(typeof f).toBe('function');
	});

	it('free module: month t loses (alien area / AREA) × TPRM % (R6-V11)', () => {
		const q = runoff(1);
		const out = call(freeModule(alienBlock()), q);
		const tprm = out.targets.tprm;
		// 2000 area 2, 2001 area 3, 2002+ area 4, module 10 km².
		for (let t = 0; t < N; t++) {
			const share = (t < 12 ? 2 : t < 24 ? 3 : 4) / 10;
			expect(out.reductionMm3.values[t]).toBeCloseTo(share * (tprm / 100) * q[t]!, 12);
		}
		expect(out.virginMarMm3).toBeUndefined();
		expect(out.messages).toEqual([]);
	});

	it('invariants: 0 ≤ reduction ≤ unreduced runoff, whatever the area, riparian % and evaporation', () => {
		const r = random(3);
		for (let i = 0; i < 100; i++) {
			const q = runoff(100 + i).map((v) => (r() < 0.05 ? -v : v)); // a few negative months (lag, OQ-22)
			const alien = alienBlock({ riparianArea: r() * 30, areaKm2: [{ year: START, value: r() * 10 }, { year: END, value: r() * 10 }] });
			const pe = Array.from({ length: N }, () => r() * 200);
			const ae = Array.from({ length: N }, () => r() * 200);
			const out = call(freeModule(alien), q, { kind: 'historical' }, { evaporation: { potentialMm: pe, actualMm: ae }, options: { freeModuleMonths: r() < 0.5 ? 'proportional' : 'lowFlowMonths' } });
			out.reductionMm3.values.forEach((red, t) => {
				expect(red).toBeGreaterThanOrEqual(0);
				expect(red).toBeLessThanOrEqual(Math.max(0, q[t]!) + 1e-15);
			});
		}
	});

	it('zero area ⇒ zero reduction; natural mode ⇒ zero reduction (TT 689 p.27)', () => {
		const q = runoff(2);
		const zero = call(freeModule(alienBlock({ areaKm2: [{ year: START, value: 0 }] })), q);
		expect(zero.reductionMm3.values.every((v) => v === 0)).toBe(true);
		const nat = call(freeModule(alienBlock({ riparianArea: 5 })), q, { kind: 'natural' }, { evaporation: { potentialMm: new Array(N).fill(200), actualMm: new Array(N).fill(0) } });
		expect(nat.reductionMm3.values.every((v) => v === 0)).toBe(true);
		expect(nat.riparianDemandMm3.values.every((v) => v === 0)).toBe(true);
		const none = call({ ...base, areaKm2: 10, alienVegetation: undefined } as unknown as RunoffModule, q);
		expect(none.reductionMm3.values.every((v) => v === 0)).toBe(true);
	});

	it('present day holds the area at the year over the whole record (D1)', () => {
		const q = new Array(N).fill(1);
		const out = call(freeModule(alienBlock()), q, { kind: 'presentDay', year: 2001 });
		expect(new Set(out.areaKm2)).toEqual(new Set([3]));
		expect(new Set(out.reductionMm3.values.map((v) => v.toFixed(12))).size).toBe(1);
		expect(out.reductionMm3.values[0]).toBeCloseTo(0.3 * (out.targets.tprm / 100), 12);
	});

	it('R6-V11 lowFlowMonths: the lowest quarter of months loses TPRL %', () => {
		const q = Array.from({ length: N }, (_, t) => 1 + t); // the first 15 months are the lowest quarter
		const out = call(freeModule(alienBlock({ areaKm2: [{ year: START, value: 10 }] })), q, { kind: 'historical' }, { options: { freeModuleMonths: 'lowFlowMonths' } });
		expect(out.reductionMm3.values[0]).toBeCloseTo((out.targets.tprl / 100) * 1, 12);
		expect(out.reductionMm3.values[14]).toBeCloseTo((out.targets.tprl / 100) * 15, 12);
		expect(out.reductionMm3.values[15]).toBeCloseTo((out.targets.tprm / 100) * 16, 12);
	});

	it('child: the virgin series loses TPRM %, so its MAR drops from VMAR to QMAR = VMAR (1 − TPRM/100)', () => {
		const q = runoff(4);
		const out = call(freeModule(alienBlock(), 20), q, { kind: 'historical' }, {}, base);
		const vmar = sfrFlowStatistics(q).marMm3;
		expect(out.virginMarMm3).toBeCloseTo(vmar, 12);
		const reducedMar = sfrFlowStatistics(q.map((v, t) => v - out.reductionMm3.values[t]!)).marMm3;
		expect(reducedMar).toBeCloseTo(vmar * (1 - out.targets.tprm / 100), 12);
		// No FT note for a child.
		expect(out.messages).toEqual([]);
	});

	it('free module with FT > 0: notes that TT 689 p.140 wants a child', () => {
		const out = call(freeModule(alienBlock(), 15), runoff(5));
		expect(out.messages.map((m) => m.level)).toEqual(['info']);
	});

	it('the FT note reads the active Pitman set: a Sami module’s L.035 FT, not L.003’s', () => {
		const m = freeModule(alienBlock(), 0);
		const sami = { ...m, groundwaterModel: 2 as const, sami: syntheticSamiParameters({ ...m.pitman, FT: 15 }) };
		expect(call(sami, runoff(5)).messages.map((x) => x.level)).toEqual(['info']);
		const samiZero = { ...freeModule(alienBlock(), 15), groundwaterModel: 2 as const, sami: syntheticSamiParameters({ ...m.pitman, FT: 0 }) };
		expect(call(samiZero, runoff(5)).messages).toEqual([]);
	});

	it('area above the module area is an error (TT 689 p.128) and is held at the area', () => {
		const out = call(freeModule(alienBlock({ areaKm2: [{ year: START, value: 12 }] })), new Array(N).fill(1));
		expect(out.messages.some((m) => m.level === 'error')).toBe(true);
		expect(out.reductionMm3.values[0]).toBeCloseTo(out.targets.tprm / 100, 12);
	});

	it('riparian % without evaporation: deduction skipped with a warning', () => {
		const out = call(freeModule(alienBlock({ riparianArea: 2 })), runoff(6));
		expect(out.messages.some((m) => m.level === 'warning' && /deduction skipped/.test(m.text))).toBe(true);
	});

	it('riparian deduction on a simulated Pitman run: ETVOL off what the CSIR reduction leaves (R6-V9, R6-V10)', () => {
		const module = freeModule(alienBlock({ riparianArea: 5, areaKm2: [{ year: START, value: 4 }] }));
		const r = random(11);
		const rainfallMm = Array.from({ length: N }, (_, t) => (t % 12 < 6 ? 20 + r() * 120 : r() * 30));
		const sim = simulatePitman({ params: module.pitman, sPanMm: module.sPanMm, panFactors: module.panFactors, rainfallMm });
		const pe = potentialEvaporation(module.sPanMm, module.panFactors, module.pitman.FF);
		const potentialMm = sim.months.map((_, t) => pe[t % 12]!);
		const actualMm = sim.months.map((mo) => mo.E + mo.interception);
		const q = sim.months.map((mo) => (mo.runoff * module.areaKm2) / 1000);
		const plain = call(module, q, { kind: 'historical' }, { options: {} });
		const rip = call(module, q, { kind: 'historical' }, { evaporation: { potentialMm, actualMm } });
		for (let t = 0; t < N; t++) {
			// Eq. 12.12 caps the loss at the alien area's own residual runoff (0.4 of the module), not the module's.
			const left = 0.4 * q[t]! - plain.reductionMm3.values[t]!;
			const etvol = 0.001 * Math.max(0, potentialMm[t]! - actualMm[t]!) * 0.05 * 4;
			expect(rip.riparianDemandMm3.values[t]).toBeCloseTo(etvol, 12);
			expect(rip.reductionMm3.values[t]).toBeCloseTo(plain.reductionMm3.values[t]! + Math.min(Math.max(0, left), etvol), 12);
		}
		// R6-V9 `module`: AREA instead of the active alien area takes more.
		const wide = call(module, q, { kind: 'historical' }, { evaporation: { potentialMm, actualMm }, options: { riparianArea: 'module' } });
		const total = (o: { reductionMm3: MonthlySeries }) => o.reductionMm3.values.reduce((a, b) => a + b, 0);
		expect(total(wide)).toBeGreaterThanOrEqual(total(rip));
	});

	it('riparian loss never exceeds the alien area\'s residual runoff (TT 690 p.139; TT 689 p.129)', () => {
		// AREA 100 km², 1 km² alien, all riparian, ETDEF 100 mm: ETVOL 0.1 Mm³ ≫ the alien km²'s runoff.
		const module = { ...freeModule(alienBlock({ riparianArea: 100, areaKm2: [{ year: START, value: 1 }, { year: END, value: 1 }] })), areaKm2: 100 };
		const q = new Array(N).fill(2); // 20 mm/month over 100 km²
		const out = call(module, q, { kind: 'historical' }, { evaporation: { potentialMm: new Array(N).fill(150), actualMm: new Array(N).fill(50) } });
		out.reductionMm3.values.forEach((v) => expect(v).toBeCloseTo(0.02, 12)); // all of the alien km²'s 0.02 Mm³, nothing more
	});

	it('warns when the alien years do not cover a historical run (TT 689 p.128); not in present day', () => {
		const short = alienBlock({ areaKm2: [{ year: 2001, value: 2 }, { year: 2003, value: 2 }] });
		expect(call(freeModule(short), runoff(8)).messages.some((m) => /don't cover the run/.test(m.text))).toBe(true);
		expect(call(freeModule(short), runoff(8), { kind: 'presentDay', year: 2002 }).messages.some((m) => /don't cover/.test(m.text))).toBe(false);
	});

	it('returns the area held at AREA when the table exceeds it', () => {
		const out = call(freeModule(alienBlock({ areaKm2: [{ year: START, value: 12 }, { year: END, value: 12 }] })), new Array(N).fill(1));
		expect(Math.max(...out.areaKm2)).toBe(10);
	});

	it('rejects a runoff series that does not span the run', () => {
		expect(() => alienVegetationReduction({ module: freeModule(alienBlock()), parent: null, mode: { kind: 'historical' }, startYear: START, endYear: END, unreducedRunoffMm3: series([1, 2]), rainfallMm: [] })).toThrow(RangeError);
	});
});
