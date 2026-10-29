import { describe, expect, it } from 'vitest';
import { syntheticBundle } from '../network/synthetic-bundle.js';
import type { RunoffModule } from '../types.js';
import { activeAreaPavedFraction, pavedFractionByMonth, specialAreaMessages } from './paved.js';

const base = syntheticBundle().modules.find((m): m is RunoffModule => m.kind === 'RU')!;
const paved = (over: Partial<RunoffModule> = {}): RunoffModule => ({
	...base,
	areaKm2: 100,
	paved: { fraction: [{ year: 2000, value: 0.02 }, { year: 2004, value: 0.06 }] },
	...over
});

describe('pavedFractionByMonth (D1; TT 689 pp.27, 142)', () => {
	it('historical: the year table per hydrological year, linear between years, flat beyond (OQ-17)', () => {
		const { fraction, messages } = pavedFractionByMonth(paved(), { kind: 'historical' }, 1999, 2005);
		expect(fraction.length).toBe(84);
		const yearly = [0, 1, 2, 3, 4, 5, 6].map((i) => fraction[12 * i]!);
		[0.02, 0.02, 0.03, 0.04, 0.05, 0.06, 0.06].forEach((v, i) => expect(yearly[i]).toBeCloseTo(v, 12));
		expect(new Set(fraction.slice(24, 36)).size).toBe(1);
		expect(messages).toEqual([]);
	});

	it('present day holds the fraction at the chosen year; natural removes it', () => {
		const pd = pavedFractionByMonth(paved(), { kind: 'presentDay', year: 2002 }, 1990, 2010).fraction;
		expect(new Set(pd.map((v) => v.toFixed(12)))).toEqual(new Set([(0.04).toFixed(12)]));
		expect(new Set(pavedFractionByMonth(paved(), { kind: 'natural' }, 1990, 2010).fraction)).toEqual(new Set([0]));
	});

	it('no table gives 0', () => {
		const none = pavedFractionByMonth({ ...base, paved: undefined } as unknown as RunoffModule, { kind: 'historical' }, 2000, 2001);
		expect(none.fraction).toEqual(new Array(24).fill(0));
	});

	it('R6-P2: a child ignores its paved data with a warning (TT 689 p.140)', () => {
		const r = pavedFractionByMonth(paved(), { kind: 'historical' }, 2000, 2001, { isChild: true });
		expect(r.fraction.every((v) => v === 0)).toBe(true);
		expect(r.messages.map((m) => m.level)).toEqual(['warning']);
	});

	it('a fraction outside 0–1 is an error, clamped', () => {
		const r = pavedFractionByMonth(paved({ paved: { fraction: [{ year: 2000, value: 1.5 }] } }), { kind: 'historical' }, 2000, 2000);
		expect(r.fraction).toEqual(new Array(12).fill(1));
		expect(r.messages[0]!.level).toBe('error');
	});
});

describe('activeAreaPavedFraction (R6-P1; TT 689 p.140 "Active area")', () => {
	it('conserveArea: the paved km² stay AI × AREA when children take part of the parent', () => {
		// 4 % of 100 km² = 4 km² paved; 80 km² left for the parent → 5 %.
		expect(activeAreaPavedFraction(0.04, 100, 80)).toBeCloseTo(0.05, 15);
		expect(activeAreaPavedFraction(0.04, 100, 100)).toBeCloseTo(0.04, 15);
		expect(activeAreaPavedFraction(0.5, 100, 20)).toBe(1);
		expect(activeAreaPavedFraction(0.5, 100, 0)).toBe(0);
	});

	it('asFraction: AI unchanged', () => {
		expect(activeAreaPavedFraction(0.04, 100, 80, 'asFraction')).toBe(0.04);
	});
});

describe('specialAreaMessages (R6-P3; TT 689 p.127, TT 691 p.63 RU_SPECIAL_AREA)', () => {
	const m = paved({
		afforestation: { ...base.afforestation, areaKm2: [{ year: 2000, value: 30 }] },
		alienVegetation: { algorithm: 1, riparianArea: 0, areaKm2: [{ year: 2000, value: 40 }] }
	});

	it('no message while afforestation + alien + paved + children fit in AREA', () => {
		expect(specialAreaMessages(m, 2000)).toEqual([]);
		expect(specialAreaMessages(m, 2000, [28])).toEqual([]); // 30 + 40 + 2 + 28 = 100
	});

	it('an error when they exceed it', () => {
		const msgs = specialAreaMessages(m, 2004, [28]); // paved 6 km² by 2004
		expect(msgs.map((x) => x.level)).toEqual(['error']);
		expect(msgs[0]!.at).toEqual({ year: 2004, month: 0 });
	});
});
