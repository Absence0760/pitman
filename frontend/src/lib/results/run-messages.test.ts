import { describe, expect, it } from 'vitest';
import type { RunMessage, RunResult } from '@pitman/wrsm';
import { groupRunMessages, groupSpan, messageSummary } from './run-messages.js';

const run = (kind: 'historical' | 'natural', messages: RunMessage[]) => ({ mode: { kind }, startYear: 1920, endYear: 1921, routeFlows: {}, reservoirStorage: {}, messages }) as unknown as RunResult;
const dry = (year: number, month: string, amount: string): RunMessage => ({
	level: 'warning',
	module: { type: 'RV', number: 3 },
	at: { year, month: 1 },
	text: `Water balance error in ${month} ${year}: not enough water. Shortfall (million m³): calculated ${amount}.`
});

describe('groupRunMessages', () => {
	it('folds one complaint across months into one group, with its span', () => {
		const [group, ...rest] = groupRunMessages([run('historical', [dry(1920, 'Nov', '0.123'), dry(1921, 'Feb', '0.456')])]);
		expect(rest).toEqual([]);
		expect(group).toMatchObject({ level: 'warning', module: 'RV 3', count: 2, firstYear: 1920, lastYear: 1921 });
		expect(groupSpan(group!)).toMatch(/^in 2 months, 1920.* to 1921/);
	});

	it('keeps different modules, and different wording, apart', () => {
		const other: RunMessage = { ...dry(1920, 'Nov', '0.1'), module: { type: 'RV', number: 6 } };
		const words: RunMessage = { level: 'warning', module: { type: 'RV', number: 3 }, text: 'Something else' };
		expect(groupRunMessages([run('historical', [dry(1920, 'Nov', '0.1'), other, words])])).toHaveLength(3);
	});

	it('names the modes a group came from', () => {
		const groups = groupRunMessages([run('historical', [dry(1920, 'Nov', '0.1')]), run('natural', [dry(1920, 'Nov', '0.1')])]);
		expect(groups).toHaveLength(1);
		expect(groups[0]!.modes).toHaveLength(2);
		expect(groups[0]!.count).toBe(1); // one month, said by two modes
	});

	it("doesn't name a module its own text already names", () => {
		const [group] = groupRunMessages([run('historical', [{ level: 'warning', module: { type: 'RR', number: 4 }, text: 'RR 4 (a block): something' }])]);
		expect(group!.module).toBe('');
	});

	it('puts errors first, then warnings, then notes', () => {
		const groups = groupRunMessages([run('historical', [{ level: 'info', text: 'a' }, dry(1920, 'Nov', '0.1'), { level: 'error', text: 'b' }])]);
		expect(groups.map((g) => g.level)).toEqual(['error', 'warning', 'info']);
	});
});

describe('messageSummary', () => {
	it('counts groups and leaves notes out', () => {
		const groups = groupRunMessages([run('historical', [{ level: 'info', text: 'a' }, dry(1920, 'Nov', '0.1'), { level: 'error', text: 'b' }])]);
		expect(messageSummary(groups)).toBe('1 error and 1 warning');
		expect(messageSummary(groupRunMessages([run('historical', [{ level: 'info', text: 'a' }])]))).toBe('');
	});
});

it('says nothing of a span for a message that occurs once', () => {
	expect(groupSpan(groupRunMessages([run('historical', [dry(1920, 'Nov', '0.1')])])[0]!)).toBe('');
});
