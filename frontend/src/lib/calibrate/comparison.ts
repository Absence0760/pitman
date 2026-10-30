/**
 * Before and after the edits at one route, through the results screen's own
 * code: `analyseTarget`, `statisticsTable` and the chart descriptions, with
 * the two runs relabelled (both are historical runs, which would otherwise
 * read the same). The compact rows put each run's value and error in one cell,
 * so the fit table stays beside the parameters.
 */

import type { RunResult } from '@pitman/wrsm';
import { analyseTarget, type StatisticsOptions, type TargetAnalysis } from '#lib/results/analysis.js';
import { ANNUAL_FLOW_UNIT, formatNumber } from '#lib/results/format.js';
import { statisticsTable, type StatisticsRow, type StatisticsTable } from '#lib/results/statistics-table.js';
import type { ResultTarget } from '#lib/results/targets.js';

export const BEFORE_LABEL = 'Before';
export const AFTER_LABEL = 'With edits';
/** Shown alone while there's nothing to compare. */
export const CURRENT_LABEL = 'Current values';

/** The analysis of the run before the edits and, when there are edits, the run with them. */
export function compareRuns(target: ResultTarget, before: RunResult, after: RunResult | undefined, options: StatisticsOptions = {}): TargetAnalysis {
	const analysis = analyseTarget(target, after ? [before, after] : [before], options);
	const labels = after ? [BEFORE_LABEL, AFTER_LABEL] : [CURRENT_LABEL];
	return { ...analysis, runs: analysis.runs.map((run, i) => ({ ...run, label: labels[i] ?? run.label })) };
}

export interface CompactCell {
	readonly value: string;
	/** `+3.1 % (within 4 %)`, at a gauge. */
	readonly error?: string;
	readonly outside?: boolean;
}

export interface CompactRow {
	readonly key: StatisticsRow['key'];
	readonly label: string;
	readonly unit: string;
	readonly observed?: string;
	readonly runs: readonly CompactCell[];
}

export interface CompactTable {
	readonly caption: string;
	/** Column heads after the statistic's: `Observed`, then each run. */
	readonly columns: readonly string[];
	readonly rows: readonly CompactRow[];
	readonly notes: readonly string[];
}

/** The statistics table with each run's value and error folded into one column. */
export function compactTable(table: StatisticsTable, runLabels: readonly string[]): CompactTable {
	// Statistic, Unit, then Observed, simulated, error … at a gauge; one column per run without one.
	const gauged = table.columns.includes('Observed');
	const rows = table.rows.map((row): CompactRow => {
		const cells = row.cells;
		const runs = runLabels.map((_, i): CompactCell => {
			if (!gauged) return { value: cells[i]?.text ?? '—' };
			const value = cells[1 + 2 * i]?.text ?? '—';
			const error = cells[2 + 2 * i];
			if (error === undefined || error.text === '') return { value };
			// In a narrow column the verdict stays whole: `+3.1 %` over `(within 4 %)`.
			const text = error.text.replace(/\(.*\)/, (verdict) => verdict.replaceAll(' ', ' '));
			return { value, error: text, outside: error.verdict === 'outside' };
		});
		return { key: row.key, label: row.label, unit: row.unit, ...(gauged ? { observed: cells[0]?.text ?? '—' } : {}), runs };
	});
	return { caption: table.caption, columns: gauged ? ['Observed', ...runLabels] : [...runLabels], rows, notes: table.notes };
}

/** The first thing the screen says: what the edits did to the flow, and to the fit. */
export interface FitSummary {
	readonly mar: string;
	/** The change in MAR, with the edits; `null` when there's nothing to compare. */
	readonly marChange: string | null;
	/** How many of the five statistics meet the TT 689 p.177 guidelines, per run; `null` without a gauge. */
	readonly withinGuidelines: readonly string[] | null;
}

function withinCount(table: StatisticsTable, run: number): string {
	const five = table.rows.filter((r) => r.key !== 'years' && r.key !== 'cv');
	const within = five.filter((r) => r.cells[2 + 2 * run]?.verdict === 'within').length;
	return `${within} of ${five.length}`;
}

export function fitSummary(analysis: TargetAnalysis): FitSummary | null {
	const table = statisticsTable(analysis);
	const first = analysis.runs[0]?.statistics;
	if (!table || !first) return null;
	const last = analysis.runs[1]?.statistics;
	const gauged = analysis.runs.some((r) => r.gauge !== null);
	const change = last && first.marMm3 !== 0 ? ((last.marMm3 - first.marMm3) / Math.abs(first.marMm3)) * 100 : null;
	return {
		mar: `${last ? `${formatNumber(first.marMm3, 2)} → ${formatNumber(last.marMm3, 2)}` : formatNumber(first.marMm3, 2)} ${ANNUAL_FLOW_UNIT}`,
		marChange: change === null ? null : `${change > 0 ? '+' : ''}${formatNumber(change, 1)} %`,
		withinGuidelines: gauged ? analysis.runs.map((_, i) => withinCount(table, i)) : null
	};
}
