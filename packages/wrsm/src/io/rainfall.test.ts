import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { MonthlyRow } from '../types.js';
import { rainfallToSeries, readRainfall, writeRainfall } from './rainfall.js';
import { WrsmParseError } from './tokens.js';

// Synthetic inputs only: docs/formats/examples/ is an invented network.

const example = readFileSync(new URL('../../../../docs/formats/examples/network/SYA.RAN', import.meta.url), 'latin1');
const lines = example.split('\r\n');

function parseError(text: string): WrsmParseError {
	try {
		readRainfall(text, 'SYA.RAN');
	} catch (error) {
		if (error instanceof WrsmParseError) return error;
		throw error;
	}
	throw new Error('expected a parse error');
}

describe('readRainfall', () => {
	const series = readRainfall(example, 'SYA.RAN');

	it('reads the code, years and % MAP values', () => {
		expect(series.code).toBe('SYA');
		expect(series.rows.map((r) => r.year)).toEqual([1990, 1991, 1992, 1993, 1994]);
		expect(series.rows[0]?.months[0]).toBe(8.87);
		expect(series.rows[0]?.months[11]).toBe(8.47);
		expect(series.rows[4]?.months[5]).toBe(20.73);
	});

	it('writes back byte for byte, with and without the kept source', () => {
		expect(writeRainfall(series)).toBe(example);
		const { source: _source, ...bare } = series;
		expect(writeRainfall(bare)).toBe(example);
	});

	it('converts to the engine series', () => {
		const s = rainfallToSeries(series);
		expect(s.startYear).toBe(1990);
		expect(s.values).toHaveLength(60);
		expect(s.values[12]).toBe(1.52);
		expect(s.unit).toBe('percentMap');
	});

	it('reads a field without a decimal point as whole per cent (F7.0, U-23)', () => {
		const text = `SYA    1990${'     12'.padStart(7)}${'    1.5'.repeat(11)}\r\n`;
		expect(readRainfall(text, 'x.RAN').rows[0]?.months.slice(0, 2)).toEqual([12, 1.5]);
	});

	it('keeps trailing blank lines and hand-made value styles on rewrite', () => {
		const text = `SYA    1990${'    1.5'.repeat(12)}\r\n\r\n`;
		expect(writeRainfall(readRainfall(text, 'x.RAN'))).toBe(text);
	});

	it('writes an appended row in the canonical layout and keeps the others', () => {
		const added: MonthlyRow = { year: 1995, months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12.5] };
		const out = writeRainfall({ ...series, rows: [...series.rows, added] }).split('\r\n');
		expect(out.slice(0, 5)).toEqual(lines.slice(0, 5));
		expect(out[5]).toBe('SYA    1995   1.00   2.00   3.00   4.00   5.00   6.00   7.00   8.00   9.00  10.00  11.00  12.50');
		expect(out[5]).toHaveLength(95);
		expect(out[6]).toBe('');
	});

	it('rewrites every row when the code changes', () => {
		const out = writeRainfall({ ...series, code: 'SYB' });
		expect(out.split('\r\n').filter((l) => l.startsWith('SYB    '))).toHaveLength(5);
	});

	it('rejects values too wide for F7.2', () => {
		const row: MonthlyRow = { year: 1990, months: [10000, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] };
		expect(() => writeRainfall({ code: 'SYA', rows: [row] })).toThrow(/F7.2/);
	});
});

describe('readRainfall errors name the file, line and field', () => {
	it('rejects a gap in the years', () => {
		const e = parseError([lines[0], lines[2]].join('\r\n'));
		expect([e.file, e.line, e.column, e.field]).toEqual(['SYA.RAN', 2, 8, 'year']);
	});

	it('rejects a second code', () => {
		const e = parseError([lines[0], `SYB${lines[1]?.slice(3)}`].join('\r\n'));
		expect([e.line, e.field]).toEqual([2, 'code']);
	});

	it('rejects a non-numeric value with its column', () => {
		const bad = `${lines[0]?.slice(0, 18)}  abcde${lines[0]?.slice(25)}`;
		const e = parseError(bad);
		expect([e.line, e.column, e.field]).toEqual([1, 19, 'month 2']);
	});

	it('rejects data after a blank line', () => {
		const e = parseError([lines[0], '', lines[1]].join('\r\n'));
		expect(e.line).toBe(3);
	});

	it('rejects an empty file', () => {
		expect(parseError('').message).toMatch(/no data rows/);
	});
});
