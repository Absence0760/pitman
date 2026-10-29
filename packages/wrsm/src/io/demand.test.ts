import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { MonthlyRow } from '../types.js';
import { readDemand, writeDemand } from './demand.js';
import { WrsmParseError } from './tokens.js';

// Synthetic inputs only: docs/formats/examples/ is an invented network.

const exampleDir = new URL('../../../../docs/formats/examples/network/', import.meta.url);
const dom = readFileSync(new URL('SYDOM.abs', exampleDir), 'latin1');
const inflow = readFileSync(new URL('SYINF.abs', exampleDir), 'latin1');
const dem = readFileSync(new URL('Out/SYRQ7.DEM', exampleDir), 'latin1');
const ans = readFileSync(new URL('Out/SYRQ9.ANS', exampleDir), 'latin1');

describe('readDemand on the synthetic examples', () => {
	it('reads a defined demand without totals', () => {
		const series = readDemand(dom, 'SYDOM.abs');
		expect(series.fileName).toBe('SYDOM.abs');
		expect([series.hasTotals, series.hasAverage]).toEqual([false, false]);
		expect(series.rows.map((r) => r.year)).toEqual([1990, 1991, 1992, 1993, 1994]);
		expect(series.rows[0]?.months.slice(0, 3)).toEqual([0.08, 0.08, 0.09]);
	});

	it('reads a .DEM in the .ANS layout', () => {
		const series = readDemand(dem, 'SYRQ7.DEM');
		expect([series.hasTotals, series.hasAverage]).toEqual([true, true]);
		expect(series.rows).toHaveLength(5);
		expect(series.rows[0]?.months[3]).toBe(0.1);
	});

	it('reads an .ANS used as a defined inflow (TT 689 p.8)', () => {
		const series = readDemand(ans, 'SYRQ9.ANS');
		expect(series.rows).toHaveLength(5);
		expect(series.hasAverage).toBe(true);
	});

	it('writes every example back byte for byte, with and without the kept source', () => {
		for (const [text, name] of [
			[dom, 'SYDOM.abs'],
			[inflow, 'SYINF.abs'],
			[dem, 'SYRQ7.DEM']
		] as const) {
			const series = readDemand(text, name);
			expect(writeDemand(series)).toBe(text);
			const { source: _source, ...bare } = series;
			expect(writeDemand(bare)).toBe(text);
		}
	});
});

describe('writeDemand', () => {
	const months = (v: number) => Array<number>(12).fill(v) as unknown as MonthlyRow['months'];

	it('writes 4X,I4,12F8.2 (104 columns) for a generated demand', () => {
		const text = writeDemand({ fileName: 'SYRQ11.abs', rows: [{ year: 2025, months: months(0.125) }], hasTotals: false, hasAverage: false });
		expect(text).toBe(`    2025${'    0.13'.repeat(12)}\r\n`);
	});

	it('recomputes the AVERAGE footer when rows change', () => {
		const series = readDemand(dem, 'SYRQ7.DEM');
		const rows = series.rows.map((r) => (r.year === 1994 ? { ...r, months: months(0.1) } : r));
		const out = writeDemand({ ...series, rows }).split('\r\n');
		const old = dem.split('\r\n');
		expect(out.slice(0, 4)).toEqual(old.slice(0, 4));
		expect(out[4]).toBe(`    1994${'    0.10'.repeat(12)}      1.20      0.10`);
		expect(out[5]).toBe('  ');
		expect(out[6]?.startsWith(' AVERAGE    0.06')).toBe(true);
	});

	it('rejects a value WRSM2000 could not read back in 7 columns', () => {
		expect(() =>
			writeDemand({ fileName: 'big.abs', rows: [{ year: 2025, months: months(12345) }], hasTotals: false, hasAverage: false })
		).toThrow(/big.abs year 2025 month 1.*F7.2/);
	});
});

describe('readDemand errors name the file, line and field', () => {
	it('rejects a gap in the years', () => {
		const lines = dom.split('\r\n');
		try {
			readDemand([lines[0], lines[2]].join('\r\n'), 'SYDOM.abs');
			throw new Error('expected a parse error');
		} catch (error) {
			const e = error as WrsmParseError;
			expect(e).toBeInstanceOf(WrsmParseError);
			expect([e.file, e.line, e.column, e.field]).toEqual(['SYDOM.abs', 2, 5, 'year']);
		}
	});
});
