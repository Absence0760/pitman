import { describe, expect, it } from 'vitest';
import { Session } from './session.svelte.js';

const USER = { id: 'u1', email: 'someone@example.test', isAdmin: true };

/** A fake API: each path answers from `routes`; every call is recorded. */
function api(routes: Record<string, () => Response | Promise<Response>>) {
	const calls: string[] = [];
	const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const path = String(input).replace(/^\/api/, '');
		calls.push(`${init?.method ?? 'GET'} ${path}`);
		const answer = routes[path];
		if (!answer) throw new Error(`no route ${path}`);
		return answer();
	}) as typeof fetch;
	return { calls, session: new Session({ baseUrl: '/api', fetch: f }) };
}

const json = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('the session store', () => {
	it('starts unknown, then says who is signed in', async () => {
		const { session } = api({ '/auth/me': () => json(200, { user: USER }) });
		expect(session.status).toBe('unknown');
		const asking = session.me();
		expect(session.status).toBe('checking');
		expect(await asking).toEqual(USER);
		expect(session.status).toBe('in');
		expect(session.user).toEqual(USER);
		expect(session.isAdmin).toBe(true);
	});

	it('a 401 from me is signed out, not an error', async () => {
		const { session } = api({ '/auth/me': () => json(401, { error: 'Not signed in.' }) });
		expect(await session.me()).toBeNull();
		expect(session.status).toBe('out');
		expect(session.isAdmin).toBe(false);
	});

	it('an unreachable or failing API is an error, so nobody is sent away', async () => {
		const { session } = api({ '/auth/me': () => json(503, { error: 'not configured' }) });
		await expect(session.me()).rejects.toThrow(/HTTP 503/);
		expect(session.status).toBe('error');
		expect(session.user).toBeNull();
	});

	it('calls made while one is in flight share it', async () => {
		let release!: (r: Response) => void;
		const { calls, session } = api({ '/auth/me': () => new Promise<Response>((r) => (release = r)) });
		const a = session.me();
		const b = session.me();
		release(json(200, { user: USER }));
		expect(await a).toEqual(await b);
		expect(calls).toEqual(['GET /auth/me']);
	});

	it('requests a code, then verifies it and is signed in', async () => {
		const { calls, session } = api({ '/auth/code': () => json(202, {}), '/auth/verify': () => json(200, { user: { ...USER, isAdmin: false } }) });
		await session.requestCode('someone@example.test');
		expect(session.status).toBe('unknown');
		await session.verify('someone@example.test', '123456');
		expect(session.status).toBe('in');
		expect(session.isAdmin).toBe(false);
		expect(calls).toEqual(['POST /auth/code', 'POST /auth/verify']);
	});

	it('a wrong code leaves the session as it was', async () => {
		const { session } = api({ '/auth/verify': () => json(401, { error: 'That code is wrong.' }) });
		await expect(session.verify('a@b.test', '000000')).rejects.toThrow('That code is wrong.');
		expect(session.status).toBe('unknown');
	});

	it('signs out, even when the API can’t be reached', async () => {
		const ok = api({ '/auth/me': () => json(200, { user: USER }), '/auth/logout': () => json(204) });
		await ok.session.me();
		await ok.session.logout();
		expect(ok.session.status).toBe('out');
		expect(ok.session.user).toBeNull();

		const down = api({ '/auth/me': () => json(200, { user: USER }), '/auth/logout': () => json(502) });
		await down.session.me();
		await expect(down.session.logout()).rejects.toThrow();
		expect(down.session.status).toBe('out');
	});

	it('signs out everywhere, and stays signed in if that fails', async () => {
		const ok = api({ '/auth/me': () => json(200, { user: USER }), '/auth/logout-everywhere': () => json(204) });
		await ok.session.me();
		await ok.session.logoutEverywhere();
		expect(ok.session.status).toBe('out');
		expect(ok.calls).toContain('POST /auth/logout-everywhere');

		const down = api({ '/auth/me': () => json(200, { user: USER }), '/auth/logout-everywhere': () => json(500) });
		await down.session.me();
		await expect(down.session.logoutEverywhere()).rejects.toThrow();
		expect(down.session.status).toBe('in');
	});

	it('a lapsed session from a data call signs out', async () => {
		const { session } = api({ '/auth/me': () => json(200, { user: USER }) });
		await session.me();
		session.signedOut();
		expect(session.status).toBe('out');
		expect(session.user).toBeNull();
	});
});
