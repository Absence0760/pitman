import { describe, expect, it } from 'vitest';
import type { Monthly12, PitmanParameters, RainfallSeries, RunoffModule } from '../types.js';
import {
	DEFAULT_PITMAN_OPTIONS,
	PitmanRunError,
	evaporationCoefficients,
	evaporationRate,
	potentialEvaporation,
	runRunoffModule,
	simulatePitman,
	subsurfaceFlow,
	surfaceRunoff,
	validatePitmanParameters,
	yearTableValue,
	type PitmanInput,
	type PitmanOptions
} from './pitman.js';

// All fixtures are synthetic: docs/theory/pitman.md §4 (values quoted to 10 decimals).

const params: PitmanParameters = { POW: 2, SL: 0, ST: 200, FT: 10, GW: 3, ZMIN: 0, ZMAX: 500, PI: 1.5, TL: 0.25, GL: 2.5, R: 0.5, FF: 1 };
const sPanMm: Monthly12 = [180, 200, 220, 230, 190, 170, 120, 90, 70, 80, 110, 150];
const panFactors: Monthly12 = [0.8, 1, 1, 1, 1, 1, 1, 1, 1, 0.8, 0.8, 0.8];

/** Assert to the spec's printed 10 decimals. */
function near(actual: number | undefined, expected: number): void {
	expect(actual).toBeCloseTo(expected, 10);
}

function module(overrides: Partial<RunoffModule> = {}): RunoffModule {
	return {
		kind: 'RU',
		number: 1,
		name: 'Synthetic',
		fileVersion: 7,
		fileVersionInFile: true,
		areaKm2: 100,
		mapMm: 600,
		rainfallFile: 'SYN.RAN',
		pitman: params,
		sPanMm,
		panFactors,
		afforestation: { algorithm: 0, algorithmInFile: true, areaKm2: [] },
		outflows: [{ route: 1, percent: 100 }],
		groundwaterModel: 0,
		...overrides
	};
}

function rainfall(startYear: number, years: number[][]): RainfallSeries {
	return { code: 'SYN', rows: years.map((months, i) => ({ year: startYear + i, months: months as unknown as Monthly12 })) };
}

const twelve = (first: number[]) => [...first, ...new Array<number>(12 - first.length).fill(0)];
const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

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

describe('surface runoff (TT 690 eqs. 1.8–1.12)', () => {
	it('matches the spec reference values in all four cases (§2.4)', () => {
		near(surfaceRunoff(100, 0, 500), 2.6666666667); // case 2
		near(surfaceRunoff(250, 0, 500), 41.6666666667); // Zave boundary
		near(surfaceRunoff(300, 0, 500), 71.3333333333); // case 3
		expect(surfaceRunoff(600, 0, 500)).toBe(350); // case 4
		expect(surfaceRunoff(40, 50, 500)).toBe(0); // case 1
	});

	it('eq. 1.10 carries its restored minus: continuous at ZMIN, Zave and ZMAX', () => {
		const [lo, hi] = [40, 360];
		const e = 1e-9;
		expect(surfaceRunoff(lo + e, lo, hi)).toBeCloseTo(0, 12);
		const zave = (lo + hi) / 2;
		expect(surfaceRunoff(zave - e, lo, hi)).toBeCloseTo((hi - lo) / 12, 6);
		expect(surfaceRunoff(zave + e, lo, hi)).toBeCloseTo((hi - lo) / 12, 6);
		expect(surfaceRunoff(hi - e, lo, hi)).toBeCloseTo(hi - zave, 6);
	});

	it('is non-decreasing with 0 ≤ Surf ≤ r', () => {
		let previous = 0;
		for (let r = 0; r <= 800; r += 0.5) {
			const s = surfaceRunoff(r, 30, 420);
			expect(s).toBeGreaterThanOrEqual(previous - 1e-12);
			expect(s).toBeGreaterThanOrEqual(0);
			expect(s).toBeLessThanOrEqual(r);
			previous = s;
		}
	});

	it('OQ-6: ZMIN = ZMAX = 999 gives none; another equal pair gives max(0, r − Z)', () => {
		expect(surfaceRunoff(5000, 999, 999)).toBe(0);
		expect(surfaceRunoff(5000, 1200, 1500)).toBe(0);
		expect(surfaceRunoff(300, 200, 200)).toBe(100);
		expect(surfaceRunoff(100, 200, 200)).toBe(0);
	});
});

describe('subsurface flow and evaporation (TT 690 eqs. 1.13, 1.17–1.19)', () => {
	it('eq. 1.13: Q at S = ST is FT and zero at or below SL', () => {
		expect(subsurfaceFlow(200, params)).toBe(10);
		near(subsurfaceFlow(150, params) / 4, 1.40625);
		expect(subsurfaceFlow(20, { ...params, SL: 20 })).toBe(0);
		expect(subsurfaceFlow(10, { ...params, SL: 20 })).toBe(0);
	});

	it('PE and PEMAX (OQ-13, OQ-14) match spec §4.2', () => {
		const PE = potentialEvaporation(sPanMm, panFactors, 1);
		expect(PE.map((x) => Math.round(x * 1e9) / 1e9)).toEqual([144, 200, 220, 230, 190, 170, 120, 90, 70, 64, 88, 120]);
		expect(potentialEvaporation(sPanMm, panFactors, 1.2)[3]).toBeCloseTo(276, 10);
	});

	it('eqs. 1.18–1.19: b, c match spec §4.2 and satisfy b·ST + c = PE', () => {
		const oct = evaporationCoefficients(144, 230, 200, 0.5);
		near(oct.b, 0.8855614973);
		near(oct.c, -33.1122994652);
		const nov = evaporationCoefficients(200, 230, 200, 0.5);
		near(nov.b, 1.0697674419);
		near(nov.c, -13.9534883721);
		expect(oct.b * 200 + oct.c).toBeCloseTo(144, 10);
		const r0 = evaporationCoefficients(144, 230, 200, 0);
		expect(r0.b).toBeCloseTo(144 / 200, 15);
		expect(r0.c).toBeCloseTo(0, 12);
		expect(evaporationCoefficients(144, 230, 200, 1).b).toBeCloseTo(230 / 200, 12);
		expect(evaporationCoefficients(0, 230, 200, 1)).toEqual({ b: 0, c: 0 });
	});

	it('OQ-11: E is clamped at 0 below S0 = R·ST·(1 − PE/PEMAX)', () => {
		const { b, c } = evaporationCoefficients(144, 230, 200, 0.5);
		const S0 = 0.5 * 200 * (1 - 144 / 230);
		expect(evaporationRate(S0, b, c)).toBeCloseTo(0, 10);
		expect(evaporationRate(S0 - 10, b, c)).toBe(0);
		near(evaporationRate(150, b, c), 99.7219251337);
	});
});

describe('worked example (spec §4)', () => {
	const input: PitmanInput = { params, sPanMm, panFactors, rainfallMm: [90, 30] };
	const { months } = simulatePitman(input, { initialSoilMoisture: 150 });
	const [oct, nov] = months as [NonNullable<(typeof months)[0]>, NonNullable<(typeof months)[1]>];

	it('§4.3 October, step by step', () => {
		const rows = [
			[1.264897186, 0.1694871177, 1.0954100683, 0.0000560814, 1.0953539869, 1.40625, 99.7219251337, 24.8131091886, 0, 124.8759947984, 0.75, 0.6563060814],
			[43.735102814, 5.8601889539, 37.8749138601, 2.3181614332, 35.5567524269, 0.9746258798, 77.4730734685, 16.2154430243, 0, 143.2426783211, 0.75, 2.542787313],
			[43.735102814, 5.8601889539, 37.8749138601, 2.3181614332, 35.5567524269, 1.2824040558, 93.7379012298, 19.6197404925, 0, 157.8972861997, 0.75, 2.850565489],
			[1.264897186, 0.1694871177, 1.0954100683, 0.0000560814, 1.0953539869, 1.5582220618, 106.7154577255, 26.5532609915, 0, 130.8811571333, 0.75, 0.8082781432]
		];
		rows.forEach((row, j) => {
			const s = oct.steps[j]!;
			const [r, i, rn, surf, inf, Q, eRate, E, spill, sEnd, base, fast] = row as [number, number, number, number, number, number, number, number, number, number, number, number];
			near(s.rain, r);
			near(s.interception, i);
			near(s.rain - s.interception, rn);
			near(s.surface, surf);
			near(s.infiltration, inf);
			near(s.Q, Q);
			near(s.evaporationRate, eRate);
			near(s.E, E);
			near(s.spill, spill);
			near(s.sEnd, sEnd);
			near(s.base, base);
			near(s.fast, fast);
		});
		near(oct.interception, 12.0593521432);
		near(oct.surface, 4.6364350292);
		near(oct.Q, 5.2215019974);
		near(oct.E, 87.2015536969);
		near(oct.base, 3);
		near(oct.fast, 6.8579370266);
		near(oct.sEnd, 130.8811571333);
	});

	it('§4.4 November, step by step', () => {
		const rows = [
			[0.0497149305, 0.0086563236, 0.0410586069, 0.000000003, 0.041058604, 1.0706173308, 126.0589122821, 31.5092720369, 98.3423263696, 0.75, 0.3206173337],
			[14.9502850695, 2.6031315666, 12.3471535029, 0.0803136303, 12.2668398726, 0.6044508222, 91.2499305349, 21.6248047606, 88.3799106593, 0.6044508222, 0.0803136303],
			[14.9502850695, 2.6031315666, 12.3471535029, 0.0803136303, 12.2668398726, 0.488188038, 80.5924625658, 19.0991517248, 81.0594107691, 0.488188038, 0.0803136303],
			[0.0497149305, 0.0086563236, 0.0410586069, 0.000000003, 0.041058604, 0.4106642546, 72.7612301251, 18.1871583075, 62.5026468109, 0.4106642546, 0.000000003]
		];
		rows.forEach((row, j) => {
			const s = nov.steps[j]!;
			const [r, i, rn, surf, inf, Q, eRate, E, sEnd, base, fast] = row as [number, number, number, number, number, number, number, number, number, number, number];
			near(s.rain, r);
			near(s.interception, i);
			near(s.rain - s.interception, rn);
			near(s.surface, surf);
			near(s.infiltration, inf);
			near(s.Q, Q);
			near(s.evaporationRate, eRate);
			near(s.E, E);
			expect(s.spill).toBe(0);
			near(s.sEnd, sEnd);
			near(s.base, base);
			near(s.fast, fast);
		});
		near(nov.interception, 5.2235757804);
		near(nov.surface, 0.1606272665);
		near(nov.Q, 2.5739204457);
		near(nov.E, 90.4203868298);
		near(nov.base, 2.2533031149);
		near(nov.fast, 0.4812445973);
		near(nov.sEnd, 62.5026468109);
	});

	it('§4.5 routing and volumes, through runRunoffModule', () => {
		near(oct.routedBase, 0.5);
		near(oct.routedFast, 4.5719580178);
		near(nov.routedBase, 1.2088838525);
		near(nov.routedFast, 3.3688017434);
		near(oct.runoff, 5.0719580178);
		near(nov.runoff, 4.5776855959);

		const result = runRunoffModule(module(), rainfall(2001, [twelve([15, 5])]), {
			startYear: 2001,
			endYear: 2001,
			pitman: { initialSoilMoisture: 150 }
		});
		expect(result.messages).toEqual([]);
		expect(result.outflow.startYear).toBe(2001);
		expect(result.outflow.unit).toBe('Mm3');
		expect(result.outflow.values).toHaveLength(12);
		near(result.outflow.values[0], 0.5071958018);
		near(result.outflow.values[1], 0.4577685596);
		near(result.diagnostics.soilMoistureMm?.values[1], 62.5026468109);
		expect(result.diagnostics.groundwaterOutflow?.values.every((v) => v === 0)).toBe(true);
		expect(result.diagnostics.surfaceRunoff?.values).toEqual(result.outflow.values);
	});

	it('§4.6 wet month with SPILL and case 3', () => {
		const { months: [wet] } = simulatePitman({ params, sPanMm, panFactors, rainfallMm: [240] }, { initialSoilMoisture: 190 });
		const m = wet!;
		const rows = [
			[8.0639460034, 0.0223733774, 2.25625, 33.1458121653, 0, 162.6395104608, 0.75, 1.5286233774],
			[102.5755392332, 40.5566607063, 1.6532256477, 21.0443670537, 1.9607962862, 200, 1.3382388859, 42.8324437544],
			[102.5755392332, 40.5566607063, 2.5, 27.3217252657, 32.1971532612, 200, 10.4091459784, 64.8446679892],
			[8.0639460034, 0.0223733774, 2.5, 35.317759971, 0, 170.223812655, 0.75, 1.7723733774]
		];
		rows.forEach((row, j) => {
			const s = m.steps[j]!;
			const [rn, surf, Q, E, spill, sEnd, base, fast] = row as [number, number, number, number, number, number, number, number];
			near(s.rain - s.interception, rn);
			near(s.surface, surf);
			near(s.Q, Q);
			near(s.E, E);
			near(s.spill, spill);
			near(s.sEnd, sEnd);
			near(s.base, base);
			near(s.fast, fast);
		});
		expect((m.steps[0]!.rain - m.steps[0]!.interception) / 0.25).toBeCloseTo(32.26, 2); // case 2
		expect((m.steps[1]!.rain - m.steps[1]!.interception) / 0.25).toBeCloseTo(410.3, 2); // case 3
		near(m.interception, 18.7210295266);
		near(m.base, 13.2473848642);
		near(m.fast, 110.9781084983);
		near(m.routedBase, 2.2078974774);
		near(m.routedFast, 73.9854056656);
		near(m.runoff, 76.1933031429);
		near((m.runoff * 100) / 1000, 7.6193303143);
		// Printed balance, 4 decimals.
		expect(m.surface).toBeCloseTo(81.1581, 4);
		expect(m.infiltration).toBeCloseTo(140.1209, 4);
		expect(m.sEnd - m.sStart).toBeCloseTo(-19.7762, 4);
		expect(m.Q).toBeCloseTo(8.9095, 4);
		expect(m.E).toBeCloseTo(116.8297, 4);
		// The spec prints 34.1580; its two steps sum to 34.15795 (a last-digit rounding slip in §4.6).
		expect(m.spill).toBeCloseTo(1.9607962862 + 32.1971532612, 9);
		expect(m.spill).toBeCloseTo(34.158, 3);
	});
});

/** Random but valid parameters and a long rain record (mm), with paved months. */
function randomCase(seed: number): PitmanInput {
	const rnd = random(seed);
	const SL = rnd() < 0.5 ? 0 : 40 * rnd();
	const ST = SL + 20 + 400 * rnd();
	const ZMIN = rnd() < 0.2 ? 999 : 100 * rnd();
	const ZMAX = ZMIN === 999 ? 999 : ZMIN + 1200 * rnd();
	const p: PitmanParameters = {
		POW: [1, 2, 3][Math.floor(3 * rnd())]!,
		SL,
		ST,
		FT: 60 * rnd(),
		GW: 20 * rnd(),
		ZMIN,
		ZMAX,
		PI: 10 * rnd(),
		TL: [0, 0.25, 0.5, 1][Math.floor(4 * rnd())]!,
		GL: 5 * rnd(),
		R: rnd(),
		FF: 0.8 + 0.4 * rnd()
	};
	const pan = Array.from({ length: 12 }, () => 30 + 250 * rnd()) as unknown as Monthly12;
	const fac = Array.from({ length: 12 }, () => 0.7 + 0.3 * rnd()) as unknown as Monthly12;
	const n = 12 * 80;
	const rainfallMm = Array.from({ length: n }, () => (rnd() < 0.25 ? 0 : 600 * rnd() ** 3));
	const ai = 0.3 * rnd();
	const imperviousFraction = Array.from({ length: n }, (_, t) => (t < n / 2 ? 0 : ai));
	return { params: p, sPanMm: pan, panFactors: fac, rainfallMm, imperviousFraction };
}

const OPTION_SETS: Partial<PitmanOptions>[] = [
	{},
	{ initialSoilMoisture: 'ST', initialLagState: 'steady', routing: 'perStep' },
	{ sCurveSampling: 'midpointDensity', interceptionSpread: 'equal', stepOrder: 'spillBeforeQ', evaporationAdjustment: 'subtractive' },
	{ initialSoilMoisture: 'zero' }
];

describe('invariants over long random synthetic records', () => {
	for (let seed = 1; seed <= 24; seed++) {
		const opts = OPTION_SETS[seed % OPTION_SETS.length]!;
		it(`seed ${seed}, options ${JSON.stringify(opts)}`, () => {
			const input = randomCase(seed);
			const p = input.params;
			const { months } = simulatePitman(input, opts);
			for (const m of months) {
				const tol = 1e-9 * Math.max(1, m.P, p.ST);
				// rain = interception + paved + surface + ΔS + Q + E + spill
				expect(m.interception + m.paved + m.surface + (m.sEnd - m.sStart) + m.Q + m.E + m.spill).toBeCloseTo(m.P, 8);
				expect(Math.abs(m.base + m.fast - (m.surface + m.Q + m.spill))).toBeLessThan(tol);
				for (const s of m.steps) {
					expect(s.sEnd).toBeGreaterThanOrEqual(0);
					expect(s.sEnd).toBeLessThanOrEqual(p.ST + 1e-9);
					expect(s.E).toBeGreaterThanOrEqual(0);
					expect(s.Q).toBeGreaterThanOrEqual(0);
					expect(s.spill).toBeGreaterThanOrEqual(0);
					expect(s.surface).toBeGreaterThanOrEqual(0);
				}
				if (p.ZMIN === 999 && p.ZMAX === 999) expect(m.surface).toBe(0);
			}
			// Routed volume: the x = 0 Muskingum trapezoidal identity, from zero states (lag.ts).
			if (opts.initialLagState === undefined && opts.routing === undefined) {
				const N = months.length - 1;
				for (const [k, inflow, outflow] of [
					[p.GL, months.map((m) => m.base), months.map((m) => m.routedBase)],
					[p.TL, months.map((m) => m.fast), months.map((m) => m.routedFast)]
				] as const) {
					const expected = sum(inflow) - inflow[N]! / 2 + outflow[N]! / 2 - k * outflow[N]!;
					expect(sum(outflow)).toBeCloseTo(expected, 6);
				}
			}
		});
	}

	it('routed outflow conserves the whole volume once the record drains', () => {
		for (const routing of ['monthly', 'perStep'] as const) {
			const input = randomCase(99);
			const dry = new Array<number>(12 * 400).fill(0);
			const params = { ...input.params, TL: 0.5, GL: 2 };
			const { months } = simulatePitman(
				{ ...input, params, rainfallMm: [...input.rainfallMm, ...dry], imperviousFraction: [...input.imperviousFraction!, ...dry] },
				{ routing }
			);
			const routed = sum(months.map((m) => m.routedBase + m.routedFast));
			const unlagged = sum(months.map((m) => m.base + m.fast));
			expect(routed / unlagged).toBeCloseTo(1, 9);
		}
	});

	it('zero rain gives recession only', () => {
		const input = randomCase(5);
		const { months } = simulatePitman({ ...input, rainfallMm: new Array<number>(240).fill(0) }, { initialSoilMoisture: 'ST' });
		months.forEach((m, t) => {
			expect(m.surface + m.interception + m.paved + m.infiltration).toBe(0);
			expect(m.spill).toBe(0);
			expect(m.sEnd).toBeLessThanOrEqual(m.sStart);
			if (t > 0) expect(m.base + m.fast).toBeLessThanOrEqual(months[t - 1]!.base + months[t - 1]!.fast + 1e-12);
		});
	});

	it('ZMIN = ZMAX = 999 gives no surface runoff even in huge months', () => {
		const input = randomCase(3);
		const { months } = simulatePitman({ ...input, params: { ...input.params, ZMIN: 999, ZMAX: 999 }, rainfallMm: input.rainfallMm.map((r) => r * 10) });
		expect(months.every((m) => m.surface === 0)).toBe(true);
	});

	it('OQ-25 float32 keeps S in single precision and stays close to float64', () => {
		const input = randomCase(11);
		const f64 = simulatePitman(input).months;
		const f32 = simulatePitman(input, { precision: 'float32' }).months;
		f32.forEach((m, t) => {
			expect(Math.fround(m.sEnd)).toBe(m.sEnd);
			expect(Math.abs(m.runoff - f64[t]!.runoff)).toBeLessThan(1e-3 * Math.max(1, f64[t]!.runoff));
		});
	});

	it('OQ-9 cuts E then Q when S would go negative', () => {
		const harsh: PitmanParameters = { ...params, SL: 0, ST: 10, FT: 400, POW: 1, R: 0 };
		const sim = simulatePitman({ params: harsh, sPanMm, panFactors, rainfallMm: [0, 0, 0] }, { initialSoilMoisture: 10 });
		expect(sim.negativeSoilMoistureSteps).toBeGreaterThan(0);
		for (const m of sim.months) for (const s of m.steps) expect(s.sEnd).toBeGreaterThanOrEqual(0);
	});
});

describe('defaults and options', () => {
	it('the defaults are the accepted provisional ones', () => {
		expect(DEFAULT_PITMAN_OPTIONS).toEqual({
			initialSoilMoisture: 'halfST',
			initialLagState: 'zero',
			sCurveSampling: 'cumulative',
			interceptionSpread: 'proportional',
			stepOrder: 'explicit',
			evaporationAdjustment: 'proportional',
			routing: 'monthly',
			precision: 'float64'
		});
		expect(simulatePitman({ params, sPanMm, panFactors, rainfallMm: [0] }).months[0]!.sStart).toBe(100);
	});

	it('steady lag start puts the first month out at its inflow (OQ-24 (b))', () => {
		const m = simulatePitman({ params, sPanMm, panFactors, rainfallMm: [90] }, { initialSoilMoisture: 150, initialLagState: 'steady' }).months[0]!;
		near(m.routedBase, m.base);
		near(m.routedFast, m.fast);
	});
});

describe('paved areas (OQ-17 … OQ-19)', () => {
	it('year table: linear between years, flat outside', () => {
		const table = [{ year: 2000, value: 0.1 }, { year: 2010, value: 0.3 }];
		expect(yearTableValue(table, 1990)).toBe(0.1);
		expect(yearTableValue(table, 2005)).toBeCloseTo(0.2, 15);
		expect(yearTableValue(table, 2020)).toBe(0.3);
		expect(yearTableValue([], 2020)).toBe(0);
	});

	it('paved runoff is AI·P, unlagged, and reported separately', () => {
		const paved = { fraction: [{ year: 2001, value: 0.1 }, { year: 2003, value: 0.3 }] };
		const result = runRunoffModule(module({ paved }), rainfall(2001, [twelve([15]), twelve([15]), twelve([15])]), { startYear: 2001, endYear: 2003 });
		const pavedMm3 = result.diagnostics.pavedFlow!.values;
		near(pavedMm3[0], (0.1 * 90 * 100) / 1000);
		near(pavedMm3[12], (0.2 * 90 * 100) / 1000);
		near(pavedMm3[24], (0.3 * 90 * 100) / 1000);
		expect(pavedMm3[1]).toBe(0);
		expect(result.outflow.values[0]).toBeGreaterThan(pavedMm3[0]!);
	});

	it('paved area lowers soil moisture (TT 689 p.142)', () => {
		const ran = rainfall(2001, [twelve([15, 10, 10])]);
		const without = runRunoffModule(module(), ran, { startYear: 2001, endYear: 2001 });
		const withPaved = runRunoffModule(module({ paved: { fraction: [{ year: 2001, value: 0.2 }] } }), ran, { startYear: 2001, endYear: 2001 });
		expect(withPaved.diagnostics.soilMoistureMm!.values[2]).toBeLessThan(without.diagnostics.soilMoistureMm!.values[2]!);
	});
});

describe('runRunoffModule guards', () => {
	const ran = rainfall(2001, [twelve([15, 5])]);
	const period = { startYear: 2001, endYear: 2001 };

	it('throws for Hughes, and for Sami without its parameters', () => {
		for (const [gw, text] of [
			[1, /groundwater model 1 \(Hughes\) is not supported yet/],
			[2, /groundwater model 2 \(Sami\) but no Sami parameters/]
		] as const) {
			const run = () => runRunoffModule(module({ groundwaterModel: gw }), ran, period);
			expect(run).toThrow(PitmanRunError);
			expect(run).toThrow(text);
			try {
				run();
			} catch (e) {
				expect((e as PitmanRunError).messages[0]).toMatchObject({ level: 'error', module: { type: 'RU', number: 1 } });
			}
		}
	});

	it('passes land use to the wired reductions and leaves SFR children to the network runner', () => {
		const base = runRunoffModule(module(), ran, period);
		const land = runRunoffModule(
			module({
				afforestation: { algorithm: 1, algorithmInFile: true, areaKm2: [{ year: 2000, value: 5 }] },
				alienVegetation: { algorithm: 1, riparianArea: 0, areaKm2: [{ year: 2000, value: 2 }] },
				sfrChildren: [7]
			}),
			ran,
			period
		);
		const texts = land.messages.map((m) => m.text);
		expect(land.messages.every((m) => m.level === 'warning')).toBe(true);
		expect(texts).toEqual([
			expect.stringMatching(/SFR children are run with their parent by the network runner/),
			expect.stringMatching(/CSIR afforestation in a free module is not modelled.*R6-F3/),
			expect.stringMatching(/alien vegetation not modelled yet/)
		]);
		expect(land.outflow.values).toEqual(base.outflow.values);
	});

	it('rejects invalid parameters, missing years and negative rain', () => {
		expect(() => runRunoffModule(module({ pitman: { ...params, ST: 0 } }), ran, period)).toThrow(/ST = 0 must exceed SL/);
		expect(() => runRunoffModule(module({ pitman: { ...params, R: 1.5 } }), ran, period)).toThrow(/OQ-15/);
		expect(() => runRunoffModule(module({ pitman: { ...params, ZMIN: 600, ZMAX: 500 } }), ran, period)).toThrow(/OQ-6/);
		expect(() => runRunoffModule(module(), ran, { startYear: 2001, endYear: 2002 })).toThrow(/no year 2002/);
		expect(() => runRunoffModule(module(), rainfall(2001, [twelve([-1])]), period)).toThrow(/% MAP/);
	});

	it('warns for PI > 10 and POW outside 1–3 without rejecting', () => {
		const v = validatePitmanParameters({ ...params, PI: 12, POW: 2.5 });
		expect(v.map((x) => x.level)).toEqual(['warning', 'warning']);
		const result = runRunoffModule(module({ pitman: { ...params, PI: 12, POW: 2.5 } }), ran, period);
		expect(result.messages.filter((m) => m.level === 'warning')).toHaveLength(2);
	});
});
