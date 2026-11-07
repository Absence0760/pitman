// A-AUTH-11: logs carry no personal data. Every auth test file calls guardLogs(): console is spied for the
// whole file, and each test fails if any line it logged holds an email address. Lines stay visible in the
// test output (the spies call through), so a failure shows what leaked.
import { afterEach, beforeEach, expect, vi, type MockInstance } from 'vitest';

const ADDRESS = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+/;

const text = (args: unknown[]) =>
	args
		.map((a) => {
			if (typeof a === 'string') return a;
			if (a instanceof Error) return `${a.name}: ${a.message}\n${a.stack ?? ''}`;
			try {
				return JSON.stringify(a);
			} catch {
				return String(a);
			}
		})
		.join(' ');

let spies: MockInstance[] = [];

/** Every line logged so far in the current test, for tests that check what was logged. */
export const linesLogged = () => spies.flatMap((s) => s.mock.calls.map((call) => text(call as unknown[])));

/** The JSON event lines logged so far in the current test. */
export const eventsLogged = () =>
	linesLogged().flatMap((l) => {
		try {
			const v: unknown = JSON.parse(l);
			return v && typeof v === 'object' && 'event' in v ? [v as Record<string, unknown>] : [];
		} catch {
			return [];
		}
	});

export function guardLogs() {
	beforeEach(() => {
		spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m));
	});
	afterEach(() => {
		const leaks = linesLogged().filter((l) => ADDRESS.test(l));
		spies.forEach((s) => s.mockRestore());
		spies = [];
		expect(leaks, 'an email address was logged').toEqual([]);
	});
}
