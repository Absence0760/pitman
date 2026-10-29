import { describe, expect, it } from 'vitest';
import { routeSeries } from '../../runoff/lag.js';
import { simulatePitman, type PitmanInput } from '../../runoff/pitman.js';
import type { Monthly12, PitmanParameters } from '../../types.js';
import type { SamiAquiferParams, SamiSoilParams } from './contract.js';
import { fakeSamiParts } from './fake-parts.js';
import {
	DEFAULT_SAMI_OPTIONS,
	resolveSamiOptions,
	samiDiagnostics,
	samiWaterBalance,
	simulateSami,
		type SamiInput,
	type SamiOptionsInput
} from './index.js';
import { makeSamiAquiferStep, samiAquiferInit, samiAquiferStep } from './aquifer.js';
import { samiInterflow, samiSoilPass } from './soil.js';

// Synthetic fixtures only (issue #3 rule 2).

const twelve = (f: (m: number) => number) => Array.from({ length: 12 }, (_, m) => f(m)) as unknown as Monthly12;

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

const pitmanParams: PitmanParameters = { POW: 2, SL: 20, ST: 250, FT: 12, GW: 3, ZMIN: 10, ZMAX: 600, PI: 1.5, TL: 0.5, GL: 2, R: 0.5, FF: 1 };

function rain(years: number, seed = 7): number[] {
	const r = random(seed);
	return Array.from({ length: 12 * years }, (_, i) => {
		const m = i % 12;
		const wet = m >= 1 && m <= 6 ? 1 : 0.25;
		return r() < 0.15 ? 0 : wet * 160 * r();
	});
}

const soil: SamiSoilParams = { POW: 2, SL: 20, ST: 250, FT: 12, HGSL: 30, HGGW: 3, GPOW: 2, PPOW: 0.2, P0: 5, PMAX: 10, MMA: 2, lag: 0 };
const aquifer: SamiAquiferParams = {
	thicknessM: 20,
	storativity: 0.005,
	store0: 70,
	SWL: 60,
	BFMAX: 2,
	BPOW: -0.05,
	HGRAD: 0.001,
	T_m2d: 10,
	evapAreaKm2: 1,
	k2: 0.1,
	k3: -3,
	distM: 1000,
	GWMAX: 100,
	outflowWidthFactor: 4,
	daysPerMonth: 30,
	areaKm2: 100
};

function input(overrides: Partial<SamiInput> = {}, years = 4): SamiInput {
	const rainfallMm = rain(years);
	const pitman: PitmanInput = {
		params: pitmanParams,
		sPanMm: twelve((m) => 120 + 15 * m),
		panFactors: twelve(() => 0.9),
		rainfallMm,
		imperviousFraction: rainfallMm.map(() => 0.02)
	};
	return { pitman, soil, aquifer, petGwMm: twelve((m) => 100 + 5 * m), abstractionMm: rainfallMm.map((_, i) => (i >= 24 ? 0.3 : 0)), ...overrides };
}

const VARIANTS: SamiOptionsInput[] = [
	{},
	{ finalRunoff: 'totalPlusBaseflow' },
	{ headRunoff: 'surface' },
	{ pitmanParts: 'unlagged' },
	{ finalRunoff: 'totalPlusBaseflow', headRunoff: 'surface', pitmanParts: 'unlagged' },
	{ soilFeedback: 'rechargeDrainsS' },
	{ soilMoisture: 'stepMean' }
];

describe('simulateSami: order of operations (sami.md §4)', () => {
	it('calls soilPass, aquiferInit, aquiferStep month by month, then interflow', () => {
		const parts = fakeSamiParts();
		const inp = input({}, 2);
		simulateSami(inp, parts);
		expect(parts.calls).toEqual(['soilPass', 'aquiferInit', ...new Array<string>(24).fill('aquiferStep'), 'interflow']);
	});

	it('feeds the soil pass S, the aquifer PERC + EXRECH, the Pitman Q, rain, PET and ABS, and the interflow the aquifer excess', () => {
		const base = fakeSamiParts();
		const seen: { S?: readonly number[]; steps: unknown[]; aqx?: readonly number[]; lag?: number } = { steps: [] };
		const parts = {
			...base,
			soilPass: (S: readonly number[], p: SamiSoilParams) => ((seen.S = S), base.soilPass(S, p)),
			aquiferStep: ((s, i, p) => (seen.steps.push(i), base.aquiferStep(s, i, p))) as typeof base.aquiferStep,
			interflow: (sif: readonly number[], aqx: readonly number[], lag: number) => ((seen.aqx = aqx), (seen.lag = lag), base.interflow(sif, aqx, lag))
		};
		const inp = input({ soil: { ...soil, lag: 1.5, PMAX: 1 }, aquifer: { ...aquifer, store0: 99.9 } });
		const sim = simulateSami(inp, parts);
		expect(seen.S).toEqual(sim.pitman.months.map((m) => m.sEnd)); // OQ-S4 monthEnd
		expect(seen.lag).toBe(1.5);
		sim.months.forEach((m, i) => {
			expect(seen.steps[i]).toEqual({
				aquiferInflow: sim.soil.perc[i]! + sim.soil.exrech[i]!,
				perc: sim.soil.perc[i],
				percBar: sim.soil.percBar,
				runoffForHead: sim.pitman.months[i]!.runoff, // OQ-S3 (i), lagged
				rain: inp.pitman.rainfallMm[i],
				petGw: inp.petGwMm[i % 12],
				abstraction: inp.abstractionMm![i]
			});
		});
		expect(seen.aqx).toEqual(sim.months.map((m) => m.aquifer.excessToInterflow));
		expect(seen.aqx!.some((x) => x > 0)).toBe(true); // the aquifer filled at least once, so the path is exercised
	});

	it('runs the Pitman core with GW = GL = 0 (TT 691 p.123 §11.2)', () => {
		const inp = input();
		const sim = simulateSami(inp, fakeSamiParts());
		const expected = simulatePitman({ ...inp.pitman, params: { ...pitmanParams, GW: 0, GL: 0 } });
		expect(sim.pitman.months.map((m) => m.runoff)).toEqual(expected.months.map((m) => m.runoff));
		expect(sim.pitman.months.every((m) => m.base === 0 && m.routedBase === 0)).toBe(true);
	});

	it('takes S as the mean of the four sub-step values under OQ-S4 stepMean', () => {
		const sim = simulateSami(input(), fakeSamiParts(), { soilMoisture: 'stepMean' });
		const m5 = sim.pitman.months[5]!;
		expect(sim.months[5]!.S).toBeCloseTo(m5.steps.reduce((a, s) => a + s.sEnd, 0) / 4, 12);
	});

	it('drains S by the recharge curve under OQ-S2 (b), and not under (a)', () => {
		const a = simulateSami(input(), fakeSamiParts());
		const b = simulateSami(input(), fakeSamiParts(), { soilFeedback: 'rechargeDrainsS' });
		expect(a.pitman.months.every((m) => m.drain === 0)).toBe(true);
		const drained = b.pitman.months.reduce((t, m) => t + m.drain, 0);
		expect(drained).toBeGreaterThan(0);
		expect(b.pitman.months.reduce((t, m) => t + m.sEnd, 0)).toBeLessThan(a.pitman.months.reduce((t, m) => t + m.sEnd, 0));
	});
});

describe('simulateSami: Qfinal per OQ-S3', () => {
	const inp = input();

	it('(a) default: Pitman surface (FT term excluded) + QLAG + net baseflow − TL', () => {
		const sim = simulateSami(inp, fakeSamiParts());
		sim.months.forEach((m, i) => {
			const pm = sim.pitman.months[i]!;
			expect(m.pitmanTotal).toBe(pm.runoff);
			expect(m.surface).toBeCloseTo(pm.runoff - pm.routedFastSubsurface, 12);
			expect(m.runoff).toBeCloseTo(m.surface + m.interflow + m.aquifer.baseflow - m.aquifer.transmissionLoss, 12);
		});
		// The TL branch is exercised somewhere in the fixture.
		expect(sim.months.some((m) => m.aquifer.transmissionLoss > 0)).toBe(true);
		expect(sim.months.some((m) => m.aquifer.baseflow > 0)).toBe(true);
	});

	it('(b): Pitman total Q + net baseflow − TL, interflow unused', () => {
		const sim = simulateSami(inp, fakeSamiParts(), { finalRunoff: 'totalPlusBaseflow' });
		sim.months.forEach((m) => expect(m.runoff).toBeCloseTo(m.pitmanTotal + m.aquifer.baseflow - m.aquifer.transmissionLoss, 12));
	});

	it('HEAD (ii) hands the aquifer the surface part instead of the total', () => {
		const sim = simulateSami(inp, fakeSamiParts(), { headRunoff: 'surface' });
		sim.months.forEach((m) => expect(m.aquiferInput.runoffForHead).toBe(m.surface));
	});

	it('unlagged parts use the monthly totals before the TL lag (paved never lagged)', () => {
		const sim = simulateSami(inp, fakeSamiParts(), { pitmanParts: 'unlagged' });
		sim.months.forEach((m, i) => {
			const pm = sim.pitman.months[i]!;
			expect(m.pitmanTotal).toBe(pm.paved + pm.base + pm.fast);
			expect(m.surface).toBeCloseTo(pm.paved + pm.fast - pm.fastSubsurface, 12);
		});
	});

	it('records the options it used', () => {
		expect(simulateSami(inp, fakeSamiParts()).options).toEqual(DEFAULT_SAMI_OPTIONS);
		expect(resolveSamiOptions({ soil: { rechargeThreshold: 'SL' } }).soil).toEqual({ ...DEFAULT_SAMI_OPTIONS.soil, rechargeThreshold: 'SL' });
	});
});

describe('simulateSami: water balance of the composed module', () => {
	it.each(VARIANTS.map((v) => [JSON.stringify(v), v] as const))('closes with conserving parts: %s', (_name, v) => {
		for (const lag of [0, 2]) {
			const inp = input({ soil: { ...soil, lag, PMAX: 2 }, aquifer: { ...aquifer, store0: 99.9 } }, 6);
			const sim = simulateSami(inp, fakeSamiParts(), v);
			const b = samiWaterBalance(sim, inp);
			expect(Math.abs(b.residual)).toBeLessThan(1e-9 * b.rain);
			expect(b.rain).toBeGreaterThan(0);
			expect(b.abstraction).toBeCloseTo(0.3 * 48, 9);
			if (v.soilFeedback === 'rechargeDrainsS') expect(b.soilDrain).toBeGreaterThan(0);
		}
	});

	it('closes with the real soil side and a conserving aquifer', () => {
		const fake = fakeSamiParts();
		const parts = { ...fake, soilPass: samiSoilPass, interflow: samiInterflow };
		const inp = input({ soil: { ...soil, lag: 1 } }, 6);
		const sim = simulateSami(inp, parts);
		const b = samiWaterBalance(sim, inp);
		expect(Math.abs(b.residual)).toBeLessThan(1e-9 * b.rain);
		expect(b.recharge).toBeGreaterThan(0);
	});

	it('detects a part that loses water', () => {
		const fake = fakeSamiParts();
		const leaky = { ...fake, aquiferStep: ((s, i, p) => {
			const r = fake.aquiferStep(s, i, p);
			return { ...r, out: { ...r.out, baseflow: r.out.baseflow * 0.5 } };
		}) as typeof fake.aquiferStep };
		const inp = input();
		const b = samiWaterBalance(simulateSami(inp, leaky), inp);
		expect(Math.abs(b.residual)).toBeGreaterThan(1e-3);
	});
});

describe('simulateSami: contract checks and diagnostics', () => {
	it('rejects a part that returns the wrong number of months', () => {
		const fake = fakeSamiParts();
		expect(() => simulateSami(input(), { ...fake, interflow: () => [1, 2] })).toThrow(/interflow returned 2 months; the run has 48/);
	});

	it('reports the §3.12 series, flows in million m³ and storages in mm', () => {
		const sim = simulateSami(input(), fakeSamiParts());
		const d = samiDiagnostics(sim, 100, 2001);
		const m = sim.months[10]!;
		expect(d.netRunoff!.values[10]).toBeCloseTo((m.runoff * 100) / 1000, 12);
		expect(d.groundwaterOutflow!.values[10]).toBeCloseTo(((m.aquifer.baseflow + m.interflow) * 100) / 1000, 12);
		expect(d.interflow!.values[10]).toBeCloseTo((m.interflow * 100) / 1000, 12);
		expect(d.aquiferStorageMm).toMatchObject({ startYear: 2001, unit: 'mm' });
		expect(d.aquiferStorageMm!.values[10]).toBe(m.aquifer.store);
		expect(d.rechargeMm!.values[10]).toBe(m.aquifer.aquiferRecharge);
		expect(d.soilMoistureMm!.values[10]).toBe(m.S);
	});
});

describe('simulatePitman: the FT part exposed for Sami', () => {
	it('routes the FT part alone, so routedFast − routedFastSubsurface is the lagged surface part', () => {
		const inp = input().pitman;
		for (const routing of ['monthly', 'perStep'] as const) {
			const sim = simulatePitman({ ...inp, params: { ...pitmanParams, GW: 0, GL: 0 } }, { routing });
			if (routing === 'monthly') {
				const surface = routeSeries(sim.months.map((m) => m.fast - m.fastSubsurface), { k: pitmanParams.TL, dt: 1 });
				sim.months.forEach((m, i) => expect(m.routedFast - m.routedFastSubsurface).toBeCloseTo(surface[i]!, 10));
			}
			sim.months.forEach((m) => expect(m.fastSubsurface).toBeCloseTo(m.Q, 12)); // GW = 0: all of Q is in F
		}
	});
});

describe('simulateSami with the real soil and aquifer sides', () => {
	const real = { soilPass: samiSoilPass, interflow: samiInterflow, aquiferInit: samiAquiferInit, aquiferStep: samiAquiferStep, makeAquiferStep: makeSamiAquiferStep };

	it.each(VARIANTS.map((v) => [JSON.stringify(v), v] as const))('closes the composed balance: %s', (_name, v) => {
		const inp = input({ soil: { ...soil, lag: 1 } }, 6);
		const sim = simulateSami(inp, real, v);
		const b = samiWaterBalance(sim, inp);
		expect(Math.abs(b.residual)).toBeLessThan(1e-9 * b.rain);
		expect(b.recharge).toBeGreaterThan(0);
	});

	it('builds the aquifer step from SamiOptions.aquifer through makeAquiferStep', () => {
		const seen: unknown[] = [];
		const parts = { ...real, makeAquiferStep: (o: Parameters<typeof makeSamiAquiferStep>[0]) => (seen.push(o), makeSamiAquiferStep(o)) };
		simulateSami(input(), parts, { aquifer: { pumpingClock: 'resetWhenIdle' } });
		expect(seen).toEqual([{ ...DEFAULT_SAMI_OPTIONS.aquifer, pumpingClock: 'resetWhenIdle' }]);
	});
});

describe('simulateSami: negative Qfinal (R6-R3)', () => {
	const fake = fakeSamiParts();
	const thirsty = {
		...fake,
		aquiferStep: ((s, i, p) => {
			const r = fake.aquiferStep(s, i, p);
			return { ...r, out: { ...r.out, transmissionLoss: r.out.transmissionLoss + 40 } };
		}) as typeof fake.aquiferStep
	};

	it('keeps it by default and counts the months', () => {
		const sim = simulateSami(input(), thirsty);
		expect(sim.negativeRunoffMonths).toBeGreaterThan(0);
		expect(sim.months.filter((m) => m.runoff < 0)).toHaveLength(sim.negativeRunoffMonths);
		expect(sim.months.every((m) => m.clampedMm === 0)).toBe(true);
	});

	it('raises it to 0 under clamp and books the water in the balance', () => {
		const inp = input();
		const kept = simulateSami(inp, thirsty);
		const sim = simulateSami(inp, thirsty, { negativeRunoff: 'clamp' });
		expect(sim.negativeRunoffMonths).toBe(kept.negativeRunoffMonths);
		expect(sim.months.every((m) => m.runoff >= 0)).toBe(true);
		sim.months.forEach((m, i) => expect(m.runoff - m.clampedMm).toBeCloseTo(kept.months[i]!.runoff, 12));
		const b = samiWaterBalance(sim, inp);
		expect(b.clamped).toBeGreaterThan(0);
		// The thirsty fake doesn't conserve, but clamping must not change the residual: the added water is booked.
		expect(b.residual).toBeCloseTo(samiWaterBalance(kept, inp).residual, 9);
	});
});
