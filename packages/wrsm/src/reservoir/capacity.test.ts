import { describe, expect, it } from 'vitest';
import type { ReservoirCapacity } from '../types.js';
import { CapacityTableError, capacityInYear, capacitySeries, checkCapacityTable, surfaceArea } from './capacity.js';

const table: ReservoirCapacity[] = [
	{ year: 1950, fullSupplyVolumeMm3: 0, fullSupplyAreaKm2: 0 },
	{ year: 1959, fullSupplyVolumeMm3: 0, fullSupplyAreaKm2: 0 },
	{ year: 1960, fullSupplyVolumeMm3: 10, fullSupplyAreaKm2: 2 },
	{ year: 1970, fullSupplyVolumeMm3: 20, fullSupplyAreaKm2: 3 }
];
const opts = { between: 'linear', outside: 'error' } as const;

describe('surfaceArea (TT 690 p.10 eq. 2.3, spec §4.1)', () => {
	it('passes through (CAP, FSA) and gives the worked example', () => {
		const cap = { capMm3: 10, fsaKm2: 2 };
		expect(surfaceArea(10, cap, 0.6)).toBeCloseTo(2, 12);
		// a = 2 / 10^0.6 = 0.502377; A(5) = a · 5^0.6 = 1.319508
		expect(surfaceArea(5, cap, 0.6)).toBeCloseTo(1.3195079108, 9);
	});
	it('is zero for an empty or unbuilt reservoir', () => {
		expect(surfaceArea(0, { capMm3: 10, fsaKm2: 2 }, 0.6)).toBe(0);
		expect(surfaceArea(3, { capMm3: 0, fsaKm2: 2 }, 0.6)).toBe(0);
	});
});

describe('capacityInYear (spec §3.6, R3-RV4)', () => {
	it('takes a row year exactly', () => {
		expect(capacityInYear(table, 1960, 'linear')).toEqual({ capMm3: 10, fsaKm2: 2 });
	});
	it('interpolates linearly between rows by default', () => {
		const c = capacityInYear(table, 1965, 'linear')!;
		expect(c.capMm3).toBeCloseTo(15, 12);
		expect(c.fsaKm2).toBeCloseTo(2.5, 12);
	});
	it('holds the earlier row under the step option', () => {
		expect(capacityInYear(table, 1969, 'step')).toEqual({ capMm3: 10, fsaKm2: 2 });
	});
	it('a dam built in 1960 (the TT 689 p.91 pattern of two zero rows) is zero until then', () => {
		expect(capacityInYear(table, 1959, 'linear')).toEqual({ capMm3: 0, fsaKm2: 0 });
		expect(capacityInYear(table, 1955, 'linear')).toEqual({ capMm3: 0, fsaKm2: 0 });
	});
	it('is undefined outside the table', () => {
		expect(capacityInYear(table, 1949, 'linear')).toBeUndefined();
		expect(capacityInYear(table, 1971, 'linear')).toBeUndefined();
	});
});

describe('checkCapacityTable', () => {
	it.each([
		[[], /NYR = 0/],
		[[{ year: 1960, fullSupplyVolumeMm3: 1, fullSupplyAreaKm2: 1 }, { year: 1960, fullSupplyVolumeMm3: 1, fullSupplyAreaKm2: 1 }], /ascend/],
		[[{ year: 1960, fullSupplyVolumeMm3: -1, fullSupplyAreaKm2: 1 }], /negative or invalid full supply volume/],
		[[{ year: 1960, fullSupplyVolumeMm3: 1, fullSupplyAreaKm2: -0.1 }], /negative or invalid full supply area/]
	] as [ReservoirCapacity[], RegExp][])('rejects a bad table', (rows, message) => {
		expect(() => checkCapacityTable(rows)).toThrow(CapacityTableError);
		expect(() => checkCapacityTable(rows)).toThrow(message);
	});
});

describe('capacitySeries per mode (D1, spec §5)', () => {
	it('historical: one value per year from the table', () => {
		const { years } = capacitySeries(table, { kind: 'historical' }, 1959, 1961, opts);
		expect(years.map((y) => y.capMm3)).toEqual([0, 10, 11]);
	});
	it('historical: a year outside the table is an error by default (TT 689 p.91)', () => {
		expect(() => capacitySeries(table, { kind: 'historical' }, 1969, 1972, opts)).toThrow(/does not cover 1971/);
	});
	it('historical: `nearest` holds the end row and warns', () => {
		const { years, messages } = capacitySeries(table, { kind: 'historical' }, 1969, 1972, { ...opts, outside: 'nearest' });
		expect(years.map((y) => y.capMm3)).toEqual([19, 20, 20, 20]);
		expect(messages[0]).toMatchObject({ level: 'warning' });
		expect(messages[0]!.text).toMatch(/2 simulated year/);
	});
	it('present day: every year holds the chosen year', () => {
		const { years, messages } = capacitySeries(table, { kind: 'presentDay', year: 1965 }, 1950, 1952, opts);
		expect(years.map((y) => y.capMm3)).toEqual([15, 15, 15]);
		expect(messages).toEqual([]);
	});
	it('present day beyond the table holds its last row, with an info message', () => {
		const { years, messages } = capacitySeries(table, { kind: 'presentDay', year: 2025 }, 1950, 1951, opts);
		expect(years.map((y) => y.capMm3)).toEqual([20, 20]);
		expect(messages[0]).toMatchObject({ level: 'info' });
		expect(messages[0]!.text).toMatch(/no 2025; present day uses its 1970 row/);
	});
	it('natural: the dam is removed, even with no table', () => {
		const { years } = capacitySeries([], { kind: 'natural' }, 1950, 1951, opts);
		expect(years).toEqual([
			{ capMm3: 0, fsaKm2: 0 },
			{ capMm3: 0, fsaKm2: 0 }
		]);
	});
});
