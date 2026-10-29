import { describe, expect, it } from 'vitest';
import { syntheticChirpsMonthly } from './synthetic.js';

describe('syntheticChirpsMonthly', () => {
	it('runs from January 1981 to the finalThrough month, every month in order', () => {
		const c = syntheticChirpsMonthly();
		expect(c.months[0]).toMatchObject({ year: 1981, month: 1 });
		expect(c.months.at(-1)).toMatchObject({ year: 2026, month: 9 });
		expect(c.months).toHaveLength(45 * 12 + 9);
		c.months.forEach((m, i) => i > 0 && expect((m.year - 1981) * 12 + m.month - 1).toBe(i));
		expect(c.months.every((m) => m.mm !== null && m.mm >= 0)).toBe(true);
	});

	it('is seeded: the same options give the same series, another seed another', () => {
		expect(syntheticChirpsMonthly({ seed: 3 })).toEqual(syntheticChirpsMonthly({ seed: 3 }));
		expect(syntheticChirpsMonthly({ seed: 3 }).months).not.toEqual(syntheticChirpsMonthly({ seed: 4 }).months);
	});

	it('marks the missing months null and carries the area options', () => {
		const c = syntheticChirpsMonthly({ missing: ['1990-02'], weightRemovedPct: 12, cells: 3, source: 's3', finalThrough: '2000-03-31' });
		expect(c.months.filter((m) => m.mm === null)).toEqual([{ year: 1990, month: 2, mm: null }]);
		expect(c).toMatchObject({ weightRemovedPct: 12, cells: 3, source: 's3', finalThrough: '2000-03-31' });
		expect(c.months.at(-1)).toMatchObject({ year: 2000, month: 3 });
	});

	it('averages near the requested MAP over whole hydrological years', () => {
		const c = syntheticChirpsMonthly({ mapMm: 600 });
		const total = c.months.filter((m) => m.year >= 1982 && m.year <= 2025).reduce((s, m) => s + (m.mm ?? 0), 0);
		expect(total / 44).toBeGreaterThan(400);
		expect(total / 44).toBeLessThan(800);
	});

	it('rejects a malformed month', () => {
		expect(() => syntheticChirpsMonthly({ from: '1981' })).toThrow(/YYYY-MM/);
		expect(() => syntheticChirpsMonthly({ finalThrough: '2026-13-01' })).toThrow(/no month 13/);
	});
});
