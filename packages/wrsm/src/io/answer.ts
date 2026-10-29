/**
 * Answer files (.ANS) as WRSM2000 writes them (docs/formats.md §11.2;
 * TT 689 §4.5): `<net>RQ<route>.ANS` (route flow) or `<net>RV<n>.ANS`
 * (reservoir storage), million m³.
 *
 * | Row | Format | Content |
 * |---|---|---|
 * | one per year | `4X,I4,12F8.2,F10.2,F10.2` (124 columns) | year, 12 months, annual total, monthly mean |
 * | separator | two blanks | |
 * | footer | `' AVERAGE',12F8.2,F10.2,F10.2` | the mean of each column |
 *
 * How WRSM2000 computes the totals, checked against every reference .ANS
 * and .MTS (531 files, 47,785 rows): every column is computed from the
 * **unrounded** values and only rounded when printed.
 * - The annual total is the sum of the unrounded months: it differs from
 *   the sum of the printed months by more than 0.005 in about half the rows,
 *   but never by more than 12 × 0.005 + 0.005.
 * - The monthly mean is the unrounded annual / 12: in 3.3 % of rows it is
 *   not the printed annual / 12 rounded, yet it always lies within the
 *   rounding interval of the printed annual / 12.
 * - Each AVERAGE column is within 0.0063 of the mean of the printed column,
 *   so it too is the mean of unrounded values.
 * So `answerFromSeries` keeps float32 values unrounded and `writeAnswer`
 * rounds each one once (float32, half away from zero; §2, U-18).
 *
 * U-20: no reservoir-storage (`RV`) answer file exists in the reference set,
 * so its annual column is unknown. We write the sum, as for flows.
 */

import type { AnswerFile, AnswerRow, Monthly12, MonthlySeries } from '../types.js';
import { baseName, formatF, formatI, joinLines, readFortranReal, type FieldAt } from './series.js';
import { WrsmParseError, splitLines } from './tokens.js';

/** The two-blank separator line before the AVERAGE footer. */
export const ANSWER_SEPARATOR = '  ';

const AVERAGE_LABEL = ' AVERAGE';

/** `12F8.2,F10.2,F10.2`: the columns after the year or the AVERAGE label. */
export function formatAnswerColumns(months: Monthly12, annualTotal: number, monthlyMean: number, what: string): string {
	return (
		months.map((v, k) => formatF(v, 8, 2, `${what} month ${k + 1}`)).join('') +
		formatF(annualTotal, 10, 2, `${what} annual`) +
		formatF(monthlyMean, 10, 2, `${what} mean`)
	);
}

/** One year row: `4X,I4,12F8.2,F10.2,F10.2`. */
export function formatAnswerRow(row: AnswerRow): string {
	return `    ${formatI(row.year, 4, 'year')}${formatAnswerColumns(row.months, row.annualTotal, row.monthlyMean, `year ${row.year}`)}`;
}

/**
 * A year's annual total and mean the way WRSM2000 computes them: a float32
 * running sum of the unrounded months, then / 12.
 */
export function answerRow(year: number, months: readonly number[]): AnswerRow {
	const m = months.map((v) => Math.fround(v)) as unknown as Monthly12;
	let annual = 0;
	for (const v of m) annual = Math.fround(annual + v);
	return { year, months: m, annualTotal: annual, monthlyMean: Math.fround(annual / 12) };
}

/** The AVERAGE footer: the float32 mean of each of the 14 columns over the years. */
export function answerAverage(rows: readonly AnswerRow[]): AnswerFile['average'] {
	const sums = new Array<number>(14).fill(0);
	for (const row of rows) {
		row.months.forEach((v, k) => (sums[k] = Math.fround((sums[k] ?? 0) + v)));
		sums[12] = Math.fround((sums[12] ?? 0) + row.annualTotal);
		sums[13] = Math.fround((sums[13] ?? 0) + row.monthlyMean);
	}
	const mean = sums.map((s) => (rows.length === 0 ? 0 : Math.fround(s / rows.length)));
	return {
		months: mean.slice(0, 12) as unknown as Monthly12,
		annualTotal: mean[12] ?? 0,
		monthlyMean: mean[13] ?? 0
	};
}

/**
 * Build an answer file from a simulated series, computing the annual,
 * mean and AVERAGE columns exactly as WRSM2000 does (see the file header).
 */
export function answerFromSeries(kind: 'RQ' | 'RV', number: number, series: MonthlySeries): AnswerFile {
	if (series.values.length === 0 || series.values.length % 12 !== 0) {
		throw new RangeError(`series length ${series.values.length} is not a positive multiple of 12`);
	}
	const rows: AnswerRow[] = [];
	for (let i = 0; i * 12 < series.values.length; i++) {
		rows.push(answerRow(series.startYear + i, series.values.slice(12 * i, 12 * i + 12)));
	}
	return { kind, number, rows, average: answerAverage(rows) };
}

/** `RQ` or `RV` and the number from a name such as `SYRQ9.ANS` (TT 689 §2.3.4). */
function kindFromName(fileName: string): { kind: 'RQ' | 'RV'; number: number } {
	const m = /^[A-Za-z0-9]{1,3}?(RQ|RV)(\d+)/i.exec(baseName(fileName));
	if (m === null) {
		throw new WrsmParseError("file name is not '<net>RQ<route>' or '<net>RV<n>'", { file: fileName, line: 1 });
	}
	return { kind: (m[1] as string).toUpperCase() as 'RQ' | 'RV', number: Number(m[2]) };
}

function readColumns(line: string, at: (column: number, field: string) => FieldAt) {
	const value = (start: number, width: number, field: string) => {
		const text = line.slice(start, start + width);
		if (text.trim() === '') throw new WrsmParseError(`missing ${field}`, at(start + 1, field));
		return readFortranReal(text, 2, at(start + 1, field));
	};
	const months: number[] = [];
	for (let k = 0; k < 12; k++) months.push(value(8 + 8 * k, 8, `month ${k + 1}`));
	return {
		months: months as unknown as Monthly12,
		annualTotal: value(104, 10, 'annual'),
		monthlyMean: value(114, 10, 'mean')
	};
}

/**
 * Read an answer file in WRSM2000's layout. The kind and number come from
 * the file name. Errors name the file, line, column and field.
 */
export function readAnswer(text: string, fileName: string): AnswerFile {
	const { kind, number } = kindFromName(fileName);
	const lines = splitLines(text).lines;
	const rows: AnswerRow[] = [];
	let i = 0;
	for (; i < lines.length; i++) {
		const line = lines[i] as string;
		if (line.trim() === '') break;
		const at = (column: number, field: string): FieldAt => ({ file: fileName, line: i + 1, column, field });
		if (!/^ {4}[ 0-9]{3}[0-9]$/.test(line.slice(0, 8))) {
			throw new WrsmParseError(`expected a year row ('    YYYY'), found '${line.slice(0, 40)}'`, at(1, 'year'));
		}
		const year = Number(line.slice(4, 8));
		const previous = rows[rows.length - 1];
		if (previous !== undefined && year !== previous.year + 1) {
			throw new WrsmParseError(`year ${year} follows ${previous.year}: years must ascend without gaps`, at(5, 'year'));
		}
		rows.push({ year, ...readColumns(line, at) });
	}
	if (rows.length === 0) throw new WrsmParseError('no year rows', { file: fileName, line: 1 });
	const footerIndex = i + 1;
	const footer = lines[footerIndex];
	if (footer === undefined || !footer.startsWith(AVERAGE_LABEL)) {
		throw new WrsmParseError(`expected the '${AVERAGE_LABEL.trim()}' footer after the separator`, {
			file: fileName,
			line: footerIndex + 1,
			column: 1,
			field: 'AVERAGE'
		});
	}
	const average = readColumns(footer, (column, field) => ({ file: fileName, line: footerIndex + 1, column, field: `AVERAGE ${field}` }));
	const extra = lines.findIndex((line, j) => j > footerIndex && line.trim() !== '');
	if (extra >= 0) {
		throw new WrsmParseError('unexpected text after the AVERAGE footer', { file: fileName, line: extra + 1, column: 1 });
	}
	return { kind, number, rows, average };
}

/** Write an answer file in WRSM2000's layout, CRLF throughout and at the end. */
export function writeAnswer(file: AnswerFile): string {
	const a = file.average;
	return joinLines([
		...file.rows.map(formatAnswerRow),
		ANSWER_SEPARATOR,
		AVERAGE_LABEL + formatAnswerColumns(a.months, a.annualTotal, a.monthlyMean, 'AVERAGE')
	]);
}
