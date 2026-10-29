import { describe, expect, it } from 'vitest';
import { daysInMonth, fromEpochDay, isIsoDate, toEpochDay } from './calendar.js';

describe('calendar', () => {
	it('round-trips dates through day counts, across leap days', () => {
		expect(toEpochDay('1970-01-01')).toBe(0);
		expect(toEpochDay('1981-01-01')).toBe(4018);
		for (const d of ['1981-01-01', '2000-02-29', '2024-02-29', '2024-03-01', '2100-03-01']) expect(fromEpochDay(toEpochDay(d))).toBe(d);
		expect(toEpochDay('2024-03-01') - toEpochDay('2024-02-28')).toBe(2);
		expect(toEpochDay('2023-03-01') - toEpochDay('2023-02-28')).toBe(1);
	});

	it('knows real dates from look-alikes', () => {
		expect(isIsoDate('2024-02-29')).toBe(true);
		expect(isIsoDate('2023-02-29')).toBe(false);
		expect(isIsoDate('2023-13-01')).toBe(false);
		expect(isIsoDate('2023-1-01')).toBe(false);
		expect(() => toEpochDay('2023-02-30')).toThrow(RangeError);
	});

	it('counts February by the leap-year rule, 1900 and 2100 not leap, 2000 leap', () => {
		expect([1900, 2000, 2023, 2024, 2100].map((y) => daysInMonth(y, 2))).toEqual([28, 29, 28, 29, 28]);
		expect(daysInMonth(2025, 12)).toBe(31);
	});
});
