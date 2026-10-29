import { describe, expect, it } from 'vitest';
import { formatDateTime, plural } from './format.js';

describe('formatDateTime', () => {
	it('shows a date and time, never raw ISO', () => {
		const text = formatDateTime('2026-10-29T08:00:00Z');
		expect(text).not.toContain('T08');
		expect(text).toMatch(/2026/);
	});

	it('falls back to the text it was given', () => {
		expect(formatDateTime('not a date')).toBe('not a date');
	});
});

describe('plural', () => {
	it('picks the word by count', () => {
		expect([plural(1, 'file'), plural(3, 'file'), plural(2, 'reach', 'reaches')]).toEqual(['1 file', '3 files', '2 reaches']);
	});
});
