import { describe, expect, it } from 'vitest';
import { errorSummary } from './logError.js';

describe('errorSummary (A-AUTH-11)', () => {
	it('keeps the name and an AWS-style code, never the message', () => {
		const e = Object.assign(new Error('Email address is not verified: someone@example.test'), { name: 'MessageRejected', $fault: 'client', Code: 'MessageRejected' });
		expect(errorSummary(e)).toEqual({ error: 'MessageRejected', code: 'MessageRejected' });
		expect(JSON.stringify(errorSummary(e))).not.toContain('@');
	});

	it('drops a name or code that is not a plain identifier, and says what a non-error was', () => {
		expect(errorSummary(Object.assign(new Error('x'), { name: 'to someone@example.test', code: 'a b@c.d' }))).toEqual({ error: 'Error' });
		expect(errorSummary('someone@example.test')).toEqual({ error: 'string' });
		expect(errorSummary(undefined)).toEqual({ error: 'undefined' });
	});
});
