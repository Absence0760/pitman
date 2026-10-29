import { describe, expect, it } from 'vitest';
import { DEFAULT_MODE_CHOICE, isModeChoice, modeId, modeLabel, modesFromChoice } from './modes.js';

describe('modesFromChoice', () => {
	it('defaults to present day 2025 and natural, for the side-by-side comparison', () => {
		expect(modesFromChoice(DEFAULT_MODE_CHOICE)).toEqual({ ok: true, modes: [{ kind: 'presentDay', year: 2025 }, { kind: 'natural' }] });
	});

	it('returns every ticked mode in the engine order', () => {
		const all = { presentDay: true, presentDayYear: ' 2010 ', natural: true, historical: true };
		expect(modesFromChoice(all)).toEqual({ ok: true, modes: [{ kind: 'presentDay', year: 2010 }, { kind: 'natural' }, { kind: 'historical' }] });
	});

	it.each(['', '20x5', '25', '1899', '2101', '2025.5'])('rejects present-day year %j', (year) => {
		expect(modesFromChoice({ ...DEFAULT_MODE_CHOICE, presentDayYear: year })).toMatchObject({ ok: false, field: 'year' });
	});

	it('ignores the year when present day is not ticked', () => {
		expect(modesFromChoice({ presentDay: false, presentDayYear: 'x', natural: false, historical: true })).toEqual({ ok: true, modes: [{ kind: 'historical' }] });
	});

	it('asks for at least one mode', () => {
		expect(modesFromChoice({ presentDay: false, presentDayYear: '2025', natural: false, historical: false })).toMatchObject({ ok: false, field: 'modes' });
	});
});

describe('labels and ids', () => {
	it('names each mode', () => {
		expect([modeLabel({ kind: 'presentDay', year: 2025 }), modeLabel({ kind: 'natural' }), modeLabel({ kind: 'historical' })]).toEqual([
			'Present day (2025)',
			'Natural',
			'Historical'
		]);
		expect([modeId({ kind: 'presentDay', year: 2025 }), modeId({ kind: 'natural' })]).toEqual(['presentDay-2025', 'natural']);
	});

	it('recognises a stored choice', () => {
		expect(isModeChoice(DEFAULT_MODE_CHOICE)).toBe(true);
		expect(isModeChoice({ presentDay: true })).toBe(false);
		expect(isModeChoice(null)).toBe(false);
	});
});
