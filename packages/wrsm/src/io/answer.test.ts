import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { answerFromSeries, readAnswer, writeAnswer } from './answer.js';
import { WrsmParseError } from './tokens.js';

// Synthetic inputs only: docs/formats/examples/ is an invented network.

const example = readFileSync(new URL('../../../../docs/formats/examples/network/Out/SYRQ9.ANS', import.meta.url), 'latin1');
const lines = example.split('\r\n');

function parseError(text: string, name = 'SYRQ9.ANS'): WrsmParseError {
	try {
		readAnswer(text, name);
	} catch (error) {
		if (error instanceof WrsmParseError) return error;
		throw error;
	}
	throw new Error('expected a parse error');
}

describe('readAnswer on the synthetic example', () => {
	const file = readAnswer(example, 'Out/SYRQ9.ANS');

	it('takes the kind and number from the file name', () => {
		expect([file.kind, file.number]).toEqual(['RQ', 9]);
		expect(readAnswer(example, 'SYRV12.ans').kind).toBe('RV');
	});

	it('reads the rows, totals, means and AVERAGE footer', () => {
		expect(file.rows.map((r) => r.year)).toEqual([1990, 1991, 1992, 1993, 1994]);
		expect(file.rows[0]?.months[0]).toBe(0.8);
		expect(file.rows[0]?.annualTotal).toBe(8.94);
		expect(file.rows[0]?.monthlyMean).toBe(0.75);
		expect(file.average.months[0]).toBe(0.78);
		expect(file.average.annualTotal).toBe(9.72);
		expect(file.average.monthlyMean).toBe(0.81);
	});

	it('writes back byte for byte', () => {
		expect(writeAnswer(file)).toBe(example);
	});
});

describe('answerFromSeries', () => {
	it('sums and averages unrounded values and rounds only when printing', () => {
		// Every month prints 0.00, but the annual is 0.048 → 0.05.
		const file = answerFromSeries('RQ', 3, { startYear: 2001, values: Array<number>(24).fill(0.004), unit: 'Mm3PerMonth' });
		const out = writeAnswer(file).split('\r\n');
		expect(out[0]).toBe(`    2001${'    0.00'.repeat(12)}      0.05      0.00`);
		expect(out[2]).toBe('  ');
		expect(out[3]).toBe(` AVERAGE${'    0.00'.repeat(12)}      0.05      0.00`);
		expect(out[4]).toBe('');
		expect(out).toHaveLength(5);
	});

	it('averages each column over the years', () => {
		const values = [...Array<number>(12).fill(1), ...Array<number>(12).fill(2)];
		const file = answerFromSeries('RV', 4, { startYear: 1990, values, unit: 'Mm3' });
		expect(file.rows.map((r) => r.annualTotal)).toEqual([12, 24]);
		expect(file.rows.map((r) => r.monthlyMean)).toEqual([1, 2]);
		expect(file.average).toEqual({ months: Array<number>(12).fill(1.5), annualTotal: 18, monthlyMean: 1.5 });
	});

	it('keeps float32 values, as WRSM2000 does', () => {
		const file = answerFromSeries('RQ', 1, { startYear: 1990, values: Array<number>(12).fill(0.1), unit: 'Mm3' });
		expect(file.rows[0]?.months[0]).toBe(Math.fround(0.1));
	});

	it('rejects a series that is not whole years', () => {
		expect(() => answerFromSeries('RQ', 1, { startYear: 1990, values: [1, 2], unit: 'Mm3' })).toThrow(/multiple of 12/);
	});
});

describe('writeAnswer number formatting (docs/formats.md §2, U-18)', () => {
	const one = (v: number) =>
		writeAnswer({
			kind: 'RQ',
			number: 1,
			rows: [{ year: 1990, months: [v, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], annualTotal: 0, monthlyMean: 0 }],
			average: { months: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], annualTotal: 0, monthlyMean: 0 }
		}).slice(8, 16);

	it('rounds half away from zero', () => {
		expect(one(0.125)).toBe('    0.13');
		expect(one(-0.125)).toBe('   -0.13');
	});

	it('rounds the float32 value, not the float64 one', () => {
		// 0.045 is just below the tie in float64 and just above it in float32.
		expect((0.045).toFixed(2)).toBe('0.04');
		expect(one(0.045)).toBe('    0.05');
	});

	it('never writes negative zero', () => {
		expect(one(-0.001)).toBe('    0.00');
	});

	it('rejects overflow instead of writing asterisks', () => {
		expect(() => one(123456.78)).toThrow(/F8.2/);
	});
});

describe('readAnswer errors name the file, line and field', () => {
	it('rejects a file name without RQ or RV', () => {
		expect(parseError(example, 'SYRU1ncr.MTS').message).toMatch(/RQ<route>/);
	});

	it('rejects a missing footer', () => {
		const e = parseError(lines.slice(0, 5).join('\r\n'));
		expect(e.field).toBe('AVERAGE');
	});

	it('rejects a blank value with its column', () => {
		const e = parseError([`${lines[0]?.slice(0, 104)}          ${lines[0]?.slice(114)}`, ...lines.slice(1)].join('\r\n'));
		expect([e.line, e.column, e.field]).toEqual([1, 105, 'annual']);
	});

	it('rejects a gap in the years', () => {
		const e = parseError([lines[0], lines[2], ...lines.slice(5)].join('\r\n'));
		expect([e.line, e.field]).toEqual([2, 'year']);
	});

	it('rejects text after the footer', () => {
		const e = parseError(`${example}junk\r\n`);
		expect(e.line).toBe(8);
	});
});
