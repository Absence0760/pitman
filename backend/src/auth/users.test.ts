// The Users page's API and the audit log through the whole app, on auth-kit's memory store: admin-only,
// auth-kit's refusals surfaced with their status, and exactly one audit row per change. The races run for
// real on DynamoDB Local in dynamo.test.ts.
import { memoryStore, type MemoryStore, type UserRecord } from '@absence0760/auth-kit';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { guardLogs } from '../__tests__/logGuard.js';
import { ADMIN, bootstrap, cookieFor, TEST_ORIGIN, testAuth, type TestAuth } from '../__tests__/session.js';

guardLogs();

const many = { limit: 100_000, windowMs: 60_000 };
const USER = 'user@example.test';
const OTHER = 'other@example.test';

async function setUp(store?: MemoryStore) {
	const t = testAuth(store ? { store } : {});
	const admin = await bootstrap(t);
	const a = createApp({ auth: t.auth, rateLimits: { chirps: many, mapGrid: many, auth: many } });
	const req = (method: string, path: string, cookie: string, body?: unknown) =>
		a.request(path, {
			method,
			headers: { origin: TEST_ORIGIN, cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
			...(body !== undefined ? { body: JSON.stringify(body) } : {})
		});
	const as = async (user: UserRecord) => {
		const cookie = await cookieFor(t, user);
		return {
			get: (path: string) => req('GET', path, cookie),
			post: (path: string, body: unknown) => req('POST', path, cookie, body),
			patch: (path: string, body: unknown) => req('PATCH', path, cookie, body),
			del: (path: string) => req('DELETE', path, cookie)
		};
	};
	return { t, admin, a, as };
}

const auditRows = (t: TestAuth) => t.store.dump().filter((i) => i.pk === 'AUDIT').length;

async function add(t: TestAuth, actor: UserRecord, email: string, isAdmin: boolean) {
	const r = await t.auth.kit.addUser(actor, email, isAdmin);
	if (!r.ok) throw new Error(r.error);
	return r.value;
}

describe('/users and /audit', () => {
	it('lets an admin add, list, promote, demote and remove users, each change one audit row', async () => {
		const { t, admin, as } = await setUp();
		const api = await as(admin);
		let rows = auditRows(t);

		// Audit rows sort by time: move the clock a second before each change.
		const tick = () => t.clock.advance(1000);
		tick();
		const created = await api.post('/users', { email: ` ${USER.toUpperCase()} ` });
		expect(created.status).toBe(201);
		const { user } = (await created.json()) as { user: { id: string } };
		expect(user).toEqual({ id: expect.any(String), email: USER, isAdmin: false, addedBy: ADMIN, addedAt: '2026-11-07T08:00:01.000Z' });
		expect(auditRows(t)).toBe(++rows);

		const list = await api.get('/users');
		expect(list.status).toBe(200);
		expect(await list.json()).toEqual({
			users: [
				{ id: admin.id, email: ADMIN, isAdmin: true, addedBy: 'operator', addedAt: admin.addedAt },
				{ id: user.id, email: USER, isAdmin: false, addedBy: ADMIN, addedAt: '2026-11-07T08:00:01.000Z' }
			]
		});

		tick();
		const promoted = await api.patch(`/users/${user.id}`, { isAdmin: true });
		expect(promoted.status).toBe(200);
		expect(await promoted.json()).toEqual({ user: expect.objectContaining({ id: user.id, isAdmin: true }) });
		expect(auditRows(t)).toBe(++rows);
		// Asking for the state it already has changes and records nothing.
		expect((await api.patch(`/users/${user.id}`, { isAdmin: true })).status).toBe(200);
		expect(auditRows(t)).toBe(rows);

		tick();
		expect((await api.patch(`/users/${user.id}`, { isAdmin: false })).status).toBe(200);
		expect(auditRows(t)).toBe(++rows);

		tick();
		expect((await api.del(`/users/${user.id}`)).status).toBe(204);
		expect(auditRows(t)).toBe(++rows);
		expect(((await (await api.get('/users')).json()) as { users: unknown[] }).users).toHaveLength(1);

		const audit = await api.get('/audit?limit=10');
		expect(audit.status).toBe(200);
		const body = (await audit.json()) as { rows: Record<string, unknown>[] };
		expect(body.rows.map((r) => r.action)).toEqual(['remove', 'remove admin', 'make admin', 'add', 'bootstrap']);
		expect(body.rows[3]).toEqual({ at: '2026-11-07T08:00:01.000Z', actor: ADMIN, action: 'add', target: USER, admin: false });
		expect(Object.keys(body.rows[0]!).sort()).toEqual(['action', 'actor', 'at', 'target']);
	});

	it('refuses everything to a signed-in user who is not an admin, with 403', async () => {
		const { t, admin, as } = await setUp();
		const user = await add(t, admin, USER, false);
		const api = await as(user);
		const rows = auditRows(t);
		for (const res of [await api.get('/users'), await api.post('/users', { email: OTHER }), await api.patch(`/users/${admin.id}`, { isAdmin: false }), await api.del(`/users/${admin.id}`), await api.get('/audit')]) {
			expect(res.status).toBe(403);
			expect(await res.json()).toEqual({ error: 'Only an admin can manage users.' });
		}
		expect(auditRows(t)).toBe(rows);
		// /auth/me still works for them.
		expect(await (await api.get('/auth/me')).json()).toEqual({ user: { id: user.id, email: USER, isAdmin: false } });
	});

	it('surfaces auth-kit’s refusals: yourself (400), unknown (404), taken (409), bad input (400)', async () => {
		const { t, admin, as } = await setUp();
		const api = await as(admin);
		const rows = auditRows(t);
		const self = await api.del(`/users/${admin.id}`);
		expect(self.status).toBe(400);
		expect(await self.json()).toEqual({ error: 'You cannot remove yourself. Ask another admin.' });
		const selfDemote = await api.patch(`/users/${admin.id}`, { isAdmin: false });
		expect(selfDemote.status).toBe(400);
		expect(await selfDemote.json()).toEqual({ error: 'You cannot remove your own admin rights. Ask another admin.' });
		expect((await api.patch('/users/no-such-id', { isAdmin: true })).status).toBe(404);
		expect((await api.del('/users/no-such-id')).status).toBe(404);
		const taken = await api.post('/users', { email: ADMIN });
		expect(taken.status).toBe(409);
		expect(await taken.json()).toEqual({ error: `${ADMIN} is already on the list.` });
		expect((await api.post('/users', { email: 'not an address' })).status).toBe(400);
		expect((await api.post('/users', { email: USER, isAdmin: 'yes' })).status).toBe(400);
		expect((await api.patch(`/users/${admin.id}`, {})).status).toBe(400);
		expect((await api.post('/users', [USER])).status).toBe(400);
		for (const limit of ['0', '1001', 'abc', '-1', '1.5']) expect((await api.get(`/audit?limit=${limit}`)).status, limit).toBe(400);
		expect(auditRows(t)).toBe(rows);
	});

	it('keeps an admin when two admins demote each other at once: one wins, the other gets 409', async () => {
		// Both requests pass the gate and read their target before either writes: a barrier on the store's
		// setAdmin holds the first until the second arrives, so the race is the real one every time.
		const inner = memoryStore();
		let waiting: (() => void) | null = null;
		const store = new Proxy(inner, {
			get(target, prop, receiver) {
				const v = Reflect.get(target, prop, receiver) as unknown;
				if (prop !== 'setAdmin' || typeof v !== 'function') return v;
				return async (...args: unknown[]) => {
					if (waiting) waiting();
					else await new Promise<void>((resolve) => (waiting = resolve));
					return (v as (...a: unknown[]) => unknown).apply(target, args);
				};
			}
		});
		const { t, admin, as } = await setUp(store);
		const second = await add(t, admin, OTHER, true);
		const [first, other] = [await as(admin), await as(second)];
		const rows = auditRows(t);
		const answers = await Promise.all([first.patch(`/users/${second.id}`, { isAdmin: false }), other.patch(`/users/${admin.id}`, { isAdmin: false })]);
		expect(answers.map((r) => r.status).sort()).toEqual([200, 409]);
		const refused = answers.find((r) => r.status === 409)!;
		expect(await refused.json()).toEqual({ error: expect.stringMatching(/admin rights changed|at least one admin/) });
		expect(await t.store.adminCount()).toBe(1);
		expect(auditRows(t)).toBe(rows + 1);
	});

	it('signs a removed user out on their next request, and a demoted admin loses the Users page', async () => {
		const { t, admin, as } = await setUp();
		const user = await add(t, admin, USER, true);
		const them = await as(user);
		expect((await them.get('/users')).status).toBe(200);
		const api = await as(admin);
		await api.patch(`/users/${user.id}`, { isAdmin: false });
		expect((await them.get('/users')).status).toBe(403);
		await api.del(`/users/${user.id}`);
		expect((await them.get('/auth/me')).status).toBe(401);
	});
});
