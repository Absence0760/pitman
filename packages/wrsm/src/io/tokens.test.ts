import { describe, expect, it } from 'vitest';
import { FieldCursor, WrsmParseError, splitLines, tokenize, tokenizeLine, type Token } from './tokens.js';

// All inputs here are synthetic: made-up modules, names and values.

const summary = (tokens: readonly Token[]) =>
	tokens.map((t) => (t.kind === 'number' ? [t.kind, t.value, t.integer, t.plus] : [t.kind, t.value]));

describe('splitLines', () => {
	it('splits LF and records the ending', () => {
		expect(splitLines('a\nb\n')).toEqual({ lines: ['a', 'b'], lineEnding: 'lf', finalNewline: true, bom: false });
	});

	it('splits CRLF and strips the CR', () => {
		expect(splitLines('a\r\nb\r\n')).toEqual({ lines: ['a', 'b'], lineEnding: 'crlf', finalNewline: true, bom: false });
	});

	it('reports mixed endings', () => {
		expect(splitLines('a\r\nb\nc').lineEnding).toBe('mixed');
	});

	it('keeps a last line without a newline', () => {
		expect(splitLines('a\nb')).toEqual({ lines: ['a', 'b'], lineEnding: 'lf', finalNewline: false, bom: false });
	});

	it('keeps blank lines, including whitespace-only ones', () => {
		expect(splitLines('a\n\n  \nb\n').lines).toEqual(['a', '', '  ', 'b']);
	});

	it('handles an empty file and a file with no newline', () => {
		expect(splitLines('')).toEqual({ lines: [], lineEnding: 'none', finalNewline: false, bom: false });
		expect(splitLines('x')).toEqual({ lines: ['x'], lineEnding: 'none', finalNewline: false, bom: false });
	});

	it('removes and records a byte-order mark', () => {
		expect(splitLines('\uFEFFa\n')).toEqual({ lines: ['a'], lineEnding: 'lf', finalNewline: true, bom: true });
	});

	it('does not treat a lone CR as a line break', () => {
		expect(splitLines('a\rb\n').lines).toEqual(['a\rb']);
	});
});

describe('tokenizeLine: numbers', () => {
	it('reads integers and decimals separated by spaces', () => {
		expect(summary(tokenizeLine('  12  3.5   -0.05', 1).tokens)).toEqual([
			['number', 12, true, false],
			['number', 3.5, false, false],
			['number', -0.05, false, false]
		]);
	});

	it('reads leading-dot and trailing-dot decimals', () => {
		expect(summary(tokenizeLine('.06 -.5 5. +.25', 1).tokens)).toEqual([
			['number', 0.06, false, false],
			['number', -0.5, false, false],
			['number', 5, false, false],
			['number', 0.25, false, false]
		]);
	});

	it('reads E and Fortran D exponents', () => {
		const values = tokenizeLine('1E-3 2.5e+2 1.0D-3 4d2', 1).tokens.map((t) => (t.kind === 'number' ? t.value : null));
		expect(values).toEqual([0.001, 250, 0.001, 400]);
	});

	it('flags a trailing + as an incomplete month and keeps the value', () => {
		const tokens = tokenizeLine('    1990    1.25+    .07+   12.00    44.10+', 4).tokens;
		expect(summary(tokens)).toEqual([
			['number', 1990, true, false],
			['number', 1.25, false, true],
			['number', 0.07, false, true],
			['number', 12, false, false],
			['number', 44.1, false, true]
		]);
		expect(tokens[1]?.text).toBe('1.25+');
	});

	it('does not mistake an exponent sign or a lone + for a flag', () => {
		expect(summary(tokenizeLine('1E+5 + 1E+ 3++', 1).tokens)).toEqual([
			['number', 100000, false, false],
			['word', '+'],
			['word', '1E+'],
			['word', '3++']
		]);
	});

	it('accepts tabs and commas as separators', () => {
		expect(summary(tokenizeLine('1\t2,3 ,4', 1).tokens).map((t) => t[1])).toEqual([1, 2, 3, 4]);
	});

	it('treats Fortran overflow stars and repeat counts as words', () => {
		expect(summary(tokenizeLine('***** 3*0.5', 1).tokens)).toEqual([
			['word', '*****'],
			['word', '3*0.5']
		]);
	});
});

describe('tokenizeLine: strings and words', () => {
	it('reads a quoted string with spaces and keeps padding', () => {
		const [num, str] = tokenizeLine("   7 'Test basin A       '  3", 1).tokens;
		expect(num).toMatchObject({ kind: 'number', value: 7 });
		expect(str).toMatchObject({ kind: 'string', value: 'Test basin A       ', text: "'Test basin A       '", column: 6 });
	});

	it('reads a blank string and an empty string', () => {
		expect(summary(tokenizeLine("12 ' ' ''", 1).tokens)).toEqual([
			['number', 12, true, false],
			['string', ' '],
			['string', '']
		]);
	});

	it('unescapes a doubled quote', () => {
		expect(tokenizeLine("'it''s'", 1).tokens[0]).toMatchObject({ kind: 'string', value: "it's" });
	});

	it('accepts double-quoted strings, with the other quote inside', () => {
		expect(tokenizeLine(`"a 'b' c"`, 1).tokens[0]).toMatchObject({ kind: 'string', value: "a 'b' c" });
	});

	it('reads a file name with dots and a module-list entry as tokens of the right kind', () => {
		expect(summary(tokenizeLine("  10.5  640 'XYZ.RAN'", 1).tokens)).toEqual([
			['number', 10.5, false, false],
			['number', 640, true, false],
			['string', 'XYZ.RAN']
		]);
		expect(summary(tokenizeLine('12RUY   ', 1).tokens)).toEqual([['word', '12RUY']]);
		expect(summary(tokenizeLine("'RT' 5 'Q'", 1).tokens)).toEqual([
			['string', 'RT'],
			['number', 5, true, false],
			['string', 'Q']
		]);
	});

	it('starts a new token when a quote follows a word directly', () => {
		expect(summary(tokenizeLine("ab'c d'", 1).tokens)).toEqual([
			['word', 'ab'],
			['string', 'c d']
		]);
	});

	it('throws a located error for an unterminated string', () => {
		expect(() => tokenizeLine("  3 'open", 9, { file: 'TSTRU3.DAT' })).toThrowError(
			new WrsmParseError("unterminated string starting with '", { file: 'TSTRU3.DAT', line: 9, column: 5 })
		);
		try {
			tokenizeLine("  3 'open", 9, { file: 'TSTRU3.DAT' });
		} catch (e) {
			expect(e).toBeInstanceOf(WrsmParseError);
			expect((e as WrsmParseError).message).toBe("TSTRU3.DAT:9:5: unterminated string starting with '");
		}
	});
});

describe('tokenize', () => {
	it('tokenizes a synthetic CRLF module file with positions', () => {
		const source = [
			"     3 'Synthetic basin'  7",
			"   12.5  640 'SYN.RAN'",
			'',
			'  0.80  1.00  .95'
		].join('\r\n');
		const lines = tokenize(source);
		expect(lines.map((l) => l.line)).toEqual([1, 2, 3, 4]);
		expect(lines[2]?.tokens).toEqual([]);
		expect(lines[1]?.tokens[2]).toMatchObject({ kind: 'string', value: 'SYN.RAN', line: 2, column: 14 });
		expect(lines[3]?.tokens[2]).toMatchObject({ kind: 'number', value: 0.95, line: 4, column: 15 });
		expect(lines[0]?.text).toBe("     3 'Synthetic basin'  7");
	});

	it('gives the same tokens for LF and CRLF input', () => {
		const lf = 'A1 1990 1.0 2.0\nA1 1991 3.0 4.0\n';
		expect(tokenize(lf.replaceAll('\n', '\r\n'))).toEqual(tokenize(lf));
	});

	it('keeps free-text lines intact in `text`', () => {
		const [line] = tokenize('c:\\Some Folder\\Net 1\\   \r\n');
		expect(line?.text).toBe('c:\\Some Folder\\Net 1\\   ');
	});
});

describe('FieldCursor', () => {
	const cursor = (text: string) => new FieldCursor(tokenizeLine(text, 3), { file: 'TSTRU1.DAT' });

	it('reads fields in order', () => {
		const c = cursor("  2.0  0 180 'R.RAN' N 1.5+");
		expect(c.number('POW')).toBe(2);
		expect(c.integer('SL')).toBe(0);
		expect(c.integer('ST')).toBe(180);
		expect(c.string('file')).toBe('R.RAN');
		expect(c.word('flag')).toBe('N');
		expect(c.numberToken('x')).toMatchObject({ value: 1.5, plus: true });
		expect(c.remaining).toBe(0);
		expect(c.optionalNumber('HGGW')).toBeUndefined();
		c.end();
	});

	it('reads a run of numbers', () => {
		expect(cursor('1 2 3 4').numbers('pan', 3)).toEqual([1, 2, 3]);
	});

	it('names file, line, column and field when a value is wrong', () => {
		const c = cursor('  2.0  abc');
		c.number('POW');
		expect(() => c.number('L.003 SL')).toThrowError("TSTRU1.DAT:3:8 (L.003 SL): expected a number, found 'abc'");
	});

	it('reports a missing field at the end of the line', () => {
		const c = cursor('1 2');
		c.numbers('pan', 2);
		expect(() => c.number('pan[2]')).toThrowError('TSTRU1.DAT:3:4 (pan[2]): expected a number, found end of line');
	});

	it('rejects a decimal where an integer is required', () => {
		expect(() => cursor('5.0').integer('NYRF')).toThrowError("TSTRU1.DAT:3:1 (NYRF): expected an integer, found '5.0'");
	});

	it('rejects leftovers', () => {
		const c = cursor('1 2');
		c.number('a');
		expect(() => c.end()).toThrowError("TSTRU1.DAT:3:3: unexpected '2' at end of line");
	});

	it('rejects the wrong kind of token', () => {
		expect(() => cursor('12').string('name')).toThrowError("expected a quoted string, found '12'");
		expect(() => cursor("'x'").word('code')).toThrowError("expected a word, found ''x''");
	});
});
