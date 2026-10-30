import { describe, expect, it } from 'vitest';
import { applyOptions, formatMar, formatPercent, formatScale, iterationRows, mayApply, outcomeSentence, roundingWarning, stepWords, type CalibrationOutcome } from './calibration.js';
import { CONVERGED, NOT_CONVERGED, REFUSED, TARGET } from './fixtures.test-helper.js';

const CROSS = { marMm3: 23.7, source: 'unsplit module, natural run, 1920/21 to 2009/10' };
const outcome = (result: CalibrationOutcome['result'], acceptNotConverged = false): CalibrationOutcome => ({ result, target: TARGET, crossCheck: CROSS, acceptNotConverged });

describe('formatting', () => {
	it('signs a percentage with a real minus', () => {
		expect(formatPercent(25.46)).toBe('+25.46 %');
		expect(formatPercent(-41.38)).toBe('−41.38 %');
		expect(formatPercent(0)).toBe('0.00 %');
		expect(formatPercent(-0.001)).toBe('0.00 %');
		expect(formatPercent(Number.NaN)).toBe('—');
	});

	it('shows the factor to 4 places and the MAR to 3', () => {
		expect(formatScale(0.9325)).toBe('0.9325');
		expect(formatMar(24.098)).toBe('24.098');
		expect(formatMar(null)).toBe('—');
	});

	it('explains every step in words', () => {
		for (const step of ['start', 'ratio', 'secant', 'bisect', 'clamped'] as const) expect(stepWords(step)).not.toBe(step);
	});
});

describe('the iteration table', () => {
	it('holds the worked example’s log, each piece’s MAP in whole mm', () => {
		const rows = iterationRows(CONVERGED);
		expect(rows).toHaveLength(4);
		expect(rows[1]).toEqual({ n: 1, attempt: 2, step: 'Ratio: target ÷ MAR', factor: '0.7971', mar: '14.068', error: '−41.38 %', maps: ['654', '486'], mark: '' });
		expect(rows[3]?.error).toBe('+0.41 %');
	});

	it('marks the accepted try, or the best one, in words', () => {
		expect(iterationRows(CONVERGED).map((r) => r.mark)).toEqual(['', '', '', 'Accepted']);
		expect(iterationRows(NOT_CONVERGED).map((r) => r.mark)).toEqual(['', '', 'Best']);
	});
});

describe('never applying an unconverged factor silently', () => {
	it('offers Apply on a converged calibration', () => {
		expect(mayApply(outcome(CONVERGED))).toBe(true);
	});

	it('withholds it from a calibration that didn’t converge until the user chooses', () => {
		expect(mayApply(outcome(NOT_CONVERGED))).toBe(false);
		expect(mayApply(outcome(NOT_CONVERGED, true))).toBe(true);
	});

	it('never offers it on a refusal, or with nothing calibrated', () => {
		expect(mayApply(outcome(REFUSED, true))).toBe(false);
		expect(mayApply(undefined)).toBe(false);
	});

	it('won’t accept a best that isn’t there', () => {
		expect(mayApply(outcome({ ...NOT_CONVERGED, best: null }, true))).toBe(false);
	});

	it('only sets the flag when the user chose it', () => {
		expect(applyOptions(outcome(CONVERGED))).toEqual({ calibration: CONVERGED, target: TARGET, crossCheck: CROSS });
		expect(applyOptions(outcome(NOT_CONVERGED, true)).acceptNotConverged).toBe(true);
	});
});

describe('outcomeSentence', () => {
	it('says how a calibration ended', () => {
		expect(outcomeSentence(outcome(CONVERGED))).toBe('Converged in 4 tries: factor 0.9325, +0.41 % from the target (the limit is 2 %).');
		expect(outcomeSentence(outcome(NOT_CONVERGED))).toBe('Not converged after 3 tries: the best factor is 0.9227, −2.99 % from the target. The MAPs would have to change by more than a factor of 2: check the target and the grid.');
		expect(outcomeSentence(outcome(REFUSED))).toBe('No factor can be found. The natural run gives no runoff, so no factor can be found.');
	});

	it('says the choice is on record once it is made', () => {
		expect(outcomeSentence(outcome(NOT_CONVERGED, true))).toContain('recorded as not converged');
	});
});

describe('roundingWarning', () => {
	it('is silent within 2 % and says so outside it', () => {
		expect(roundingWarning(CONVERGED, TARGET)).toBeNull();
		expect(roundingWarning({ ...CONVERGED, finalMarMm3: 24.47 }, TARGET)).toBeNull();
		expect(roundingWarning({ ...CONVERGED, finalMarMm3: 25 }, TARGET)).toContain('+4.17 %');
	});

	it('is only about a converged result', () => {
		expect(roundingWarning(NOT_CONVERGED, TARGET)).toBeNull();
		expect(roundingWarning(REFUSED, TARGET)).toBeNull();
	});
});
