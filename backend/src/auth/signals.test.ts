// The alarm signals read from auth-kit v0.2.0's fields (signals.ts), and v0.1.2's behaviour kept until the bump.
import { describe, expect, it } from 'vitest';
import { lockAlarm, sendCapped } from './signals.js';

describe('sendCapped (auth.send_capped)', () => {
	it('is true only when a listed address has just reached its daily cap', () => {
		expect(sendCapped({ status: 'throttled', limit: 'day', capReached: true, listed: true })).toBe(true);
	});

	it.each([
		[{ status: 'throttled', limit: 'day', capReached: true, listed: false }],
		[{ status: 'throttled', limit: 'day', listed: true }],
		[{ status: 'throttled', limit: 'hour', capReached: true, listed: true }],
		[{ status: 'throttled', limit: 'interval', listed: true }],
		[{ status: 'accepted', listed: true }],
		// auth-kit v0.1.2: none of the fields.
		[{ status: 'throttled' }]
	] as const)('is false for %j', (r) => {
		expect(sendCapped(r)).toBe(false);
	});
});

describe('lockAlarm (auth.locked)', () => {
	it('counts a listed address’s lock start, never an unlisted one’s (v0.2.0)', () => {
		expect(lockAlarm({ status: 'locked', lockStarted: true, listed: true })).toBe(true);
		expect(lockAlarm({ status: 'locked', lockStarted: true, listed: false })).toBe(false);
	});

	it('counts every lock start while auth-kit says nothing about listing (v0.1.2)', () => {
		expect(lockAlarm({ status: 'locked', lockStarted: true })).toBe(true);
	});

	it('never counts a request during a lock, or anything but a lock', () => {
		expect(lockAlarm({ status: 'locked', lockStarted: false, listed: true })).toBe(false);
		expect(lockAlarm({ status: 'invalid' })).toBe(false);
		expect(lockAlarm({ status: 'ok' })).toBe(false);
	});
});
