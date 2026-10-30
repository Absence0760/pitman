import { yearTableValue } from '@pitman/wrsm';
import { describe, expect, it } from 'vitest';
import { readingOf, seriesChart, seriesDataTable } from './chart.js';
import { landUseBundle, runoff } from './fixtures.test-helper.js';
import { tableRows } from './review.js';

const free = runoff(landUseBundle(), 1);
const run = { startYear: 1980, endYear: 2009 };
const chart = (draft?: Parameters<typeof tableRows>[2]) => {
	const rows = tableRows(free, 'afforestation', draft, undefined);
	return { rows, spec: seriesChart('c', 'afforestation', 'Afforestation', 'Afforested area, km²', rows, run) };
};

describe('seriesChart', () => {
	it('covers the run and every listed year, one point a year', () => {
		const { spec } = chart({ 2025: { text: '14.5', note: '' } });
		expect(spec?.x[0]).toBe(1980);
		expect(spec?.x.at(-1)).toBe(2025);
		expect(spec?.x).toHaveLength(46);
	});

	it('draws what the engine reads', () => {
		const { spec } = chart();
		const at = (year: number) => spec?.file[spec.x.indexOf(year)];
		expect(at(1980)).toBe(4.5);
		expect(at(1997)).toBeCloseTo(yearTableValue(free.afforestation.areaKm2, 1997), 12);
		expect(at(2009)).toBe(10);
	});

	it('has one line until something differs from the file', () => {
		const { spec } = chart();
		expect(spec?.edited).toBeNull();
		expect(spec?.editedMarks.every((m) => m === null)).toBe(true);
		expect(spec?.fileMarks.filter((m) => m !== null)).toEqual([4.5, 10]);
	});

	it('adds the edited line, with a mark on each edited year and none on the others', () => {
		const { spec } = chart({ 2004: { text: '12', note: '' }, 2025: { text: '14.5', note: '' } });
		expect(spec?.edited?.[spec.x.indexOf(2009)]).toBeCloseTo(12 + (2.5 * 5) / 21, 12);
		expect(spec?.file[spec.x.indexOf(2025)]).toBe(10);
		expect(spec?.x.filter((_, i) => spec.editedMarks[i] !== null)).toEqual([2004, 2025]);
	});

	it('shows an applied edit against the file, not the working copy', () => {
		const rows = tableRows(free, 'afforestation', undefined, {
			schema: 'pitman-sidecar',
			schemaVersion: 1,
			values: [{ target: { module: { type: 'RU', number: 1 }, field: 'afforestation.areaKm2', year: 2004 }, source: { kind: 'manual', note: 'Land use: 8 → 10; Survey' } }]
		});
		const spec = seriesChart('c', 'afforestation', 'A', 'y', rows, run);
		expect(spec?.file[spec.x.indexOf(2004)]).toBe(8);
		expect(spec?.edited?.[spec.x.indexOf(2004)]).toBe(10);
	});

	it('leaves a refused value out of the line', () => {
		expect(chart({ 2004: { text: '1.25', note: '' } }).spec?.edited).toBeNull();
	});

	it('has nothing to draw for an empty table', () => {
		expect(seriesChart('c', 'afforestation', 'A', 'y', [], run)).toBeNull();
	});
});

describe('readingOf', () => {
	const table = [{ year: 1990, value: 1 }, { year: 2000, value: 2 }];

	it('says how a run gets each year', () => {
		expect(readingOf(table, 1990)).toBe('listed');
		expect(readingOf(table, 1995)).toBe('straight line');
		expect(readingOf(table, 1980)).toBe('held flat');
		expect(readingOf(table, 2005)).toBe('held flat');
		expect(readingOf([], 2005)).toBe('held flat');
	});
});

describe('seriesDataTable', () => {
	it('gives every year in words', () => {
		const { spec, rows } = chart();
		const table = seriesDataTable(spec!, rows);
		expect(table.columns).toEqual(['Year', 'In the network file', 'How a run reads it']);
		expect(table.rows).toHaveLength(30);
		expect(table.rows[10]).toEqual(['1990', '4.5', 'listed']);
	});

	it('adds the edited column once there is one', () => {
		const { spec, rows } = chart({ 2004: { text: '12', note: '' } });
		const table = seriesDataTable(spec!, rows);
		expect(table.columns).toContain('With your edits');
		expect(table.rows.find((r) => r[0] === '2004')).toEqual(['2004', '10.0', '12.0', 'listed']);
	});
});
