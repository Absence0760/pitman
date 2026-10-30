import { describe, expect, it } from 'vitest';
import { demandSpecProblems, type DemandSeries, type Monthly12 } from '@pitman/wrsm';
import { addGrowthRow, checkDraft, draftFromFile, draftFromSpec, draftSources, evenShares, newDraft, scaledShares, sumLabel, type DemandDraft } from './draft.js';

// Invented volumes only (issue #3 rule 2).

const network = { startYear: 1980 };
const filled = (annual = '1.2'): DemandDraft => {
	const d = newDraft(network);
	return { ...d, annual: { ...d.annual, text: annual } };
};
const withVolume = (d: DemandDraft, year: string, text: string): DemandDraft => ({ ...d, growth: d.growth.map((r) => (r.year === year ? { ...r, text } : r)) });

describe('newDraft', () => {
	it('starts at the run’s first year, even, with 2025 offered and blank', () => {
		const d = newDraft(network);
		expect(d.baseYear).toBe('1980');
		expect(d.shares).toHaveLength(12);
		expect(d.growth.map((r) => [r.year, r.text])).toEqual([['2025', '']]);
	});

	it('does not offer a year the base already reaches', () => {
		expect(newDraft({ startYear: 2025 }).growth).toEqual([]);
	});
});

describe('evenShares', () => {
	it('sums to 100 as the form reads it', () => {
		expect(sumLabel(evenShares().reduce((a, s) => a + Number(s), 0))).toBe('Sum: 100.00 %');
	});
});

describe('scaledShares', () => {
	it('scales shares that miss 100, and they then pass', () => {
		const shares = scaledShares(Array<string>(12).fill('8.33'));
		expect(shares?.[0]).toBe('8.3333');
		const d = { ...filled(), shares: shares ?? [] };
		expect(checkDraft(d).messages).toEqual({});
	});

	it('cannot scale what is not numbers or sums to nothing', () => {
		expect(scaledShares(['x', ...Array<string>(11).fill('1')])).toBeNull();
		expect(scaledShares(Array<string>(12).fill('0'))).toBeNull();
		expect(scaledShares(['-1', ...Array<string>(11).fill('1')])).toBeNull();
	});
});

describe('sumLabel', () => {
	it('says how far off the sum is', () => {
		expect(sumLabel(99.96)).toBe('Sum: 99.96 %, 0.04 short of 100');
		expect(sumLabel(100.5)).toBe('Sum: 100.50 %, 0.50 over 100');
		expect(sumLabel(null)).toBe('Sum: fix the boxes above');
	});
});

describe('checkDraft', () => {
	it('turns a good form into a spec the engine accepts', () => {
		const { spec, messages } = checkDraft(withVolume(filled(), '2025', '2,4'));
		expect(messages).toEqual({});
		expect(spec?.annualVolumeMm3).toBe(1.2);
		expect(spec?.growth).toEqual([
			{ year: 1980, value: 1.2 },
			{ year: 2025, value: 2.4 }
		]);
		expect(demandSpecProblems(spec!)).toEqual([]);
	});

	it('leaves a blank offered year out and says so', () => {
		const d = filled();
		const check = checkDraft(d);
		expect(check.spec?.growth).toEqual([{ year: 1980, value: 1.2 }]);
		expect(check.blankRows).toEqual([d.growth[0]?.id]);
	});

	it('asks for a volume', () => {
		const check = checkDraft(newDraft(network));
		expect(check.spec).toBeNull();
		expect(check.messages.annual).toBe('Enter a number, in million m³ a year.');
	});

	it('refuses each bad value in a sentence', () => {
		expect(checkDraft(filled('-1')).messages.annual).toBe('A volume can’t be negative.');
		expect(checkDraft({ ...filled(), baseYear: '19x' }).messages.baseYear).toBe('Enter a year, such as 2025.');
		expect(checkDraft({ ...filled(), baseYear: '1980.5' }).messages.baseYear).toBe('Enter a whole year, such as 2025.');
		expect(checkDraft({ ...filled(), baseYear: '3000' }).messages.baseYear).toBe('Enter a year from 1800 to 2100.');
	});

	it('names the month with a bad share', () => {
		const shares = evenShares().map((v, k) => (k === 3 ? 'abc' : v));
		const check = checkDraft({ ...filled(), shares });
		expect(check.messages['share-3']).toBe('Enter January’s share as a number; use 0 for none.');
		expect(check.sum).toBeNull();
		const negative = checkDraft({ ...filled(), shares: evenShares().map((v, k) => (k === 0 ? '-1' : v)) });
		expect(negative.messages['share-0']).toBe('October’s share can’t be negative.');
	});

	it('says how far the shares are from 100', () => {
		const check = checkDraft({ ...filled(), shares: Array<string>(12).fill('8.33') });
		expect(check.messages.shares).toBe('The 12 shares must add up to 100 %. They come to 99.96 %, 0.04 short of 100.');
		expect(check.spec).toBeNull();
	});

	it('refuses a year listed twice or before the base', () => {
		const twice = addGrowthRow(addGrowthRow(withVolume(filled(), '2025', '2'), '2025'), '2025');
		const dup = { ...twice, growth: twice.growth.map((r) => ({ ...r, text: '2' })) };
		const third = dup.growth[1]!.id;
		expect(checkDraft(dup).messages[`year-${third}`]).toBe('2025 is listed twice.');
		const early = addGrowthRow(filled(), '1970');
		const row = early.growth[1]!;
		expect(checkDraft({ ...early, growth: [early.growth[0]!, { ...row, text: '1' }] }).messages[`year-${row.id}`]).toBe(
			'The growth years come after the base year (1980). Start from an earlier base year instead.'
		);
	});

	it('refuses a demand that is zero in every year, but not a town that starts from nothing', () => {
		expect(checkDraft(filled('0')).messages.annual).toBe('The demand is zero in every year. Enter a volume.');
		expect(checkDraft(withVolume(filled('0'), '2025', '1')).spec?.growth[0]).toEqual({ year: 1980, value: 0 });
	});
});

describe('draftFromSpec', () => {
	const spec = {
		annualVolumeMm3: 1,
		monthlyDistributionPercent: [12, 12, 12, 10, 10, 8, 6, 6, 6, 6, 6, 6] as unknown as Monthly12,
		growth: [
			{ year: 1990, value: 1 },
			{ year: 2030, value: 3 }
		]
	};

	it('splits the first row off as the base and reads back to the same spec', () => {
		const d = draftFromSpec(spec, { growth: {} }, network);
		expect(d.baseYear).toBe('1990');
		expect(d.annual.text).toBe('1');
		expect(d.growth.map((r) => [r.year, r.text])).toEqual([
			['2030', '3'],
			['2025', '']
		]);
		expect(checkDraft(d).spec).toEqual(spec);
	});

	it('falls back to the run’s first year for a spec with no table', () => {
		expect(draftFromSpec({ ...spec, growth: [] }, { growth: {} }, network).baseYear).toBe('1980');
	});

	it('keeps an untouched value’s source and stamps a changed one', () => {
		const old = { kind: 'manual', note: 'town plan', date: '2020-02-02' } as const;
		const d = draftFromSpec(spec, { annualVolume: old, monthlyDistribution: old, growth: { 2030: old } }, network);
		const same = draftSources(d, '2025-01-01');
		expect(same.annualVolume).toEqual(old);
		expect(same.monthlyDistribution).toEqual(old);
		expect(same.growth[2030]).toEqual(old);
		const changed = draftSources({ ...d, annual: { ...d.annual, text: '1.5' } }, '2025-01-01');
		expect(changed.annualVolume).toEqual({ kind: 'manual', date: '2025-01-01', note: 'town plan' });
		expect(changed.monthlyDistribution).toEqual(old);
		const shares = draftSources({ ...d, shares: evenShares(), sharesNote: '' }, '2025-01-01');
		expect(shares.monthlyDistribution).toEqual({ kind: 'manual', date: '2025-01-01' });
	});
});

describe('draftFromFile', () => {
	const months = (v: number) => [v * 2, ...Array<number>(11).fill(v)] as unknown as Monthly12;
	const series = (rows: DemandSeries['rows']): DemandSeries => ({ fileName: 'SYDOM.abs ', rows, hasTotals: false, hasAverage: false });

	it('estimates from the rows and says that is what it did', () => {
		const d = draftFromFile(series([{ year: 1990, months: months(0.1) }, { year: 1991, months: months(0.2) }]));
		expect(d.baseYear).toBe('1990');
		expect(d.annual.text).toBe('1.3');
		expect(d.growth[0]?.year).toBe('1991');
		expect(d.growth[0]?.text).toBe('2.6');
		expect(Number(d.shares[0])).toBeCloseTo(15.3846, 4);
		expect(d.annual.origin).toEqual({ kind: 'networkFile', note: 'estimated from the rows of SYDOM.abs, not its original inputs' });
		expect(draftSources(d, '2025-01-01').annualVolume.kind).toBe('networkFile');
		expect(checkDraft(d).messages).toEqual({});
	});

	it('has no later row for a flat file', () => {
		const d = draftFromFile(series([{ year: 1990, months: months(0.1) }, { year: 1991, months: months(0.1) }]));
		expect(d.growth.map((r) => r.year)).toEqual(['2025']);
	});

	it('falls back to even shares for an all-zero file', () => {
		const d = draftFromFile(series([{ year: 1990, months: months(0) }]));
		expect(d.shares).toEqual(evenShares());
	});
});
