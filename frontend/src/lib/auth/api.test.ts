import { afterEach, describe, expect, it } from 'vitest';
import { addUser, AuthRequestError, clearDeliveryProblem, fetchMe, listAudit, listUsers, removeUser, requestCode, retryAfterSeconds, setAdmin, verifyCode, waitText } from './api.js';
import { onUnauthorized } from './unauthorized.js';

interface Call {
	url: string;
	method: string;
	body: unknown;
	headers: Record<string, string>;
}

function fake(status: number, body?: unknown, headers: Record<string, string> = {}) {
	const calls: Call[] = [];
	const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
		calls.push({ url: String(input), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: (init?.headers ?? {}) as Record<string, string> });
		return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
	}) as typeof fetch;
	return { calls, options: { baseUrl: '/api', fetch: f } };
}

const USER = { id: 'u1', email: 'someone@example.test', isAdmin: false };

async function refusal(promise: Promise<unknown>): Promise<AuthRequestError> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(AuthRequestError);
		return error as AuthRequestError;
	}
	throw new Error('expected a refusal');
}

describe('the sign-in calls', () => {
	it('send the address and the code as JSON to the API base', async () => {
		const a = fake(202, {});
		await requestCode('someone@example.test', a.options);
		expect(a.calls[0]).toMatchObject({ url: '/api/auth/code', method: 'POST', body: { email: 'someone@example.test' } });
		expect(a.calls[0]!.headers['content-type']).toBe('application/json');

		const b = fake(200, { user: USER });
		expect(await verifyCode('someone@example.test', '123456', b.options)).toEqual(USER);
		expect(b.calls[0]).toMatchObject({ url: '/api/auth/verify', method: 'POST', body: { email: 'someone@example.test', code: '123456' } });
	});

	it('state each body’s SHA-256, which CloudFront’s signed requests to the API need (issue #33)', async () => {
		const { createHash } = await import('node:crypto');
		const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
		const a = fake(202, {});
		await requestCode('someone@example.test', a.options);
		expect(a.calls[0]!.headers['x-amz-content-sha256']).toBe(sha256(JSON.stringify({ email: 'someone@example.test' })));
		const b = fake(200, { user: USER });
		await verifyCode('someone@example.test', '123456', b.options);
		expect(b.calls[0]!.headers['x-amz-content-sha256']).toBe(sha256(JSON.stringify({ email: 'someone@example.test', code: '123456' })));
		// A gated write too, and a POST with no body hashes zero bytes.
		const c = fake(200, { user: USER });
		await addUser('new@example.test', false, c.options);
		expect(c.calls[0]!.headers['x-amz-content-sha256']).toBe(sha256(JSON.stringify({ email: 'new@example.test', isAdmin: false })));
		const d = fake(204);
		await removeUser('u1', d.options);
		expect(d.calls[0]!.headers['x-amz-content-sha256']).toBe(sha256(''));
	});

	it('show the API’s own sentence for a 400 or 401', async () => {
		expect((await refusal(requestCode('x', fake(400, { error: 'That is not an email address.' }).options))).message).toBe('That is not an email address.');
		const wrong = await refusal(verifyCode('a@b.test', '000000', fake(401, { error: 'That code is wrong or has expired.' }).options));
		expect(wrong.status).toBe(401);
		expect(wrong.message).toBe('That code is wrong or has expired.');
	});

	it('say how long to wait on a 429', async () => {
		const busy = await refusal(requestCode('a@b.test', fake(429, { error: 'slow down' }, { 'retry-after': '120' }).options));
		expect(busy.retryAfter).toBe(120);
		expect(busy.message).toBe('Too many tries. Wait about 2 minutes, then try again.');
		expect((await refusal(requestCode('a@b.test', fake(429, {}).options))).message).toMatch(/Wait a few minutes/);
	});

	it('a wrong code does not count as a lapsed session', async () => {
		let heard = 0;
		const off = onUnauthorized(() => heard++);
		await refusal(verifyCode('a@b.test', '000000', fake(401, { error: 'wrong' }).options));
		expect(await fetchMe(fake(401, { error: 'not signed in' }).options)).toBeNull();
		off();
		expect(heard).toBe(0);
	});

	it('me answers the user, or null when signed out, and fails on anything else', async () => {
		expect(await fetchMe(fake(200, { user: { ...USER, extra: 1 } }).options)).toEqual(USER);
		expect(await fetchMe(fake(401).options)).toBeNull();
		expect((await refusal(fetchMe(fake(503).options))).status).toBe(503);
		expect((await refusal(fetchMe(fake(200, { user: { id: 1 } }).options))).message).toMatch(/can’t read/);
	});

	it('an unreachable server is said in words', async () => {
		const down = (async () => {
			throw new TypeError('fetch failed');
		}) as typeof fetch;
		const e = await refusal(requestCode('a@b.test', { baseUrl: '/api', fetch: down }));
		expect(e.status).toBe(0);
		expect(e.message).toMatch(/could not reach/);
	});
});

describe('the user calls', () => {
	let off: (() => void) | undefined;
	afterEach(() => off?.());

	it('list, add, change and remove users', async () => {
		const listed = { ...USER, addedBy: 'operator', addedAt: '2026-11-07T10:00:00Z', undeliverable: null };
		const a = fake(200, { users: [listed] });
		expect(await listUsers(a.options)).toEqual([listed]);
		expect(a.calls[0]!.url).toBe('/api/users');

		const b = fake(201, { user: { ...USER, isAdmin: true } });
		expect((await addUser('someone@example.test', true, b.options)).isAdmin).toBe(true);
		expect(b.calls[0]).toMatchObject({ method: 'POST', body: { email: 'someone@example.test', isAdmin: true } });

		const c = fake(200, {});
		await setAdmin('u/1', false, c.options);
		expect(c.calls[0]).toMatchObject({ url: '/api/users/u%2F1', method: 'PATCH', body: { isAdmin: false } });

		const d = fake(204);
		await removeUser('u1', d.options);
		expect(d.calls[0]).toMatchObject({ url: '/api/users/u1', method: 'DELETE' });
	});

	it('read a bounce or complaint flag, null for none or anything else, and clear it with an empty JSON POST', async () => {
		const at = '2026-11-07T10:00:00Z';
		const users = [
			{ ...USER, addedBy: 'operator', addedAt: at, undeliverable: { kind: 'bounce', at } },
			{ ...USER, id: 'u2', addedBy: 'operator', addedAt: at, undeliverable: { kind: 'complaint', at } },
			{ ...USER, id: 'u3', addedBy: 'operator', addedAt: at },
			{ ...USER, id: 'u4', addedBy: 'operator', addedAt: at, undeliverable: { kind: 'other', at } }
		];
		expect((await listUsers(fake(200, { users }).options)).map((u) => u.undeliverable)).toEqual([{ kind: 'bounce', at }, { kind: 'complaint', at }, null, null]);

		const c = fake(200, { user: { ...USER, undeliverable: null } });
		await clearDeliveryProblem('u/1', c.options);
		expect(c.calls[0]).toMatchObject({ url: '/api/users/u%2F1/clear-delivery-problem', method: 'POST', body: {} });
		expect(c.calls[0]!.headers['content-type']).toBe('application/json');
		expect((await refusal(clearDeliveryProblem('u1', fake(409, { error: 'A newer problem arrived.' }).options))).message).toBe('A newer problem arrived.');
	});

	it('show a 409 or 403 sentence as it is', async () => {
		expect((await refusal(setAdmin('u1', false, fake(409, { error: 'Pitman needs at least one admin.' }).options))).message).toBe('Pitman needs at least one admin.');
		expect((await refusal(listUsers(fake(403, { error: 'Only an admin can see the user list.' }).options))).message).toBe('Only an admin can see the user list.');
		expect((await refusal(removeUser('u1', fake(409).options))).message).toMatch(/changed the list at the same moment/);
	});

	it('a 401 sends the user to sign-in', async () => {
		let heard = 0;
		off = onUnauthorized(() => heard++);
		await refusal(listUsers(fake(401).options));
		expect(heard).toBe(1);
	});

	it('read the audit log with a limit', async () => {
		const rows = [{ at: '2026-11-07T10:00:00Z', actor: 'operator', action: 'bootstrap', target: 'a@b.test' }];
		const a = fake(200, { rows });
		expect(await listAudit(50, a.options)).toEqual(rows);
		expect(a.calls[0]!.url).toBe('/api/audit?limit=50');
		expect((await refusal(listAudit(50, fake(200, { rows: [{ at: 1 }] }).options))).message).toMatch(/audit log/);
	});
});

describe('Retry-After', () => {
	it('reads seconds or a date', () => {
		expect(retryAfterSeconds('45')).toBe(45);
		expect(retryAfterSeconds(null)).toBeUndefined();
		expect(retryAfterSeconds('soon')).toBeUndefined();
		const now = Date.parse('2026-11-07T10:00:00Z');
		expect(retryAfterSeconds('Sat, 07 Nov 2026 10:01:30 GMT', now)).toBe(90);
		expect(retryAfterSeconds('Sat, 07 Nov 2026 09:00:00 GMT', now)).toBe(0);
	});

	it('says the wait in words', () => {
		expect(waitText(1)).toBe('1 second');
		expect(waitText(45)).toBe('45 seconds');
		expect(waitText(60)).toBe('about 1 minute');
		expect(waitText(61)).toBe('about 2 minutes');
		expect(waitText(900)).toBe('about 15 minutes');
		expect(waitText(3600)).toBe('about 1 hour');
		expect(waitText(5400)).toBe('about 2 hours');
	});
});
