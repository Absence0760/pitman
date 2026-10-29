import { describe, expect, it } from 'vitest';
import type { DemandSeries, Monthly12 } from '../types.js';
import { definedFlowSeries, monthCount, zeroSeries } from './contract.js';

const months = (v: number) => new Array(12).fill(v) as unknown as Monthly12;
const file: DemandSeries = {
	fileName: 'X.DEM',
	rows: [
		{ year: 2000, months: months(1) },
		{ year: 2001, months: months(2) }
	],
	hasTotals: false,
	hasAverage: false
};

describe('definedFlowSeries', () => {
	it('takes each year from the file in historical mode', () => {
		const { series } = definedFlowSeries(file, { kind: 'historical' }, 2000, 2001);
		expect(series.values).toEqual([...months(1), ...months(2)]);
		expect(series.unit).toBe('Mm3');
	});

	it('throws on a year the file lacks in historical mode', () => {
		expect(() => definedFlowSeries(file, { kind: 'historical' }, 2000, 2002)).toThrow(/X\.DEM: no row for 2002/);
	});

	it('holds the chosen year in present-day mode, or the nearest year the file has', () => {
		expect(definedFlowSeries(file, { kind: 'presentDay', year: 2000 }, 2000, 2001).series.values).toEqual([...months(1), ...months(1)]);
		const later = definedFlowSeries(file, { kind: 'presentDay', year: 2025 }, 1990, 1990);
		expect(later.series.values).toEqual([...months(2)]);
		expect(later.messages[0]?.text).toMatch(/no 2025 row; present day uses 2001/);
	});

	it('is zero in natural mode', () => {
		expect(definedFlowSeries(file, { kind: 'natural' }, 1990, 1991).series).toEqual(zeroSeries(1990, 1991));
		expect(monthCount(1990, 1991)).toBe(24);
	});
});
