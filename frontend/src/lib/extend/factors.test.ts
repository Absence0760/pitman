import { describe, expect, it } from 'vitest';
import {
	blockingMessages,
	editsFromSaved,
	factorNotes,
	factorRows,
	factorsForDisplay,
	factorsInUse,
	flagLabel,
	formatFactor,
	initialEdits,
	parseFactor,
	type FactorEdit
} from './factors.js';
import { fakeCheck, workedFactors, workedFit } from './fixtures.test-helper.js';

const fit = workedFit();
const typed = (edits: FactorEdit[], index: number, text: string, extra: Partial<FactorEdit> = {}) =>
	edits.map((e, i) => (i === index ? { ...e, text, typed: true, ...extra } : e));

describe('parseFactor', () => {
	it.each([
		['0.83', 0.83],
		['0,83', 0.83],
		[' 1 ', 1],
		['.5', 0.5],
		['2.', 2],
		['-1', -1]
	])('reads %j', (text, value) => {
		expect(parseFactor(text)).toBe(value);
	});

	it.each(['', 'abc', '1.2.3', '1e3', '0,8,3', 'NaN'])('gives NaN for %j', (text) => {
		expect(parseFactor(text)).toBeNaN();
	});
});

describe('factorRows', () => {
	it('starts every month at its computed value, unedited, nothing blocking', () => {
		const rows = factorRows(fit, initialEdits(fit), fakeCheck);
		expect(rows.map((r) => r.edit.text)).toEqual(fit.factors.map((f) => formatFactor(f.computed)));
		expect(rows.every((r) => r.inUse === r.fit.computed && !r.edited && !r.blocking)).toBe(true);
		expect(factorsInUse(rows)).toEqual(fit.factors.map((f) => f.computed));
		expect(blockingMessages(rows)).toEqual([]);
	});

	it('treats a typed value equal to the shown computed one as the computed one', () => {
		const rows = factorRows(fit, typed(initialEdits(fit), 0, '0.8330'), fakeCheck);
		expect(rows[0]?.inUse).toBe(fit.factors[0]?.computed);
		expect(rows[0]?.edited).toBe(false);
	});

	it('uses an edited value', () => {
		const rows = factorRows(fit, typed(initialEdits(fit), 9, '1,5'), fakeCheck);
		const jul = rows[9];
		expect([jul?.inUse, jul?.edited, jul?.check, jul?.message]).toEqual([1.5, true, 'ok', '']);
	});

	it('blocks a computed factor above 5 until it is edited (R4-E1)', () => {
		const high = workedFit({ factors: fit.factors.map((f, k) => (k === 8 ? { ...f, computed: 6.2 } : f)) as unknown as typeof fit.factors });
		const rows = factorRows(high, initialEdits(high), fakeCheck);
		expect([rows[8]?.check, rows[8]?.blocking]).toEqual(['refused', true]);
		expect(rows[8]?.message).toMatch(/computed factor is above 5.*narrow the overlap/);
		expect(factorRows(high, typed(initialEdits(high), 8, '2'), fakeCheck)[8]?.blocking).toBe(false);
	});

	it('starts from saved factors when re-extending (R4-E2)', () => {
		const used = fit.factors.map((f, k) => (k === 4 ? 1.2 : f.computed));
		const edits = editsFromSaved(fit, used, ['', '', '', '', 'checked against a gauge']);
		expect(edits[4]).toEqual({ text: '1.2000', typed: true, confirmedZero: false, note: 'checked against a gauge' });
		expect(edits[0]?.typed).toBe(false);
		const rows = factorRows(fit, edits, fakeCheck);
		expect([rows[4]?.inUse, rows[4]?.edited]).toEqual([1.2, true]);
	});

	it('refuses what checkFactor refuses, and blocks the apply', () => {
		for (const text of ['6', '-0.1', 'abc', '']) {
			const rows = factorRows(fit, typed(initialEdits(fit), 2, text), fakeCheck);
			expect(rows[2]?.check).toBe('refused');
			expect(rows[2]?.inUse).toBeNull();
			expect(rows[2]?.blocking).toBe(true);
			expect(factorsInUse(rows)).toBeNull();
			// The charts keep the computed value meanwhile.
			expect(factorsForDisplay(rows)[2]).toBe(fit.factors[2]?.computed);
		}
		expect(factorRows(fit, typed(initialEdits(fit), 2, 'abc'), fakeCheck)[2]?.message).toBe('Type a number from 0 to 5.');
		expect(blockingMessages(factorRows(fit, typed(initialEdits(fit), 2, '6'), fakeCheck))).toEqual([
			{ index: 2, text: 'December: Not allowed: a factor must be from 0 to 5.' }
		]);
	});

	it('allows 0 only once confirmed', () => {
		const edits = typed(initialEdits(fit), 9, '0');
		const before = factorRows(fit, edits, fakeCheck);
		expect([before[9]?.check, before[9]?.blocking, before[9]?.message]).toEqual(['confirmZero', true, 'Every appended July will have no rain.']);
		expect(blockingMessages(before)[0]?.text).toBe('July: Every appended July will have no rain. Confirm it, or change the factor.');
		const after = factorRows(fit, typed(edits, 9, '0', { confirmedZero: true }), fakeCheck);
		expect(after[9]?.blocking).toBe(false);
		expect(factorsInUse(after)?.[9]).toBe(0);
	});

	it('warns far from 1 without blocking', () => {
		const rows = factorRows(fit, typed(initialEdits(fit), 4, '2.5'), fakeCheck);
		expect([rows[4]?.check, rows[4]?.blocking, rows[4]?.message]).toEqual(['warn', false, 'Far from 1: check the fit before applying.']);
	});

	it('asks for every factor when the overlap is too short to compute them', () => {
		const short = workedFit({ factors: workedFactors('shortOverlap') });
		const rows = factorRows(short, initialEdits(short), fakeCheck);
		expect(rows.every((r) => r.blocking && /too short/.test(r.message))).toBe(true);
		expect(factorsInUse(rows)).toBeNull();
		const one = factorRows(short, typed(initialEdits(short), 0, '1'), fakeCheck);
		expect(one[0]?.blocking).toBe(false);
		expect(one[0]?.edited).toBe(false); // 1 is the placeholder value
	});

	it('records notes only for edited months', () => {
		let edits = typed(initialEdits(fit), 1, '0.9', { note: '  gauge comparison  ' });
		edits = edits.map((e, i) => (i === 3 ? { ...e, note: 'not edited' } : e));
		expect(factorNotes(factorRows(fit, edits, fakeCheck))).toEqual({ 1: 'gauge comparison' });
	});
});

describe('flagLabel', () => {
	it('names every flag', () => {
		for (const flag of ['computed', 'dryBoth', 'chirpsDry', 'noOverlapMonths', 'shortOverlap'] as const) expect(flagLabel(flag)).not.toBe('');
	});
});
