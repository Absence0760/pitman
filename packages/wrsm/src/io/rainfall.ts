/**
 * Catchment rainfall files (.RAN): monthly rainfall as % of MAP, one row per
 * hydrological year (docs/formats.md §10.2; TT 689 §2.3.3 p.7).
 *
 * Fixed columns: code `A7` (1–7), year `I4` (8–11), then 12 fields of 7
 * columns, October first. WRSM2000 writes them `F7.2`; we read each field
 * as `F7.0` (an explicit point wins, a bare integer is whole per cent), the
 * descriptor TT 689 gives for flow files (U-23 below). Blank lines after the
 * data are allowed and kept; a gap in the years is an error.
 *
 * U-23 (proposed): TT 689 gives no Fortran format for rainfiles. One
 * hand-made reference file writes some values without a point (`     12`);
 * under `F7.2` WRSM2000 would read that as 0.12 %, under `F7.0` as 12 %.
 * We read `F7.0` until the reference comparison says otherwise.
 */

import type { Monthly12, MonthlyRow, MonthlySeries, RainfallSeries, SeriesSource } from '../types.js';
import { formatF, formatI, readFortranInteger, readFortranReal, rewriteRows, sameMonths, type SourceRows } from './series.js';
import { WrsmParseError, splitLines } from './tokens.js';

/** Read a .RAN file. Errors name the file, line, column and field. */
export function readRainfall(text: string, fileName: string): RainfallSeries {
	const split = splitLines(text);
	const source: SeriesSource = { lines: split.lines, finalNewline: split.finalNewline };
	const { code, rows } = parseRows(source, fileName);
	return { code, rows: rows.rows, source };
}

function parseRows(source: SeriesSource, fileName: string): { code: string; rows: SourceRows<MonthlyRow> } {
	const rows: MonthlyRow[] = [];
	const lineIndex: number[] = [];
	let code: string | undefined;
	let ended = -1;
	source.lines.forEach((line, i) => {
		const at = (column: number, field: string) => ({ file: fileName, line: i + 1, column, field });
		if (line.trim() === '') {
			if (rows.length > 0 && ended < 0) ended = i;
			return;
		}
		if (ended >= 0) {
			throw new WrsmParseError(`data after the blank line at line ${ended + 1}`, at(1, 'code'));
		}
		if (line.length < 11) throw new WrsmParseError('line too short: expected code (A7) and year (I4)', at(1, 'year'));
		const rowCode = line.slice(0, 7).trim();
		if (code === undefined) code = rowCode;
		else if (rowCode !== code) {
			throw new WrsmParseError(`code '${rowCode}' differs from '${code}' on the first row`, at(1, 'code'));
		}
		const year = readFortranInteger(line.slice(7, 11), at(8, 'year'));
		const previous = rows[rows.length - 1];
		if (previous !== undefined && year !== previous.year + 1) {
			throw new WrsmParseError(`year ${year} follows ${previous.year}: years must ascend without gaps`, at(8, 'year'));
		}
		const months: number[] = [];
		for (let k = 0; k < 12; k++) {
			const start = 11 + 7 * k;
			months.push(readFortranReal(line.slice(start, start + 7), 0, at(start + 1, `month ${k + 1}`)));
		}
		rows.push({ year, months: months as unknown as Monthly12 });
		lineIndex.push(i);
	});
	if (code === undefined) throw new WrsmParseError('no data rows', { file: fileName, line: 1 });
	return { code, rows: { rows, lineIndex } };
}

/**
 * Write a .RAN file: `A7,I4,12F7.2`, 95 columns, CRLF (§10.2). Rows read
 * from a file and not changed since are copied from it byte for byte.
 */
export function writeRainfall(series: RainfallSeries): string {
	if (series.code.length > 7) throw new RangeError(`code '${series.code}' is longer than 7 characters (A7)`);
	const code = series.code.padEnd(7);
	const format = (row: MonthlyRow) =>
		code +
		formatI(row.year, 4, 'year') +
		row.months.map((v, k) => formatF(v, 7, 2, `year ${row.year} month ${k + 1}`)).join('');
	const source = series.source;
	// A changed code invalidates every source row.
	const usable = source !== undefined && parseRows(source, 'source').code === series.code ? source : undefined;
	return rewriteRows(
		series.rows,
		usable,
		(s) => parseRows(s, 'source').rows,
		(a, b) => a.year === b.year && sameMonths(a.months, b.months),
		format,
		{ canonical: () => [], changed: (s, end) => s.lines.slice(end) }
	);
}

/** The rows as the engine's contiguous series, in % of MAP. */
export function rainfallToSeries(series: RainfallSeries): MonthlySeries {
	const first = series.rows[0];
	if (first === undefined) throw new RangeError(`rainfall '${series.code}' has no rows`);
	return { startYear: first.year, values: series.rows.flatMap((row) => row.months), unit: 'percentMap' };
}
