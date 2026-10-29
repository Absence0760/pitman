import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ObservedRow } from '../types.js';
import { readObserved, writeObserved } from './observed.js';
import { WrsmParseError } from './tokens.js';

// Synthetic inputs only: docs/formats/examples/ is an invented network.

const exampleDir = new URL('../../../../docs/formats/examples/network/', import.meta.url);
const example = readFileSync(new URL('SYH001.obs', exampleDir), 'latin1');
const nat = readFileSync(new URL('SY.nat', exampleDir), 'latin1');
const lines = example.split('\r\n');

function parseError(text: string): WrsmParseError {
	try {
		readObserved(text, 'SYH001.obs');
	} catch (error) {
		if (error instanceof WrsmParseError) return error;
		throw error;
	}
	throw new Error('expected a parse error');
}

// A `4X,I4,12F8.2`-style row from preformatted values.
const row = (year: number, values: string[]) => `    ${year}${values.map((v) => v.padStart(8)).join('')}`;

describe('readObserved on the synthetic example', () => {
	const flow = readObserved(example, 'SYH001.obs');

	it('reads a partial record with + flags and annual totals', () => {
		expect(flow.rows.map((r) => r.year)).toEqual([1991, 1992, 1993, 1994]);
		const first = flow.rows[0] as ObservedRow;
		expect(first.months[0]).toBe(0.14);
		expect(first.incomplete.slice(0, 4)).toEqual([true, true, true, false]);
		expect(first.annualTotal).toBe(9.84);
		expect(first.annualIncomplete).toBe(true);
	});

	it('reads the leading-dot row the same way', () => {
		const second = flow.rows[1] as ObservedRow;
		expect(second.months.slice(0, 3)).toEqual([1.2, 0.74, 0.44]);
		expect(second.incomplete.every((f) => !f)).toBe(true);
		expect([second.annualTotal, second.annualIncomplete]).toEqual([11.48, false]);
	});

	it('writes back byte for byte', () => {
		expect(writeObserved(flow)).toBe(example);
	});

	it('rewrites only a changed row, in the 116-column layout', () => {
		const second = flow.rows[1] as ObservedRow;
		const months = second.months.map((v, k) => (k === 0 ? 1.25 : v)) as unknown as ObservedRow['months'];
		const changed: ObservedRow = { ...second, months };
		const out = writeObserved({ ...flow, rows: flow.rows.map((r) => (r === second ? changed : r)) }).split('\r\n');
		expect(out[0]).toBe(lines[0]);
		expect(out[2]).toBe(lines[2]);
		expect(out[1]).toBe(
			'    1992    1.25    0.74    0.44    0.48    1.97    1.33    1.37    0.94    0.60    1.01    0.54    0.86      11.48 '
		);
		expect(out[1]).toHaveLength(116);
	});

	it('reads a .nat named as a gauge series (no flags, annual total, no footer)', () => {
		const series = readObserved(nat, 'SY.nat');
		expect(series.rows).toHaveLength(5);
		expect(series.rows[0]?.annualTotal).toBe(8.45);
		expect(writeObserved(series)).toBe(nat);
	});
});

describe('readObserved edge cases', () => {
	const zeros = Array<string>(12).fill('0.00');

	it('allows gaps in the years', () => {
		const flow = readObserved(`${row(1991, zeros)}\r\n${row(1994, zeros)}\r\n`, 'g.obs');
		expect(flow.rows.map((r) => r.year)).toEqual([1991, 1994]);
	});

	it('keeps negative (missing, U-16) values as read', () => {
		const flow = readObserved(`${row(1991, ['-99.99', ...zeros.slice(1)])}\r\n`, 'm.obs');
		expect(flow.rows[0]?.months[0]).toBe(-99.99);
	});

	it('reads a 3-decimal row the way WRSM2000 does: truncated, third decimal in the flag column', () => {
		// `4X,I4,1X,12F8.3`: each value ends one column late.
		const line = `    2000 ${' -99.999'.repeat(12)}`;
		const flow = readObserved(`${line}\r\n`, 'x.obs');
		expect(flow.rows[0]?.months[0]).toBe(-99.99);
		expect(flow.rows[0]?.incomplete[0]).toBe(false);
		expect(writeObserved(flow)).toBe(`${line}\r\n`);
	});

	it('writes 104 columns when there is no annual total', () => {
		const flow = readObserved(`${row(1991, zeros)}\r\n`, 'z.obs');
		expect(flow.rows[0]?.annualTotal).toBeNull();
		const { source: _source, ...bare } = flow;
		expect(writeObserved(bare)).toBe(`${row(1991, zeros)}\r\n`);
		expect(row(1991, zeros)).toHaveLength(104);
	});

	it('ignores unreadable text past column 105, as WRSM2000 does', () => {
		const text = `${row(1991, zeros)}  total?\r\n`;
		const flow = readObserved(text, 'z.obs');
		expect(flow.rows[0]?.annualTotal).toBeNull();
		expect(writeObserved(flow)).toBe(text);
	});

	it('keeps a missing final newline and trailing lines when unchanged', () => {
		const text = `${row(1991, zeros)}\r\n  `;
		expect(writeObserved(readObserved(text, 'z.obs'))).toBe(text);
	});
});

describe('readObserved errors name the file, line and field', () => {
	it('rejects years that do not ascend', () => {
		const e = parseError([lines[1], lines[0]].join('\r\n'));
		expect([e.file, e.line, e.column, e.field]).toEqual(['SYH001.obs', 2, 5, 'year']);
	});

	it('rejects text before the first data row', () => {
		const e = parseError(`Station: X\r\n${example}`);
		expect(e.line).toBe(1);
		expect(e.message).toMatch(/not a WRSM2000 flow file/);
	});

	it('rejects a non-numeric month with its column', () => {
		const e = parseError(`${lines[0]?.slice(0, 17)}  x.xx ${lines[0]?.slice(24)}`);
		expect([e.line, e.column, e.field]).toEqual([1, 18, 'month 2']);
	});

	it('rejects a data row after the end of the data', () => {
		const e = parseError([lines[0], '', lines[1]].join('\r\n'));
		expect([e.line, e.field]).toEqual([3, 'year']);
	});
});
