/**
 * Defined-flow and demand files: any file an RV or CR route line names
 * (`.abs`, `.prn`, `.IRR`, `.DEF`, `.URB`, `.IND`, `.obs`, an `.ANS` from
 * another network, …), and WRSM2000's own `.DEM` output (docs/formats.md
 * §11.3, §11.6, §12). Million m³ per month.
 *
 * Read with WRSM2000's fixed columns `(4X,I4,1X,12(F7.0,1A))` (§11.1):
 * flags and everything past column 105 are ignored, so `hasTotals` only
 * records whether something is written there. The first non-data line ends
 * the data; `hasAverage` records an AVERAGE footer. A gap in the years is
 * an error (TT 689 p.150: a defined flow must cover the simulation period).
 *
 * Writers use `4X,I4,12F8.2` (104 columns, §11.3; `F8.3` when `decimals` is 3,
 * which the fixed-column read takes as it is: the point in the field wins), or the full .ANS layout
 * when `hasTotals` is set, with an AVERAGE footer when `hasAverage` is set.
 * Rows read from a file and unchanged since are copied from `source`.
 */

import type { DemandSeries, MonthlyRow, SeriesSource } from '../types.js';
import { ANSWER_SEPARATOR, answerAverage, answerRow, formatAnswerColumns, formatAnswerRow } from './answer.js';
import { formatF, formatI, readFlowLines, rewriteRows, sameMonths, type SourceRows } from './series.js';

function parse(text: string, fileName: string) {
	const read = readFlowLines(text, fileName, false);
	const rows: MonthlyRow[] = read.rows.map((line) => ({ year: line.year, months: line.months }));
	const hasTotals = read.rows.some((line) => line.rest.trim() !== '');
	const hasAverage = read.source.lines.slice(read.end).some((line) => line.trimStart().startsWith('AVERAGE'));
	return { read, rows, hasTotals, hasAverage };
}

function reread(source: SeriesSource, fileName: string): SourceRows<MonthlyRow> {
	const { read, rows } = parse(source.lines.join('\n') + (source.finalNewline ? '\n' : ''), fileName);
	return { rows, lineIndex: read.rows.map((line) => line.index) };
}

/** Read a defined-flow or demand file. Errors name the file, line, column and field. */
export function readDemand(text: string, fileName: string): DemandSeries {
	const { read, rows, hasTotals, hasAverage } = parse(text, fileName);
	return { fileName, rows, hasTotals, hasAverage, source: read.source };
}

/** The decimals a file read back holds: a changed row must keep them, or 0.026 would be saved as 0.03. */
function decimalsOf(series: DemandSeries): 2 | 3 {
	if (series.decimals !== undefined) return series.decimals;
	return series.source?.lines.some((line) => /^ {4}\d{4} +-?\d*\.\d{3}(\s|$)/.test(line)) ? 3 : 2;
}

/** Write a defined-flow or demand file (see the file header for the layout). */
export function writeDemand(series: DemandSeries): string {
	const decimals = decimalsOf(series);
	const format = (row: MonthlyRow) =>
		series.hasTotals
			? formatAnswerRow(answerRow(row.year, row.months))
			: `    ${formatI(row.year, 4, `${series.fileName} year`)}` +
				row.months.map((v, k) => ' ' + formatF(v, 7, decimals, `${series.fileName} year ${row.year} month ${k + 1}`)).join('');
	const footer = (): string[] => {
		if (!series.hasAverage) return [];
		const a = answerAverage(series.rows.map((row) => answerRow(row.year, row.months)));
		return [ANSWER_SEPARATOR, ' AVERAGE' + formatAnswerColumns(a.months, a.annualTotal, a.monthlyMean, 'AVERAGE')];
	};
	return rewriteRows(
		series.rows,
		series.source,
		(s) => reread(s, series.fileName),
		(a, b) => a.year === b.year && sameMonths(a.months, b.months),
		format,
		{
			canonical: footer,
			// Changed rows invalidate an AVERAGE footer; other trailing lines are kept.
			changed: (s, end) => (series.hasAverage ? footer() : s.lines.slice(end))
		}
	);
}
