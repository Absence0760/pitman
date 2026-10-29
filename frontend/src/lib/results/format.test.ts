import { describe, expect, it } from 'vitest';
import { calendarYear, formatNumber, hydroYearLabel, monthLabel, runLabel, runSlug } from './format.js';

describe('format', () => {
	it('labels hydrological years October to September', () => {
		expect(hydroYearLabel(1990)).toBe('1990/91');
		expect(hydroYearLabel(1999)).toBe('1999/00');
		expect([calendarYear(1990, 0), calendarYear(1990, 2), calendarYear(1990, 3), calendarYear(1990, 11)]).toEqual([1990, 1990, 1991, 1991]);
		expect(monthLabel(1990, 0)).toBe('Oct 1990');
		expect(monthLabel(1990, 3)).toBe('Jan 1991');
	});

	it('names the run modes', () => {
		expect(runLabel({ kind: 'presentDay', year: 2025 })).toBe('Present day (2025)');
		expect(runLabel({ kind: 'natural' })).toBe('Natural');
		expect(runLabel({ kind: 'historical' })).toBe('Historical');
		expect(runSlug({ kind: 'presentDay', year: 2025 })).toBe('present-2025');
		expect(runSlug({ kind: 'natural' })).toBe('natural');
	});

	it('formats numbers with a dash for no value and no negative zero', () => {
		expect(formatNumber(1.005, 1)).toBe('1.0');
		expect(formatNumber(-0.001)).toBe('0.00');
		expect(formatNumber(null)).toBe('—');
		expect(formatNumber(Number.NaN)).toBe('—');
	});
});
