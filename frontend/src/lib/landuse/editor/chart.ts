/**
 * The chart beside a year table: the series as a run reads it, year by year,
 * with `yearTableValue`, the engine's own lookup, so the line drawn is the
 * line used (OQ-17): straight between listed years, flat beyond them. Two lines
 * once anything differs from the file; listed years are round dots, and years
 * that differ from the file are hollow diamonds, so the edits show without colour.
 */

import { yearTableValue, type LandUseTable, type YearTable } from '@pitman/wrsm';
import type { RowView } from './review.js';
import { formatCell, targetTable } from './review.js';

export interface SeriesChartSpec {
	readonly id: string;
	readonly table: LandUseTable;
	readonly title: string;
	readonly yLabel: string;
	readonly x: readonly number[];
	/** The file's series, every year. */
	readonly file: readonly number[];
	/** The series with the edits, every year; `null` while it equals the file's. */
	readonly edited: readonly number[] | null;
	/** A dot at each year the file lists. */
	readonly fileMarks: readonly (number | null)[];
	/** A diamond at each year whose value differs from the file. */
	readonly editedMarks: readonly (number | null)[];
}

export const X_LABEL = 'Hydrological year';

const fileTable = (rows: readonly RowView[]): YearTable => rows.flatMap((r) => (r.file === null ? [] : [{ year: r.year, value: r.file }]));

/** `null` when the table has no rows: there is no series to draw. */
export function seriesChart(id: string, table: LandUseTable, title: string, yLabel: string, rows: readonly RowView[], run: { readonly startYear: number; readonly endYear: number }): SeriesChartSpec | null {
	const file = fileTable(rows);
	const next = targetTable(rows);
	const years = [...file, ...next].map((r) => r.year);
	if (years.length === 0) return null;
	const from = Math.min(run.startYear, ...years);
	const to = Math.max(run.endYear, ...years);
	const x = Array.from({ length: to - from + 1 }, (_, i) => from + i);
	const differs = rows.some((r) => r.target !== r.file);
	const fileValue = new Map(file.map((r) => [r.year, r.value]));
	const edits = new Map(next.filter((r) => r.value !== fileValue.get(r.year)).map((r) => [r.year, r.value]));
	return {
		id,
		table,
		title,
		yLabel,
		x,
		file: x.map((y) => yearTableValue(file, y)),
		edited: differs ? x.map((y) => yearTableValue(next, y)) : null,
		fileMarks: x.map((y) => fileValue.get(y) ?? null),
		editedMarks: x.map((y) => edits.get(y) ?? null)
	};
}

export type Reading = 'listed' | 'straight line' | 'held flat';

/** How `yearTableValue` gets a year's value from the table. */
export function readingOf(table: YearTable, year: number): Reading {
	if (table.some((r) => r.year === year)) return 'listed';
	const first = table[0];
	const last = table.at(-1);
	return !first || !last || year < first.year || year > last.year ? 'held flat' : 'straight line';
}

export interface SeriesDataTable {
	readonly caption: string;
	readonly columns: readonly string[];
	readonly rows: readonly (readonly string[])[];
}

/** Every year of the chart in words: the alternative to the canvas. */
export function seriesDataTable(spec: SeriesChartSpec, rows: readonly RowView[]): SeriesDataTable {
	const next = targetTable(rows);
	const columns = ['Year', 'In the network file', ...(spec.edited ? ['With your edits'] : []), 'How a run reads it'];
	return {
		caption: `${spec.title} every year. ${spec.yLabel}.`,
		columns,
		rows: spec.x.map((year, i) => [String(year), formatCell(spec.table, spec.file[i] ?? 0), ...(spec.edited ? [formatCell(spec.table, spec.edited[i] ?? 0)] : []), readingOf(next, year)])
	};
}
