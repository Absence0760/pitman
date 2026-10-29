import { describe, expect, it } from 'vitest';
import { analyseTarget } from './analysis.js';
import { bundle, natural, presentDay } from './fixtures.js';
import { statisticsTable } from './statistics-table.js';
import { resultTargets, type ResultTarget } from './targets.js';

const targets = resultTargets(bundle, [presentDay, natural]).flatMap((g) => g.targets);
const byId = (id: string) => targets.find((t) => t.id === id) as ResultTarget;

describe('statisticsTable', () => {
	it('shows observed, each run and its error against the TT 689 p.177 guideline', () => {
		const t = statisticsTable(analyseTarget(byId('route-3'), [presentDay, natural]))!;
		expect(t.columns).toEqual([
			'Statistic',
			'Unit',
			'Observed',
			'Present day (2025) simulated',
			'Present day (2025) error vs observed',
			'Natural simulated',
			'Natural error vs observed'
		]);
		expect(t.rows.map((r) => r.label)).toEqual([
			'Years used',
			'MAR',
			'Mean (log)',
			'Standard deviation',
			'Log standard deviation',
			'Seasonal index',
			'Coefficient of variation'
		]);
		const mar = t.rows.find((r) => r.key === 'marMm3')!;
		expect(mar.unit).toBe('million m³/year');
		expect(mar.cells.map((c) => c.text)).toEqual(['48.00', '48.66', '+1.4 % (within 4 %)', '72.99', '+52.1 % (outside 4 %)']);
		expect(mar.cells[2]?.verdict).toBe('within');
		expect(mar.cells[4]?.verdict).toBe('outside');
		expect(t.rows[0]?.cells.map((c) => c.text)).toEqual(['2', '2', '', '2', '']);
		expect(t.notes[0]).toContain('same 2 complete hydrological years between 2000/01 and 2002/03');
		expect(t.notes.some((n) => n.includes('1 missing observed months'))).toBe(true);
	});

	it('counts incomplete months left out', () => {
		const t = statisticsTable(analyseTarget(byId('route-3'), [presentDay], { includeIncomplete: false }))!;
		expect(t.notes.some((n) => n.includes('1 incomplete observed months (+) are left out'))).toBe(true);
	});

	it('says when no observed year is complete', () => {
		const t = statisticsTable(analyseTarget(byId('route-3'), [presentDay], { startYear: 2001, endYear: 2001 }))!;
		expect(t.notes).toContain('No observed year in this period is complete, so there are no annual statistics.');
		expect(t.rows.find((r) => r.key === 'marMm3')?.cells.map((c) => c.text)).toEqual(['—', '—', '—']);
	});

	it('shows only simulated columns without a gauge, and nothing for a reservoir', () => {
		const t = statisticsTable(analyseTarget(byId('route-1'), [presentDay, natural]))!;
		expect(t.columns).toEqual(['Statistic', 'Unit', 'Present day (2025)', 'Natural']);
		expect(t.notes[0]).toBe('Statistics of the simulated flows over hydrological years 2000/01 to 2002/03.');
		expect(statisticsTable(analyseTarget(byId('reservoir-2'), [presentDay]))).toBeNull();
	});
});
