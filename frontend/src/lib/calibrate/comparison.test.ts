import { run, type NetworkBundle, type RunoffModule } from '@pitman/wrsm';
import { describe, expect, it } from 'vitest';
import { syntheticBundle } from '#lib/network/synthetic.js';
import { targetCharts } from '#lib/results/charts.js';
import { statisticsTable } from '#lib/results/statistics-table.js';
import { withModule } from './apply.js';
import { calibrationTargets } from './candidates.js';
import { AFTER_LABEL, BEFORE_LABEL, CURRENT_LABEL, compactTable, compareRuns, fitSummary } from './comparison.js';

const bundle = syntheticBundle({ startYear: 1990, years: 12 });
const module = bundle.modules.find((m) => m.kind === 'RU' && m.number === 1) as RunoffModule;
const edited = withModule(bundle, { ...module, pitman: { ...module.pitman, ST: module.pitman.ST + 150 } });
const before = run(bundle, { kind: 'historical' });
const after = run(edited, { kind: 'historical' });
const gauged = calibrationTargets(bundle, 1, [before])[0]!;

function ungauged(): { bundle: NetworkBundle; target: (typeof gauged) } {
	const b = { ...bundle, network: { ...bundle.network, gauges: [] } };
	return { bundle: b, target: calibrationTargets(b, 1, [before])[0]! };
}

describe('compareRuns', () => {
	it('names the two runs apart', () => {
		expect(compareRuns(gauged, before, after).runs.map((r) => r.label)).toEqual([BEFORE_LABEL, AFTER_LABEL]);
	});

	it('shows one run with nothing to compare', () => {
		expect(compareRuns(gauged, before, undefined).runs.map((r) => r.label)).toEqual([CURRENT_LABEL]);
	});

	it('carries the labels into the fit table and the charts', () => {
		const analysis = compareRuns(gauged, before, after);
		expect(statisticsTable(analysis)?.columns).toContain(`${AFTER_LABEL} simulated`);
		const monthly = targetCharts(analysis).find((c) => c.id === 'monthly');
		expect(monthly?.lines.map((l) => l.label)).toEqual([BEFORE_LABEL, AFTER_LABEL, 'Observed']);
	});

	it('passes the period through', () => {
		const analysis = compareRuns(gauged, before, after, { startYear: 1992, endYear: 1995 });
		expect(analysis.period).toEqual({ startYear: 1992, endYear: 1995 });
	});

	it('keeps the months October first on the mean monthly chart', () => {
		const chart = targetCharts(compareRuns(gauged, before, after)).find((c) => c.id === 'mean-monthly');
		expect(chart?.xLabel).toContain('October first');
	});
});

describe('compactTable', () => {
	it('at a gauge folds each run’s value and error into one cell, under the observed value', () => {
		const analysis = compareRuns(gauged, before, after);
		const table = statisticsTable(analysis)!;
		const compact = compactTable(table, [BEFORE_LABEL, AFTER_LABEL]);
		expect(compact.columns).toEqual(['Observed', BEFORE_LABEL, AFTER_LABEL]);
		const wide = table.rows.find((r) => r.key === 'marMm3')!;
		const mar = compact.rows.find((r) => r.key === 'marMm3')!;
		expect(mar.observed).toBe(wide.cells[0]?.text);
		expect(mar.runs[0]?.value).toBe(wide.cells[1]?.text);
		expect(mar.runs[0]?.error?.replaceAll(' ', ' ')).toBe(wide.cells[2]?.text);
		expect(mar.runs[1]?.value).toBe(wide.cells[3]?.text);
		expect(mar.runs[1]?.error?.replaceAll(' ', ' ')).toBe(wide.cells[4]?.text);
	});

	it('flags an error outside its guideline, as the word and the flag', () => {
		const compact = compactTable(statisticsTable(compareRuns(gauged, before, after))!, [BEFORE_LABEL, AFTER_LABEL]);
		for (const row of compact.rows) {
			for (const cell of row.runs) {
				if (cell.error !== undefined) expect(cell.outside).toBe(cell.error.includes('outside'));
			}
		}
	});

	it('has no error for the rows that take none', () => {
		const compact = compactTable(statisticsTable(compareRuns(gauged, before, after))!, [BEFORE_LABEL, AFTER_LABEL]);
		expect(compact.rows.find((r) => r.key === 'years')?.runs[0]?.error).toBeUndefined();
	});

	it('without a gauge has one column per run and no observed value', () => {
		const { target } = ungauged();
		const compact = compactTable(statisticsTable(compareRuns(target, before, after))!, [BEFORE_LABEL, AFTER_LABEL]);
		expect(compact.columns).toEqual([BEFORE_LABEL, AFTER_LABEL]);
		const mar = compact.rows.find((r) => r.key === 'marMm3')!;
		expect(mar.observed).toBeUndefined();
		expect(mar.runs).toHaveLength(2);
		expect(mar.runs[0]?.error).toBeUndefined();
	});
});

describe('fitSummary', () => {
	it('says the MAR before and after, and the change', () => {
		const summary = fitSummary(compareRuns(gauged, before, after))!;
		expect(summary.mar).toMatch(/^[\d.]+ → [\d.]+ million m³\/year$/);
		expect(summary.marChange).toMatch(/^[+-]?[\d.]+ %$/);
	});

	it('counts the statistics within the guidelines, per run', () => {
		const summary = fitSummary(compareRuns(gauged, before, after))!;
		expect(summary.withinGuidelines).toHaveLength(2);
		for (const count of summary.withinGuidelines ?? []) expect(count).toMatch(/^[0-5] of 5$/);
	});

	it('has one value and no change with nothing to compare', () => {
		const summary = fitSummary(compareRuns(gauged, before, undefined))!;
		expect(summary.marChange).toBeNull();
		expect(summary.mar).not.toContain('→');
	});

	it('still compares without a gauge, with no guideline count', () => {
		const { target } = ungauged();
		const summary = fitSummary(compareRuns(target, before, after))!;
		expect(summary.withinGuidelines).toBeNull();
		expect(summary.marChange).not.toBeNull();
	});
});
