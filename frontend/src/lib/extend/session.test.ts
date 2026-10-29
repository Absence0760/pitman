import type { FitOptions, Monthly12 } from '@pitman/wrsm';
import { describe, expect, it } from 'vitest';
import { extensionEngine } from './engine.js';
import { CHIRPS_MAP_MM, WORKED_CHIRPS, WORKED_RAN, fakeEngine, workedFit } from './fixtures.test-helper.js';
import { checkWindow, fitExtension, missingInOverlap, partialYear, previewExtension, rowTotal, windowYears } from './session.js';

const whole = { startYear: 1981, endYear: 2009 };

describe('fitExtension', () => {
	it('passes the window to the engine only when narrowed', () => {
		const calls: { fit: (FitOptions | undefined)[] } = { fit: [] };
		const engine = fakeEngine(workedFit(), calls);
		expect(fitExtension(engine, WORKED_RAN, WORKED_CHIRPS).ok).toBe(true);
		const narrowed = fitExtension(engine, WORKED_RAN, WORKED_CHIRPS, { startYear: 1982, endYear: 1983 });
		expect(narrowed.ok && narrowed.value.overlap).toEqual({ startYear: 1982, endYear: 1983, window: 'user' });
		expect(calls.fit).toEqual([{}, { overlap: { startYear: 1982, endYear: 1983 } }]);
	});

	it('returns the engine’s refusal as a message', () => {
		const engine = { ...fakeEngine(), fit: () => { throw new Error('The file ends before 1981/82: there is no overlap with CHIRPS.'); } };
		expect(fitExtension(engine, WORKED_RAN, WORKED_CHIRPS)).toEqual({ ok: false, error: 'The file ends before 1981/82: there is no overlap with CHIRPS.' });
	});

	it('is wired to the engine: the worked example fits with a 4-year overlap, too short to compute factors', () => {
		const outcome = fitExtension(extensionEngine, WORKED_RAN, WORKED_CHIRPS);
		if (!outcome.ok) throw new Error(outcome.error);
		expect(outcome.value.overlap).toEqual({ startYear: 1981, endYear: 1984, window: 'default' });
		expect(outcome.value.chirpsMapMm).toBeCloseTo(CHIRPS_MAP_MM, 1);
		expect(outcome.value.factors.every((f) => f.flag === 'shortOverlap')).toBe(true);
		expect(outcome.value.appendable).toEqual({ firstYear: 1985, lastYear: 1985 });
		expect(outcome.value.stoppedAt).toEqual({ year: 1986, month: 4 });
	});
});

describe('the overlap window (D5)', () => {
	it('offers every year of the whole overlap', () => {
		expect(windowYears({ startYear: 1981, endYear: 1984 })).toEqual([1981, 1982, 1983, 1984]);
	});

	it('is the default when it is the whole overlap, and checked otherwise', () => {
		expect(checkWindow(1981, 2009, whole)).toEqual({ ok: true, value: undefined });
		expect(checkWindow(1990, 2009, whole)).toEqual({ ok: true, value: { startYear: 1990, endYear: 2009 } });
		expect(checkWindow(2000, 1990, whole)).toEqual({ ok: false, error: 'The first year must not be after the last year.' });
		expect(checkWindow(1975, 1990, whole)).toEqual({ ok: false, error: 'The window must lie inside the overlap.' });
		expect(checkWindow(Number.NaN, 1990, whole).ok).toBe(false);
	});
});

describe('previewExtension', () => {
	it('is the engine’s own apply: the rows after the original record', () => {
		const fit = workedFit();
		const factors = fit.factors.map((f) => f.computed) as unknown as Monthly12;
		const preview = previewExtension(fakeEngine(fit), WORKED_RAN, WORKED_CHIRPS, fit, factors, { file: 'ZZA.RAN', quaternaries: [], accessed: '2026-10-29' });
		if (!preview.ok) throw new Error(preview.error);
		expect(preview.value.appended.map((r) => r.year)).toEqual([1985]);
		// The worked example's appended row (extend.md § Step 7).
		expect(preview.value.appended[0]?.months).toEqual([6.07, 8.86, 10.87, 13.63, 12.7, 10.04, 7.0, 5.07, 3.2, 0.44, 1.85, 4.02]);
		expect(rowTotal(preview.value.appended[0]!)).toBeCloseTo(83.75, 9);
	});

	it('returns the engine’s error', () => {
		const engine = { ...fakeEngine(), apply: () => { throw new Error('July: factor refused'); } };
		const fit = workedFit();
		expect(previewExtension(engine, WORKED_RAN, WORKED_CHIRPS, fit, fit.factors.map(() => 1) as unknown as Monthly12, { file: 'ZZA.RAN', quaternaries: [], accessed: '' })).toEqual({
			ok: false,
			error: 'July: factor refused'
		});
	});
});

describe('partialYear', () => {
	it('counts the months CHIRPS holds of its last, partial, hydrological year', () => {
		expect(partialYear(WORKED_CHIRPS)).toEqual({ year: 1987, months: 3 });
		const toMarch = { ...WORKED_CHIRPS, months: WORKED_CHIRPS.months.filter((m) => m.year < 1987 || (m.year === 1987 && m.month <= 3)) };
		expect(partialYear(toMarch)).toEqual({ year: 1986, months: 6 });
		const toSeptember = { ...WORKED_CHIRPS, months: WORKED_CHIRPS.months.filter((m) => m.year < 1987 || (m.year === 1987 && m.month <= 9)) };
		expect(partialYear(toSeptember)).toBeNull();
	});
});

describe('missingInOverlap', () => {
	it('lists missing CHIRPS months inside the overlap only', () => {
		expect(missingInOverlap(workedFit())).toEqual([]);
		expect(missingInOverlap(workedFit({ overlap: { startYear: 1981, endYear: 1986, window: 'user' } }))).toEqual([{ year: 1986, month: 4 }]);
	});
});
