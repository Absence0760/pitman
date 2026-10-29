import { describe, expect, it } from 'vitest';
import {
	areaConstant,
	basicAverageStorage,
	basicEvaporationConstant,
	basicRecharge,
	basicWetlandMonth,
	comprehensiveWetlandMonth,
	wetlandArea,
	wetlandInflow,
	wetlandReturn,
	type ComprehensiveWetlandParameters
} from './wetland.js';

// Hand-worked numbers: docs/theory/channel.md §3.3 (basic) and §4.3 (comprehensive).

const basic = { chc1: 10, chc2: 5, chc3: 1 };

describe('basic wetland, TT 690 ch.9', () => {
	it('eq. 9.1: recharge, printed and prose forms (OQ-CR5)', () => {
		expect(basicRecharge(basic, 8, 4)).toBe(4);
		const half = { ...basic, chc3: 0.5 };
		expect(basicRecharge(half, 8, 4, 'printed')).toBe(2);
		expect(basicRecharge(half, 8, 4, 'prose')).toBe(3);
		expect(basicRecharge(half, 12, 1)).toBe(-0.5);
	});

	it('eq. 9.3: ETC', () => {
		expect(basicEvaporationConstant(basic, 90)).toBeCloseTo(0.0225, 12);
	});

	it('eqs. 9.5–9.8: average storage, each case', () => {
		expect(basicAverageStorage(10, 4, 6)).toBe(5); // never exceeded: SAVT
		expect(basicAverageStorage(10, 12, 11)).toBe(10); // exceeded throughout (9.6)
		expect(basicAverageStorage(10, 12, 8)).toBeCloseTo(10 - (0.5 * 4) / 4, 12); // exceeded at the start (9.7): 9.5
		expect(basicAverageStorage(10, 8, 11.559902200488997)).toBeCloseTo(9.438186813, 8); // at the end (9.8)
	});

	it('eqs. 9.1–9.13: a month that fills the wetland past CHC1 (§3.3 example 1)', () => {
		const r = basicWetlandMonth(basic, 8, 4, 90);
		expect(r.qloss).toBe(4);
		expect(r.riverOut).toBe(0);
		expect(r.averageStorage).toBeCloseTo(9.438187, 6);
		expect(r.netEvaporation).toBeCloseTo(0.424718, 6);
		expect(r.storageEnd).toBeCloseTo(11.575282, 6);
	});

	it('a negative recharge drains the wetland back to the river (§3.3 example 2, OQ-CR6)', () => {
		const r = basicWetlandMonth({ ...basic, chc3: 0.5 }, 12, 1, 90);
		expect(r.qloss).toBe(-0.5);
		expect(r.riverOut).toBe(1.5);
		expect(r.averageStorage).toBe(10);
		expect(r.netEvaporation).toBeCloseTo(0.45, 12);
		expect(r.storageEnd).toBeCloseTo(11.05, 12);
	});

	it('eqs. 9.11–9.12: evaporation is cut when storage would go negative', () => {
		const r = basicWetlandMonth({ chc1: 1, chc2: 50, chc3: 1 }, 1, 0, 100);
		expect(r.netEvaporation).toBeCloseTo(1, 12);
		expect(r.storageEnd).toBe(0);
	});

	it('net rain fills the wetland; too much breaks eq. 9.4 and throws (OQ-CR7)', () => {
		const wet = basicWetlandMonth(basic, 5, 0, -50);
		expect(wet.netEvaporation).toBeLessThan(0);
		expect(wet.storageEnd).toBeGreaterThan(5);
		expect(() => basicWetlandMonth({ chc1: 1, chc2: 50, chc3: 1 }, 1, 0, -100)).toThrow(/OQ-CR7/);
	});
});

const comp: ComprehensiveWetlandParameters = { anom: 4, snom: 8, b: 0.5, qbf: 10, kin: 0.5, kout: 0.25, qdiv: Infinity };

describe('comprehensive wetland, TT 690 ch.10', () => {
	it('eq. 10.2: flow into the wetland, with the Qdiv cap', () => {
		expect(wetlandInflow(comp, 9)).toBe(0);
		expect(wetlandInflow(comp, 30)).toBe(10);
		expect(wetlandInflow({ ...comp, qdiv: 3 }, 30)).toBe(3);
		expect(wetlandInflow({ ...comp, qbf: 0, kin: 1 }, 7)).toBe(7); // in-channel wetland
	});

	it('eq. 10.3: return flow', () => {
		expect(wetlandReturn(comp, 7)).toBe(0);
		expect(wetlandReturn(comp, 12)).toBe(1);
	});

	it('eq. 10.5 and A = a·S^b', () => {
		expect(areaConstant(comp)).toBeCloseTo(Math.SQRT2, 12);
		expect(wetlandArea(areaConstant(comp), 0.5, 8)).toBeCloseTo(4, 12);
		expect(wetlandArea(1, 0.5, 0)).toBe(0);
	});

	it('eqs. 10.1–10.7: one month solved by successive approximation (§4.3 example)', () => {
		const r = comprehensiveWetlandMonth(comp, { s1: 8, qus: 30, qloc: 1, qabs: 0.5, enetM: 0.09 });
		expect(r.qin).toBe(10);
		expect(r.save).toBeCloseTo(12.466931, 6);
		expect(r.qout).toBeCloseTo(1.116733, 6);
		expect(r.area).toBeCloseTo(4.993382, 6);
		expect(r.qevap).toBeCloseTo(0.449404, 6);
		expect(r.s2).toBeCloseTo(16.933863, 6);
		expect(r.qds).toBeCloseTo(21.116733, 6);
		expect(r.save).toBeCloseTo((8 + r.s2) / 2, 8);
		expect(r.iterations).toBeGreaterThan(0);
	});

	it('an emptying wetland: Save = S1/2, the abstraction is cut first (OQ-CR11)', () => {
		const r = comprehensiveWetlandMonth(comp, { s1: 0.2, qus: 2, qloc: 0, qabs: 1, enetM: 0.09 });
		expect(r.s2).toBe(0);
		expect(r.save).toBeCloseTo(0.1, 12);
		expect(r.area).toBeCloseTo(0.447214, 6);
		expect(r.qevap).toBeCloseTo(0.040249, 6);
		expect(r.qabs).toBeCloseTo(0.159751, 6);
		expect(r.qabsShort).toBeCloseTo(0.840249, 6);
		expect(r.qds).toBe(2);
		expect(0.2 - r.qevap - r.qabs - r.s2).toBeCloseTo(0, 12);
	});

	it('falls back to bisection when successive approximation does not converge (OQ-CR10)', () => {
		const input = { s1: 3, qus: 40, qloc: 0, qabs: 0, enetM: 0.15 };
		const r = comprehensiveWetlandMonth({ ...comp, b: 0.2, kout: 1 }, input, { tolerance: 1e-10, maxIterations: 1 });
		expect(r.iterations).toBe(0);
		expect(r.save).toBeCloseTo((3 + r.s2) / 2, 8);
		const full = comprehensiveWetlandMonth({ ...comp, b: 0.2, kout: 1 }, input);
		expect(r.save).toBeCloseTo(full.save, 8);
	});
});
