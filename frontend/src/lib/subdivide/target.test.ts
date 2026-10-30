import { describe, expect, it } from 'vitest';
import { UNSPLIT_TARGET_SOURCE, crossCheckOf, crossCheckWarning, differencePct, periodLabel, resolveTarget, typedCrossCheckWarning } from './target.js';

const UNSPLIT = { marMm3: 23.7, period: { startYear: 1920, endYear: 2009 } };

describe('the cross-check', () => {
	it('says where it came from, hydrological years and all', () => {
		expect(periodLabel(UNSPLIT.period)).toBe('1920/21 to 2009/10');
		expect(crossCheckOf(UNSPLIT)).toEqual({ marMm3: 23.7, source: 'unsplit module, natural run, 1920/21 to 2009/10' });
	});
});

describe('resolveTarget', () => {
	it('falls back to the unsplit run, labelled as the spec says, with no value typed', () => {
		expect(resolveTarget('  ', '', UNSPLIT)).toEqual({ ok: true, fallback: true, target: { marMm3: 23.7, source: 'natural MAR of the unsplit module (no WR2012 value entered)' } });
		expect(UNSPLIT_TARGET_SOURCE).toBe('natural MAR of the unsplit module (no WR2012 value entered)');
	});

	it('ignores a citation with no value', () => {
		expect(resolveTarget('', 'WR2012, table 2', UNSPLIT)).toMatchObject({ ok: true, fallback: true });
	});

	it('takes a typed value with its citation, marked hand-entered', () => {
		expect(resolveTarget('24.0', ' WR2012 (WRC 2015),  vol. 1 ', UNSPLIT)).toEqual({ ok: true, fallback: false, target: { marMm3: 24, source: 'hand-entered: WR2012 (WRC 2015), vol. 1' } });
	});

	it('reads a decimal comma', () => {
		expect(resolveTarget('24,5', 'x', UNSPLIT)).toMatchObject({ ok: true, target: { marMm3: 24.5 } });
	});

	it('refuses a value without its citation (rule 8)', () => {
		expect(resolveTarget('24', '  ', UNSPLIT)).toEqual({ ok: false, field: 'citation', error: expect.stringContaining('volume and table') });
	});

	it('refuses a value that isn’t a positive number', () => {
		for (const text of ['abc', '0', '-3']) expect(resolveTarget(text, 'x', UNSPLIT)).toMatchObject({ ok: false, field: 'mar' });
	});
});

describe('the 5 % warning', () => {
	it('is silent at exactly 5 % and speaks above it', () => {
		expect(crossCheckWarning(105, 100)).toBeNull();
		expect(crossCheckWarning(95, 100)).toBeNull();
		expect(crossCheckWarning(105.1, 100)).toContain('differ by 5.1 %');
		expect(crossCheckWarning(90, 100)).toContain('differ by 10.0 %');
	});

	it('names the two causes', () => {
		expect(crossCheckWarning(150, 100)).toContain('mistyped');
		expect(crossCheckWarning(150, 100)).toContain('departs from WRSM2000');
	});

	it('copes with an unsplit run of no runoff', () => {
		expect(differencePct(5, 0)).toBe(Infinity);
		expect(crossCheckWarning(5, 0)).toContain('more than 5 %');
	});

	it('reads the value as typed, and waits for a number', () => {
		expect(typedCrossCheckWarning('', 100)).toBeNull();
		expect(typedCrossCheckWarning('12x', 100)).toBeNull();
		expect(typedCrossCheckWarning('110,5', 100)).toContain('10.5 %');
	});
});
