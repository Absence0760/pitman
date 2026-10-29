import { describe, expect, it } from 'vitest';
import { monthlyBias, summaryStats } from './diagnostics.js';
import { factorRows, initialEdits } from './factors.js';
import { fakeCheck, workedFit } from './fixtures.test-helper.js';

const fit = workedFit();

describe('summaryStats', () => {
	it('shows before and after with their signs', () => {
		expect(summaryStats(fit)).toEqual([
			{ label: 'Monthly R² (all overlap months, pooled)', before: '0.9988', after: '0.9994' },
			{ label: 'Monthly NSE against the file', before: '0.8130', after: '0.9993' },
			{ label: 'Annual R²', before: '0.9968', after: '0.9968' },
			{ label: 'Annual bias', before: '+21.13 %', after: '-0.27 %' }
		]);
	});
});

describe('monthlyBias', () => {
	it('says "0 by construction" for a computed factor rather than showing a zero', () => {
		const rows = factorRows(fit, initialEdits(fit), fakeCheck);
		const bias = monthlyBias(fit, rows);
		expect(bias[0]).toEqual({ month: 'October', before: '+20.00 %', afterComputed: '0 by construction', inUse: '0 by construction' });
		// July kept the fallback factor 1: its bias is a real number.
		expect(bias[9]).toEqual({ month: 'July', before: '+11.00 %', afterComputed: '-100.00 %', inUse: '-100.00 %' });
	});

	it('shows the bias with an edited factor', () => {
		const edits = initialEdits(fit).map((e, i) => (i === 0 ? { ...e, text: '1', typed: true } : e));
		expect(monthlyBias(fit, factorRows(fit, edits, fakeCheck))[0]?.inUse).toBe(`+${((100 * (7.233 - 6.025)) / 6.025).toFixed(2)} %`);
	});
});
