import { describe, expect, it } from 'vitest';
import type { RunoffModule, SamiParameters } from '../../types.js';
import type { SamiSoilParams } from './contract.js';
import {
	DEFAULT_SAMI_SOIL_OPTIONS,
	samiInterflow,
	samiInterflowRouter,
	samiMovingAverage,
	samiPercolation,
	samiRecharge,
	samiSoilInterflow,
	samiSoilParams,
	samiSoilPass
} from './soil.js';

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

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

function expectSeries(actual: readonly number[], expected: readonly number[], tolerance: number): void {
	expect(actual).toHaveLength(expected.length);
	actual.forEach((value, i) => {
		if (Math.abs(value - expected[i]!) > tolerance) {
			throw new Error(`month ${i + 1}: ${value} differs from ${expected[i]} by more than ${tolerance}`);
		}
	});
}

/** docs/theory/sami.md §7: TT 690 Fig 8.13 (B82B) parameters, HGSL = SL and PPOW assumed. */
const B82B: SamiSoilParams = {
	POW: 3,
	SL: 180,
	ST: 800,
	FT: 4.2,
	HGSL: 180,
	HGGW: 4.5,
	GPOW: 1,
	PPOW: 0.2,
	P0: 5,
	PMAX: 9,
	MMA: 2,
	lag: 0
};
const B82B_S = [520, 610, 690, 640, 420, 380];
/** "Est Recharge 19.34 mm/a" (TT 690 Fig 8.13) / 12. */
const B82B_REBAR = 19.337 / 12;

describe('Sami soil equations, by hand', () => {
	const p: SamiSoilParams = { ...B82B, POW: 2, SL: 100, ST: 500, FT: 5, HGSL: 50, HGGW: 2, GPOW: 3 };

	it('§3.1 eq. 8.2 / TT 687 eq. 1: SIF = FT·((S − SL)/(ST − SL))^POW', () => {
		expect(samiSoilInterflow(300, p)).toBeCloseTo(1.25, 12); // 5·(200/400)²
		expect(samiSoilInterflow(500, p)).toBeCloseTo(5, 12); // S = ST ⇒ FT
		expect(samiSoilInterflow(100, p)).toBe(0); // S = SL ⇒ 0
		expect(samiSoilInterflow(40, p)).toBe(0);
		expect(samiSoilInterflow(650, p)).toBeCloseTo(5, 12); // ratio clamped at 1
	});

	it('§3.2 TT 687 eq. 2: RE = HGGW·((S − HGSL)/(ST − HGSL))^GPOW, threshold HGSL (OQ-S5)', () => {
		expect(samiRecharge(300, p)).toBeCloseTo(2 * (125 / 729), 12); // 2·(250/450)³
		expect(samiRecharge(500, p)).toBeCloseTo(2, 12);
		expect(samiRecharge(50, p)).toBe(0);
		expect(samiRecharge(75, p)).toBeGreaterThan(0); // above HGSL, below SL
		expect(samiSoilInterflow(75, p)).toBe(0);
	});

	it('§3.2 OQ-S5 option SL: TT 690 eq. 8.3 as printed', () => {
		expect(samiRecharge(300, p, { rechargeThreshold: 'SL' })).toBeCloseTo(0.25, 12); // 2·(200/400)³
		expect(samiRecharge(75, p, { rechargeThreshold: 'SL' })).toBe(0);
	});

	it('degenerate curve (threshold ≥ ST) gives the maximum above the threshold, 0 below', () => {
		const flat = { ...p, SL: 500, HGSL: 500 };
		expect(samiSoilInterflow(500, flat)).toBe(0);
		expect(samiSoilInterflow(501, flat)).toBe(5);
		expect(samiRecharge(501, flat)).toBe(2);
	});

	it('§3.4 REx: trailing mean, the months available at the start (OQ-S6)', () => {
		expect(samiMovingAverage([1, 2, 3, 4], 3)).toEqual([1, 1.5, 2, 3]);
		expect(samiMovingAverage([1, 2, 3, 4], 1)).toEqual([1, 2, 3, 4]);
		expect(samiMovingAverage([1, 2], 5)).toEqual([1, 1.5]);
	});

	it('§3.4 OQ-S6 option zeroPadded: months before the run count as 0', () => {
		expectSeries(samiMovingAverage([1, 2, 3, 4], 3, 'zeroPadded'), [1 / 3, 1, 2, 3], 1e-15);
	});

	it('§3.4 MMA must be an integer ≥ 1', () => {
		expect(() => samiMovingAverage([1], 0)).toThrow(RangeError);
		expect(() => samiMovingAverage([1], 1.5)).toThrow(RangeError);
	});

	it('§3.5 EXRECH: the store above PMAX is dumped, then PERC is capped at P', () => {
		// P = 1 + 3 = 4 > PMAX 2 ⇒ EXRECH 2, P 2; PERC = 3·(2/2)^0.5·(3/3) = 3 > P ⇒ 2.
		const r = samiPercolation([3], 3, { PMAX: 2, P0: 1, PPOW: 0.5, MMA: 1 });
		expect(r.exrech).toEqual([2]);
		expect(r.perc).toEqual([2]);
		expect(r.p).toEqual([0]);
	});

	it('§3.5 eq. 8.5: PERC = REx·(P/PMAX)^PPOW·(REx/REbar), with P after RE (OQ-S8)', () => {
		// P = 2 + 1 = 3, REx = 1, PERC = 1·(3/12)^0.5·(1/0.5) = 1.
		const r = samiPercolation([1], 0.5, { PMAX: 12, P0: 2, PPOW: 0.5, MMA: 1 });
		expect(r.exrech).toEqual([0]);
		expect(r.perc[0]).toBeCloseTo(1, 15);
		expect(r.p[0]).toBeCloseTo(2, 15);
	});

	it('§3.5 OQ-S8 option previous: eq. 8.5 uses P at the end of the previous month', () => {
		// §7 month 1 with P = P₀ = 5: 2.46774·(5/9)^0.2·(2.46774/1.61142) = 3.3600.
		const re = [samiRecharge(520, B82B)];
		const r = samiPercolation(re, B82B_REBAR, B82B, { ...DEFAULT_SAMI_SOIL_OPTIONS, percolationStorage: 'previous' });
		expect(r.perc[0]).toBeCloseTo(3.36, 4);
	});

	it('§3.5 REbar = 0 ⇒ PERC = 0; PMAX = 0 ⇒ every RE leaves as EXRECH (R6-S1)', () => {
		expect(samiPercolation([0, 0], 0, { PMAX: 5, P0: 1, PPOW: 0.2, MMA: 2 }).perc).toEqual([0, 0]);
		const r = samiPercolation([1, 2], 1.5, { PMAX: 0, P0: 0, PPOW: 0.2, MMA: 2 });
		expect(r.exrech).toEqual([1, 2]);
		expect(r.perc).toEqual([0, 0]);
		expect(r.p).toEqual([0, 0]);
	});

	it('§3.5 a P₀ above PMAX leaves as EXRECH in month 1', () => {
		const r = samiPercolation([0], 1, { PMAX: 4, P0: 6, PPOW: 0.2, MMA: 1 });
		expect(r.exrech).toEqual([2]);
		expect(r.p[0]).toBe(4);
	});

	it('rejects a negative PMAX or P₀ and a non-finite S (R2-2)', () => {
		expect(() => samiPercolation([1], 1, { PMAX: -1, P0: 0, PPOW: 0.2, MMA: 1 })).toThrow(RangeError);
		expect(() => samiPercolation([1], 1, { PMAX: 1, P0: -1, PPOW: 0.2, MMA: 1 })).toThrow(RangeError);
		expect(() => samiSoilPass([500, Number.NaN], B82B)).toThrow(/month 1/);
		expect(() => samiSoilPass([500], { ...B82B, MMA: 0 })).toThrow(RangeError);
	});

	it('§3.3 REbar and PERCbar are whole-run means (TT 691 p.51, OQ-S6, OQ-S13)', () => {
		const r = samiSoilPass(B82B_S, B82B);
		expect(r.reBar).toBeCloseTo(sum(r.re) / 6, 15);
		expect(r.percBar).toBeCloseTo(sum(r.perc) / 6, 15);
		const empty = samiSoilPass([], B82B);
		expect(empty).toMatchObject({ reBar: 0, percBar: 0, re: [], perc: [] });
	});

	it('§3.7 lag k = 1, steady start (OQ-S17): QLAG₀ = INTERFLOW₀, then eq. 1.14', () => {
		// C1 = 2/3, C2 = 1/3: Q1 = 2 + (2/3)(2 − 2) + (1/3)(4 − 2).
		expectSeries(samiInterflow([1, 3], [1, 1], 1), [2, 2 + 2 / 3], 1e-15);
	});

	it('§3.7 OQ-S17 option zero: a dry start', () => {
		// Q0 = (1/3)·2; Q1 = Q0 + (2/3)(2 − Q0) + (1/3)(4 − 2).
		const q0 = 2 / 3;
		expectSeries(samiInterflow([1, 3], [1, 1], 1, { initialLagState: 'zero' }), [q0, q0 + (2 / 3) * (2 - q0) + 2 / 3], 1e-15);
	});

	it.each(['steady', 'zero'] as const)('R6-A10: the month-by-month router gives samiInterflow exactly; peek does not move it (%s start)', (initialLagState) => {
		const r = random(11);
		const sif = Array.from({ length: 40 }, () => 3 * r());
		const aqx = sif.map(() => (r() < 0.3 ? 2 * r() : 0));
		for (const lag of [0, 0.3, 1, 2.5]) {
			const whole = samiInterflow(sif, aqx, lag, { initialLagState });
			const router = samiInterflowRouter(lag, { initialLagState });
			sif.forEach((v, i) => {
				router.peek(v, aqx[i]! + 7); // a trial AQX, discarded
				expect(router.peek(v, aqx[i]!)).toBe(whole[i]);
				expect(router.push(v, aqx[i]!)).toBe(whole[i]);
			});
		}
	});

	it('§3.7 k = 0 passes INTERFLOW = SIF + AQX through; mismatched lengths throw', () => {
		expect(samiInterflow([0.5, 1], [0, 2], 0)).toEqual([0.5, 3]);
		expect(samiInterflow([], [], 2)).toEqual([]);
		expect(() => samiInterflow([1], [], 0)).toThrow(RangeError);
		expect(() => samiInterflow([1], [0], -1)).toThrow(RangeError);
	});
});

describe('§7 worked example (B82B parameters, invented S)', () => {
	const re = B82B_S.map((S) => samiRecharge(S, B82B));
	const pass = samiPercolation(re, B82B_REBAR, B82B);
	const sif = B82B_S.map((S) => samiSoilInterflow(S, B82B));

	it('RE and SIF columns', () => {
		expectSeries(re, [2.4677, 3.121, 3.7016, 3.3387, 1.7419, 1.4516], 5e-5);
		expectSeries(sif, [0.6926, 1.4011, 2.3377, 1.7153, 0.2436, 0.141], 5e-5);
	});

	it('REx, EXRECH, PERC and P columns (REbar = 19.337/12)', () => {
		expectSeries(pass.reX, [2.4677, 2.7944, 3.4113, 3.5202, 2.5403, 1.5968], 5e-5);
		expectSeries(pass.exrech, [0, 0, 0, 0, 0, 0], 0);
		expectSeries(pass.perc, [3.6407, 4.6013, 6.0484, 3.3387, 1.7419, 1.0985], 5e-5);
		expectSeries(pass.p, [3.8271, 2.3468, 0, 0, 0, 0.3531], 5e-5);
	});

	it('interflow with the aquifer table\'s AQX, LAG = 0', () => {
		const aqx = [0, 0, 0, 2.969, 0, 0];
		expectSeries(samiInterflow(sif, aqx, 0), [0.6926, 1.4011, 2.3377, 4.6844, 0.2436, 0.141], 1e-4);
	});

	it('samiSoilPass uses the run\'s own REbar', () => {
		const r = samiSoilPass(B82B_S, B82B);
		expectSeries(r.re, re, 0);
		expectSeries(r.soilInterflow, sif, 0);
		expect(r.reBar).toBeCloseTo(sum(re) / 6, 12);
		// A larger REbar than the published one ⇒ less percolation in month 1.
		expect(r.perc[0]!).toBeLessThan(pass.perc[0]!);
	});
});

describe('Sami soil invariants over random synthetic S (§5)', () => {
	const cases = Array.from({ length: 40 }, (_, c) => {
		const u = random(1000 + c);
		const ST = 100 + 900 * u();
		const params: SamiSoilParams = {
			POW: 0.5 + 3 * u(),
			SL: ST * 0.3 * u(),
			ST,
			FT: 20 * u(),
			HGSL: ST * 0.3 * u(),
			HGGW: 10 * u(),
			GPOW: 0.5 + 3 * u(),
			PPOW: 0.05 + 0.9 * u(),
			P0: 0,
			PMAX: c % 7 === 0 ? 0 : 1 + 60 * u(),
			MMA: 1 + Math.floor(24 * u()),
			lag: c % 3 === 0 ? 0 : 6 * u()
		};
		const withP0 = { ...params, P0: params.PMAX * u() };
		const S = Array.from({ length: 120 + Math.floor(240 * u()) }, () => (u() < 0.2 ? 0 : ST * u()));
		const options = {
			rechargeThreshold: u() < 0.5 ? 'HGSL' : 'SL',
			rechargeAverageStart: u() < 0.5 ? 'available' : 'zeroPadded',
			percolationStorage: u() < 0.5 ? 'afterRecharge' : 'previous'
		} as const;
		return { c, params: withP0, S, options, aqx: S.map(() => (u() < 0.1 ? 5 * u() : 0)) };
	});

	it.each(cases)('case $c: store balance, bounds, Σ RE = Σ(PERC + EXRECH) + ΔP, determinism', ({ params, S, options }) => {
		const r = samiSoilPass(S, params, options);
		let prev = params.P0;
		for (let i = 0; i < S.length; i++) {
			// ΔP = RE − EXRECH − PERC
			expect(Math.abs(r.p[i]! - prev - (r.re[i]! - r.exrech[i]! - r.perc[i]!))).toBeLessThan(1e-9);
			expect(r.p[i]!).toBeGreaterThanOrEqual(0);
			expect(r.p[i]!).toBeLessThanOrEqual(params.PMAX + 1e-12);
			expect(r.perc[i]!).toBeGreaterThanOrEqual(0);
			expect(r.exrech[i]!).toBeGreaterThanOrEqual(0);
			expect(r.re[i]!).toBeGreaterThanOrEqual(0);
			expect(r.re[i]!).toBeLessThanOrEqual(params.HGGW + 1e-12);
			expect(r.soilInterflow[i]!).toBeLessThanOrEqual(params.FT + 1e-12);
			prev = r.p[i]!;
		}
		const deltaP = r.p[S.length - 1]! - params.P0;
		expect(Math.abs(sum(r.re) - (sum(r.perc) + sum(r.exrech) + deltaP))).toBeLessThan(1e-8);
		expect(samiSoilPass(S, params, options)).toEqual(r);
	});

	it.each(cases)('case $c: zero rain (S below SL and HGSL) ⇒ RE = SIF = 0, P drains to EXRECH + PERC only', ({ params }) => {
		const dry = Array.from({ length: 36 }, () => Math.min(params.SL, params.HGSL) * 0.5);
		const r = samiSoilPass(dry, params);
		expect(r.re.every((x) => x === 0)).toBe(true);
		expect(r.soilInterflow.every((x) => x === 0)).toBe(true);
		expect(r.reBar).toBe(0);
		expect(r.perc.every((x) => x === 0)).toBe(true);
	});

	it.each(cases)('case $c: the lag conserves volume apart from what is still in transit', ({ params, S, aqx }) => {
		const sif = samiSoilPass(S, params).soilInterflow;
		const I = sif.map((x, i) => x + aqx[i]!);
		for (const initialLagState of ['steady', 'zero'] as const) {
			const O = samiInterflow(sif, aqx, params.lag, { initialLagState });
			const N = I.length - 1;
			const I0 = initialLagState === 'steady' ? I[0]! : 0;
			const k = params.lag;
			// lag.ts identity from a pre-state (I0, O0 = I0): Σ O = Σ I − ½(I_N − I0) − (k − ½)(O_N − I0).
			const inTransit = k === 0 ? 0 : 0.5 * (I[N]! - I0) + (k - 0.5) * (O[N]! - I0);
			expect(Math.abs(sum(O) - (sum(I) - inTransit))).toBeLessThan(1e-8 * Math.max(1, sum(I)));
		}
	});
});

describe('samiSoilParams', () => {
	const sami = {
		unsaturatedStorage: 20,
		initialUnsaturatedStorage: 10,
		PPOW: 0.2,
		GPOW: 3,
		HGSL: 15,
		HGGW: 2,
		interflowLag: 1.5,
		rechargeAveragingMonths: 2.0,
		pitman: { POW: 2, SL: 30, ST: 300, FT: 4, GW: 0, ZMIN: 0, ZMAX: 999, PI: 1.5, TL: 0.25, GL: 0, R: 0.5, FF: 0.8 }
	} as unknown as SamiParameters;

	it('maps L.035 POW/SL/ST/FT, L.031 v5, L.032 and L.034 v3–v4 (§2)', () => {
		expect(samiSoilParams({ number: 7, sami })).toEqual({
			POW: 2,
			SL: 30,
			ST: 300,
			FT: 4,
			HGSL: 15,
			HGGW: 2,
			GPOW: 3,
			PPOW: 0.2,
			P0: 10,
			PMAX: 20,
			MMA: 2,
			lag: 1.5
		});
	});

	it('reads MMA as the nearest integer (R6-S2) and throws without a Sami block', () => {
		expect(samiSoilParams({ number: 7, sami: { ...sami, rechargeAveragingMonths: 2.99 } }).MMA).toBe(3);
		expect(() => samiSoilParams({ number: 7 } as Pick<RunoffModule, 'number' | 'sami'>)).toThrow(/module 7/);
	});
});
