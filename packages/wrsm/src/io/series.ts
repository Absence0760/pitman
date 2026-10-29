/**
 * Shared pieces of the monthly time-series readers and writers (.RAN, .obs,
 * .ANS, defined-flow and demand files; docs/formats.md §2 and §11):
 * - Fortran `Iw` / `Fw.d` output with WRSM2000's rounding (§2, U-18);
 * - Fortran `Fw.d` input of one fixed-column field;
 * - WRSM2000's fixed-column flow read `(4X,I4,1X,12(F7.0,1A))` (§11.1);
 * - the source-preserving rewrite: rows the caller has not changed are
 *   copied from the file they were read from, so a hand-made file saves
 *   back byte for byte (`SeriesSource` in types.ts).
 */

import type { Monthly12, MonthlyRow, SeriesSource } from '../types.js';
import { WrsmParseError, splitLines } from './tokens.js';

/** WRSM2000 writes CRLF after every line, the last one included (§1.1). */
export const CRLF = '\r\n';

/** Join lines with CRLF, ending with one unless `finalNewline` is false. */
export function joinLines(lines: readonly string[], finalNewline = true): string {
	if (lines.length === 0) return '';
	return lines.join(CRLF) + (finalNewline ? CRLF : '');
}

/**
 * Fortran `Iw`: an integer right-justified in `width` columns. Overflow is
 * an error, never asterisks (§2).
 */
export function formatI(n: number, width: number, field: string): string {
	if (!Number.isInteger(n)) throw new RangeError(`${field}: ${n} is not an integer`);
	const s = String(n);
	if (s.length > width) throw new RangeError(`${field}: ${n} does not fit I${width}`);
	return s.padStart(width);
}

/**
 * Fortran `Fw.d`. The value is taken to float32 first (WRSM2000's reals are
 * default REAL, TT 691 §7) and rounded half away from zero on that exact
 * value (§2, U-18): `toFixed` rounds the exact binary value and breaks ties
 * upward in magnitude. A leading `0` is kept for |x| < 1 and `-0.00` is
 * written `0.00`. Overflow is an error.
 */
export function formatF(x: number, width: number, decimals: number, field: string): string {
	if (!Number.isFinite(x)) throw new RangeError(`${field}: ${x} is not a finite number`);
	let s = Math.fround(x).toFixed(decimals);
	if (/^-0\.?0*$/.test(s)) s = s.slice(1);
	if (s.length > width) throw new RangeError(`${field}: ${x} does not fit F${width}.${decimals}`);
	return s.padStart(width);
}

// A Fortran real once blanks are removed: sign, digits with an optional
// point, an optional exponent (E, D, or a bare signed exponent).
const FORTRAN_REAL = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eEdD]([+-]?\d+)|([+-]\d+))?$/;

/** Where a fixed-column field sits, for error messages. */
export interface FieldAt {
	readonly file: string;
	/** 1-based line. */
	readonly line: number;
	/** 1-based first column of the field. */
	readonly column: number;
	readonly field: string;
}

/**
 * Read one fixed-column field as Fortran `Fw.d` input does: blanks are
 * ignored (BLANK='NULL', so an all-blank field is 0), an explicit decimal
 * point wins over `d`, and without one the last `d` digits are decimals.
 */
export function readFortranReal(text: string, decimals: number, at: FieldAt): number {
	const body = text.replace(/ /g, '');
	if (body === '') return 0;
	const m = FORTRAN_REAL.exec(body);
	if (m === null || (m[2] === '' && (m[3] ?? '') === '')) {
		throw new WrsmParseError(`expected a number, found '${text.trim().slice(0, 40)}'`, at);
	}
	const digits = m[2] || '0';
	const fraction = m[3];
	const exponent = Number(m[4] ?? m[5] ?? 0) - (fraction === undefined ? decimals : 0);
	const value = Number(`${digits}.${fraction || '0'}e${exponent}`);
	return m[1] === '-' ? -value : value;
}

/** Read an integer field (Fortran `Iw`, blanks ignored). */
export function readFortranInteger(text: string, at: FieldAt): number {
	const body = text.replace(/ /g, '');
	if (!/^[+-]?\d+$/.test(body)) throw new WrsmParseError(`expected an integer, found '${text.trim().slice(0, 40)}'`, at);
	return Number(body);
}

/** One data row of a flow-type file, as WRSM2000's fixed read sees it. */
export interface FlowLine {
	/** Columns 5–8. */
	readonly year: number;
	/** Columns 10–16 + 8k, read as `F7.0`. */
	readonly months: Monthly12;
	/** Column 17 + 8k: the flag character, `' '` when blank or past the end of the line. */
	readonly flags: readonly string[];
	/** Everything from column 106 on, which WRSM2000 ignores (annual totals, means). */
	readonly rest: string;
	/** 0-based index into the file's lines. */
	readonly index: number;
}

/** A flow-type file split into its data rows and the lines around them. */
export interface FlowRead {
	readonly source: SeriesSource;
	readonly rows: readonly FlowLine[];
	/** 0-based index of the first line after the last data row. */
	readonly end: number;
}

/** Columns 5–8 hold a year: the test that a line is a data row (§11.1). */
export function isFlowDataLine(line: string): boolean {
	return /^ *[0-9]+$/.test(line.slice(4, 8));
}

/**
 * WRSM2000's read of every flow-type file, `(4X,I4,1X,12(F7.0,1A))`
 * (TT 689 §2.3.4 p.8; docs/formats.md §11.1). Blank lines before the data
 * are skipped; any other text there is an error. The first line that is not
 * a data row ends the data (the .ANS separator and AVERAGE footer, trailing
 * blank lines), and a data row after that is an error. Years must ascend;
 * with `allowGaps` false they must also be contiguous.
 */
export function readFlowLines(text: string, fileName: string, allowGaps: boolean): FlowRead {
	const split = splitLines(text);
	const lines = split.lines;
	const rows: FlowLine[] = [];
	let end = -1;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? '';
		const data = isFlowDataLine(line);
		if (end >= 0) {
			if (data) {
				throw new WrsmParseError(`data row after the end of the data at line ${end + 1}`, {
					file: fileName,
					line: i + 1,
					column: 5,
					field: 'year'
				});
			}
			continue;
		}
		if (!data) {
			if (rows.length > 0) end = i;
			else if (line.trim() !== '') {
				throw new WrsmParseError(
					`not a WRSM2000 flow file: expected a year in columns 5–8, found '${line.slice(0, 40)}'`,
					{ file: fileName, line: i + 1, column: 1 }
				);
			}
			continue;
		}
		const year = Number(line.slice(4, 8));
		const previous = rows[rows.length - 1];
		if (previous !== undefined) {
			const ok = allowGaps ? year > previous.year : year === previous.year + 1;
			if (!ok) {
				throw new WrsmParseError(
					`year ${year} follows ${previous.year}: years must ${allowGaps ? 'ascend' : 'ascend without gaps'}`,
					{ file: fileName, line: i + 1, column: 5, field: 'year' }
				);
			}
		}
		const months: number[] = [];
		const flags: string[] = [];
		for (let k = 0; k < 12; k++) {
			const start = 9 + 8 * k;
			months.push(
				readFortranReal(line.slice(start, start + 7), 0, {
					file: fileName,
					line: i + 1,
					column: start + 1,
					field: `month ${k + 1}`
				})
			);
			flags.push(line.charAt(start + 7) || ' ');
		}
		rows.push({ year, months: months as unknown as Monthly12, flags, rest: line.slice(105), index: i });
	}
	if (rows.length === 0) {
		throw new WrsmParseError('no data rows', { file: fileName, line: Math.max(lines.length, 1) });
	}
	return {
		source: { lines, finalNewline: split.finalNewline },
		rows,
		end: end < 0 ? lines.length : end
	};
}

/** The rows a source re-reads to, and the line each came from. */
export interface SourceRows<R> {
	readonly rows: readonly R[];
	/** 0-based line index of each row. */
	readonly lineIndex: readonly number[];
}

/** Twelve values equal, value for value. */
export function sameMonths(a: Monthly12, b: Monthly12): boolean {
	for (let k = 0; k < 12; k++) if (a[k] !== b[k]) return false;
	return true;
}

/**
 * Write rows, reusing the source text where it still holds them.
 *
 * - No source: the canonical rows, then `canonicalTail`, CRLF throughout.
 * - Every row unchanged: the source exactly, final newline (or not) included.
 * - Otherwise: the source's lines before its first row, then each row (its
 *   source line if a source row of the same year is unchanged, else the
 *   canonical line), then `changedTail`, ending with CRLF.
 */
export function rewriteRows<R extends MonthlyRow>(
	rows: readonly R[],
	source: SeriesSource | undefined,
	reread: (source: SeriesSource) => SourceRows<R>,
	same: (a: R, b: R) => boolean,
	format: (row: R) => string,
	tails: { readonly canonical: () => readonly string[]; readonly changed: (source: SeriesSource, end: number) => readonly string[] }
): string {
	if (source === undefined) return joinLines([...rows.map(format), ...tails.canonical()]);
	const old = reread(source);
	const unchanged = rows.length === old.rows.length && rows.every((row, i) => same(row, old.rows[i] as R));
	if (unchanged) return joinLines(source.lines, source.finalNewline);
	const byYear = new Map<number, number>();
	old.rows.forEach((row, i) => byYear.set(row.year, i));
	const first = old.lineIndex[0] ?? 0;
	const end = (old.lineIndex[old.lineIndex.length - 1] ?? -1) + 1;
	const out = source.lines.slice(0, first);
	for (const row of rows) {
		const i = byYear.get(row.year);
		const kept = i === undefined ? undefined : old.rows[i];
		out.push(kept !== undefined && same(row, kept) ? (source.lines[old.lineIndex[i as number] as number] as string) : format(row));
	}
	out.push(...tails.changed(source, end));
	return joinLines(out);
}

/** The base name of a path, Windows or POSIX separators. */
export function baseName(fileName: string): string {
	return fileName.slice(Math.max(fileName.lastIndexOf('/'), fileName.lastIndexOf('\\')) + 1);
}
