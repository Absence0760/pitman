/**
 * Shared line reading and Fortran-style number writing for the reservoir,
 * channel and irrigation module files (docs/formats.md §§1–2, 6–8).
 *
 * Reading: a module file is read line by line, each line in the grammar of
 * its line type; a line never runs onto the next (docs/formats.md §1.2), so
 * missing values are an error and so are extra ones. Errors name the file,
 * line, column and field: `SYRV3.DAT:9:1 (L.009 spill route): …`.
 *
 * Writing: the edit descriptors of docs/formats.md §2. Values are rounded
 * half away from zero on their float32 value (U-18), never print as `-0`,
 * and a value too wide for its field is an error (never asterisks).
 */

import { FieldCursor, WrsmParseError, splitLines, tokenizeLine } from './tokens.js';
import type { Monthly12, RawLine } from '../types.js';

/** The lines of one module file, read in order. */
export class ModuleLines {
	private readonly lines: readonly string[];
	private index = 0;

	constructor(
		text: string,
		readonly fileName: string
	) {
		this.lines = splitLines(text).lines;
	}

	/** 1-based number of the next line to be read. */
	get lineNumber(): number {
		return this.index + 1;
	}

	/** Whether every line has been read. */
	get atEnd(): boolean {
		return this.index >= this.lines.length;
	}

	/** The next line's text without consuming it, or `undefined` at end of file. */
	peekText(): string | undefined {
		return this.lines[this.index];
	}

	/** Read the next line as line type `lineType`, e.g. `L.004`. */
	next(lineType: string): FieldCursor {
		const text = this.lines[this.index];
		if (text === undefined) throw this.error(`expected line type ${lineType}, found end of file`, lineType);
		this.index++;
		return new FieldCursor(tokenizeLine(text, this.index, { file: this.fileName }), { file: this.fileName });
	}

	/** The lines not yet read, verbatim. */
	rest(): RawLine[] {
		const out = this.lines.slice(this.index).map((text, k) => ({ line: this.index + k + 1, text }));
		this.index = this.lines.length;
		return out;
	}

	/** An error located at the next line (or just past the last one). */
	error(detail: string, field?: string): WrsmParseError {
		return new WrsmParseError(detail, {
			file: this.fileName,
			line: Math.min(this.index, this.lines.length) + 1,
			...(field !== undefined && { field })
		});
	}
}

/** Read a count field: a non-negative integer. */
export function readCount(cursor: FieldCursor, field: string): number {
	const token = cursor.numberToken(field);
	if (!token.integer || token.value < 0) throw cursor.error(`expected a count (a whole number ≥ 0), found '${token.text}'`, field, token);
	return token.value;
}

/** Read twelve monthly numbers, October first, and nothing else on the line. */
export function readTwelve(cursor: FieldCursor, field: string): Monthly12 {
	const values = cursor.numbers(field, 12);
	cursor.end(field);
	return values as unknown as Monthly12;
}

/** Join written lines with CRLF and end the file with CRLF (docs/formats.md §1.1). */
export function joinLines(lines: readonly string[]): string {
	return lines.map((line) => `${line}\r\n`).join('');
}

/** `value` rounded half away from zero to `decimals` places on its float32 value, without a sign on zero. */
function decimal(value: number, decimals: number, field: string): string {
	if (!Number.isFinite(value)) throw new Error(`${field}: cannot write ${value}`);
	// toFixed picks the larger magnitude at an exact tie: half away from zero.
	const text = Math.fround(value).toFixed(decimals);
	return /^-[0.]*$/.test(text) ? text.slice(1) : text;
}

/** Fortran `Fw.d`: right-justified in `w` columns, leading zero kept, `Fw.0` still prints the point. */
export function fixed(value: number, width: number, decimals: number, field: string): string {
	const text = minimal(value, decimals, field);
	if (text.length > width) throw new Error(`${field}: ${text} does not fit F${width}.${decimals}`);
	return text.padStart(width);
}

/** Fortran `F0.d`: minimal width, leading zero kept. */
export function minimal(value: number, decimals: number, field: string): string {
	const text = decimal(value, decimals, field);
	return decimals === 0 ? `${text}.` : text;
}

/** An integer as text, failing on a non-integer. */
function integerText(value: number, field: string): string {
	if (!Number.isInteger(value)) throw new Error(`${field}: ${value} is not an integer`);
	return String(value);
}

/** Fortran `Iw`: right-justified in `w` columns. */
export function rightInt(value: number, width: number, field: string): string {
	const text = integerText(value, field);
	if (text.length > width) throw new Error(`${field}: ${text} does not fit I${width}`);
	return text.padStart(width);
}

/** `F7.d,11F8.d`: twelve monthly values (RV L.007–L.008, CR L.004–L.005). */
export function monthly(values: readonly number[], decimals: number, field: string): string {
	return values.map((v, k) => fixed(v, k === 0 ? 7 : 8, decimals, `${field}[${k}]`)).join('');
}

/** Fortran `I0`: minimal width. */
export function int(value: number, field: string): string {
	return integerText(value, field);
}

/**
 * The `L5` count/route field of RV and CR files: left-justified, blank-padded
 * to 5 columns (U-10), or minimal width for a file that was written so.
 */
export function leftInt5(value: number, field: string, unpadded = false): string {
	const text = integerText(value, field);
	return unpadded ? text : text.padEnd(5);
}

/**
 * Whether a file wrote its `L5` lines at minimal width: none has trailing
 * blanks and at least one is shorter than 5 columns. A file with mixed
 * styles counts as padded (the writer normalises it).
 */
export function unpaddedL5(lines: readonly FieldCursor[]): boolean {
	const texts = lines.map((c) => c.tokenLine.text);
	return texts.every((t) => t === t.trimEnd()) && texts.some((t) => t.length < 5);
}

/** A single-quoted string, a quote inside doubled (Fortran's escape). Names must be ASCII. */
export function quoted(text: string, field: string): string {
	if (!/^[\x20-\x7e]*$/.test(text)) throw new Error(`${field}: '${text}' is not printable ASCII`);
	return `'${text.replace(/'/g, "''")}'`;
}

/** A route line, `I0,1X,'name'`: a `null` defined-flow file is written `' '` (simulated). */
export function routeLine(route: number, file: string | null, field: string): string {
	return `${int(route, `${field} route`)} ${quoted(file ?? ' ', `${field} file`)}`;
}

/** Read a defined-flow file name: blank (`' '` or `''`) means none. */
export function readFileName(cursor: FieldCursor, field: string): string | null {
	const name = cursor.string(field);
	return name.trim() === '' ? null : name;
}
