/**
 * A tokenizer for WRSM2000's text files, in the spirit of Fortran
 * list-directed input (the files are written by Fortran, TT 691 ch.12).
 *
 * Handles what the network, module, rainfall, observed and answer files
 * contain:
 * - whitespace- (space, tab) or comma-separated values;
 * - numbers with or without a leading digit (`.06`), a trailing dot (`5.`),
 *   a sign, an exponent (`1E-3`, and Fortran's `1D-3`);
 * - a trailing `+` on a number, which .obs files use to flag an incomplete
 *   month (`3.89+`, `.06+`);
 * - quoted strings that may hold spaces (`'Basin A (farm dam)'`), with a
 *   doubled quote standing for one (`'it''s'`); `'` or `"` delimiters;
 * - anything else (`12RUY`, `N`, `*****`) as a bare word;
 * - CRLF, LF or mixed line endings, blank lines, a leading byte-order mark.
 *
 * Every token carries its 1-based line and column, so a reader can report
 * "file, line, field". Not handled (not seen in WRSM2000 files): repeat
 * counts (`3*0.5` is a bare word), null values between commas, the `/`
 * terminator.
 *
 * Lines such as the .NET input directory are free text (a path with
 * spaces); readers take those from `TokenLine.text` rather than the tokens.
 */

/** Fields every token shares. */
interface TokenBase {
	/** The token exactly as it appears in the source, quotes and flag included. */
	readonly text: string;
	/** 1-based line number. */
	readonly line: number;
	/** 1-based column of the token's first character. */
	readonly column: number;
}

/** A number, e.g. `12`, `-0.05`, `.06+`, `1.0D-3`. */
export interface NumberToken extends TokenBase {
	readonly kind: 'number';
	readonly value: number;
	/** Written without a decimal point or exponent (Fortran I format). */
	readonly integer: boolean;
	/** The number carried a trailing `+` (an incomplete-month flag in .obs files). */
	readonly plus: boolean;
}

/** A quoted string; `value` is the content without its quotes. */
export interface StringToken extends TokenBase {
	readonly kind: 'string';
	readonly value: string;
}

/** Any other run of non-separator characters, e.g. `12RUY` or `N`. */
export interface WordToken extends TokenBase {
	readonly kind: 'word';
	readonly value: string;
}

export type Token = NumberToken | StringToken | WordToken;

/** One source line and its tokens. Blank lines have no tokens. */
export interface TokenLine {
	/** 1-based line number. */
	readonly line: number;
	/** The line's text without its line ending. */
	readonly text: string;
	readonly tokens: readonly Token[];
}

/** How a file's lines end, so a writer can reproduce it. */
export type LineEnding = 'crlf' | 'lf' | 'mixed' | 'none';

/** A file split into lines. */
export interface SplitLines {
	readonly lines: readonly string[];
	readonly lineEnding: LineEnding;
	/** The file ends with a line ending (so `lines` has no empty last entry for it). */
	readonly finalNewline: boolean;
	/** The file started with a byte-order mark (removed from `lines`). */
	readonly bom: boolean;
}

export interface TokenizeOptions {
	/** File name used in error messages. */
	readonly file?: string;
}

/** A parse error that names the file, line, column and field. */
export class WrsmParseError extends Error {
	override readonly name = 'WrsmParseError';
	readonly file: string | undefined;
	readonly line: number;
	readonly column: number | undefined;
	readonly field: string | undefined;
	/** The message without the location prefix. */
	readonly detail: string;

	constructor(detail: string, where: { file?: string; line: number; column?: number; field?: string }) {
		super(`${formatLocation(where)}: ${detail}`);
		this.detail = detail;
		this.file = where.file;
		this.line = where.line;
		this.column = where.column;
		this.field = where.field;
	}
}

function formatLocation(where: { file?: string; line: number; column?: number; field?: string }): string {
	let s = `${where.file ?? '<input>'}:${where.line}`;
	if (where.column !== undefined) s += `:${where.column}`;
	if (where.field !== undefined) s += ` (${where.field})`;
	return s;
}

/** Split a file's text into lines, recording how they ended. */
export function splitLines(source: string): SplitLines {
	let text = source;
	const bom = text.charCodeAt(0) === 0xfeff;
	if (bom) text = text.slice(1);

	const lines: string[] = [];
	let crlf = 0;
	let lf = 0;
	let start = 0;
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) !== 10) continue;
		if (i > start && text.charCodeAt(i - 1) === 13) {
			lines.push(text.slice(start, i - 1));
			crlf++;
		} else {
			lines.push(text.slice(start, i));
			lf++;
		}
		start = i + 1;
	}
	const finalNewline = start === text.length && text.length > 0;
	if (!finalNewline && text.length > 0) lines.push(text.slice(start));

	const lineEnding: LineEnding = crlf && lf ? 'mixed' : crlf ? 'crlf' : lf ? 'lf' : 'none';
	return { lines, lineEnding, finalNewline, bom };
}

// Sign, then digits with an optional fraction or a bare fraction, then an
// optional exponent (E or Fortran D).
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eEdD][+-]?\d+)?$/;
const INTEGER = /^[+-]?\d+$/;

function isSeparator(ch: string): boolean {
	return ch === ' ' || ch === '\t' || ch === ',' || ch === '\r' || ch === '\f' || ch === '\v';
}

function classifyBare(text: string, line: number, column: number): NumberToken | WordToken {
	let body = text;
	let plus = false;
	if (!NUMBER.test(body) && body.length > 1 && body.endsWith('+') && NUMBER.test(body.slice(0, -1))) {
		body = body.slice(0, -1);
		plus = true;
	}
	if (NUMBER.test(body)) {
		return {
			kind: 'number',
			text,
			line,
			column,
			value: Number(body.replace(/[dD]/, 'e')),
			integer: INTEGER.test(body),
			plus
		};
	}
	return { kind: 'word', text, line, column, value: text };
}

/** Tokenize one line. `line` is its 1-based number, used in positions and errors. */
export function tokenizeLine(text: string, line: number, options: TokenizeOptions = {}): TokenLine {
	const tokens: Token[] = [];
	let i = 0;
	while (i < text.length) {
		const ch = text.charAt(i);
		if (isSeparator(ch)) {
			i++;
			continue;
		}
		const column = i + 1;
		if (ch === "'" || ch === '"') {
			let value = '';
			let j = i + 1;
			let closed = false;
			while (j < text.length) {
				const c = text.charAt(j);
				if (c === ch) {
					if (text.charAt(j + 1) === ch) {
						value += ch;
						j += 2;
						continue;
					}
					closed = true;
					j++;
					break;
				}
				value += c;
				j++;
			}
			if (!closed) {
				throw new WrsmParseError(`unterminated string starting with ${ch}`, {
					...(options.file !== undefined && { file: options.file }),
					line,
					column
				});
			}
			tokens.push({ kind: 'string', text: text.slice(i, j), line, column, value });
			i = j;
			continue;
		}
		let j = i;
		while (j < text.length && !isSeparator(text.charAt(j)) && text.charAt(j) !== "'" && text.charAt(j) !== '"') j++;
		tokens.push(classifyBare(text.slice(i, j), line, column));
		i = j;
	}
	return { line, text, tokens };
}

/** Tokenize a whole file. Every source line is returned, blank ones with no tokens. */
export function tokenize(source: string, options: TokenizeOptions = {}): readonly TokenLine[] {
	return splitLines(source).lines.map((text, index) => tokenizeLine(text, index + 1, options));
}

/**
 * Reads the tokens of one line in order, naming each field, so a malformed
 * value reports e.g. `TSRU1.DAT:3:9 (L.003 SL): expected a number, found 'x'`.
 */
export class FieldCursor {
	private index = 0;

	constructor(
		readonly tokenLine: TokenLine,
		private readonly options: TokenizeOptions = {}
	) {}

	/** Tokens not yet read. */
	get remaining(): number {
		return this.tokenLine.tokens.length - this.index;
	}

	/** The next token without consuming it. */
	peek(): Token | undefined {
		return this.tokenLine.tokens[this.index];
	}

	/** Read a number. */
	number(field: string): number {
		return this.numberToken(field).value;
	}

	/** Read a number written as an integer (no decimal point or exponent). */
	integer(field: string): number {
		const token = this.numberToken(field);
		if (!token.integer) throw this.error(`expected an integer, found '${token.text}'`, field, token);
		return token.value;
	}

	/** Read a number token, keeping its `+` flag and source text. */
	numberToken(field: string): NumberToken {
		const token = this.take(field, 'a number');
		if (token.kind !== 'number') throw this.error(`expected a number, found '${token.text}'`, field, token);
		return token;
	}

	/** Read a quoted string. */
	string(field: string): string {
		const token = this.take(field, 'a quoted string');
		if (token.kind !== 'string') throw this.error(`expected a quoted string, found '${token.text}'`, field, token);
		return token.value;
	}

	/** Read a bare word. */
	word(field: string): string {
		const token = this.take(field, 'a word');
		if (token.kind !== 'word') throw this.error(`expected a word, found '${token.text}'`, field, token);
		return token.value;
	}

	/** Read a number if one is next, else return `undefined` (for optional trailing fields). */
	optionalNumber(field: string): number | undefined {
		return this.peek() === undefined ? undefined : this.number(field);
	}

	/** Read `count` numbers named `field[0]`, `field[1]`, … */
	numbers(field: string, count: number): number[] {
		const out: number[] = [];
		for (let k = 0; k < count; k++) out.push(this.number(`${field}[${k}]`));
		return out;
	}

	/** Fail if tokens are left over. */
	end(what = 'line'): void {
		const token = this.peek();
		if (token !== undefined) throw this.error(`unexpected '${token.text}' at end of ${what}`, undefined, token);
	}

	/** Build an error located at a token (or at the end of the line). */
	error(detail: string, field?: string, token?: Token): WrsmParseError {
		const column = token?.column ?? this.tokenLine.text.length + 1;
		return new WrsmParseError(detail, {
			...(this.options.file !== undefined && { file: this.options.file }),
			line: this.tokenLine.line,
			column,
			...(field !== undefined && { field })
		});
	}

	private take(field: string, expected: string): Token {
		const token = this.tokenLine.tokens[this.index];
		if (token === undefined) throw this.error(`expected ${expected}, found end of line`, field);
		this.index++;
		return token;
	}
}
