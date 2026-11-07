// Sign-in through the whole app (createApp, memory store, a clock the test moves; never a real sleep):
// the code and verify routes, the cookie, the gate on every data route, the request checks (csrf, JSON
// only, no-store) and failing closed. auth-kit's own rules have their contract suite in auth-kit; these
// test that pitman wires them: statuses, headers, the latency floor and the logs.
import { memoryStore, type Store } from '@absence0760/auth-kit';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { eventsLogged, guardLogs } from '../__tests__/logGuard.js';
import { ADMIN, bootstrap, cookieFor, TEST_ORIGIN, testAuth, type TestAuth } from '../__tests__/session.js';
import { NOT_CONFIGURED } from './middleware.js';
import { authRuntimeFromEnv, type AuthRuntime } from './runtime.js';

guardLogs();

const many = { limit: 100_000, windowMs: 60_000 };
const STRANGER = 'nobody@example.test';
const app = (t: { auth: AuthRuntime }) =>
	createApp({ auth: t.auth, rateLimits: { chirps: many, mapGrid: many, auth: many } });

type App = ReturnType<typeof createApp>;
interface Call {
	body?: unknown;
	cookie?: string;
	origin?: string | null;
	headers?: Record<string, string>;
}
function call(a: App, method: string, path: string, opts: Call = {}) {
	const headers = new Headers(opts.headers);
	if (opts.origin !== null) headers.set('origin', opts.origin ?? TEST_ORIGIN);
	if (opts.cookie) headers.set('cookie', opts.cookie);
	if (opts.body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json');
	const body = opts.body === undefined ? undefined : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
	return a.request(path, { method, headers, ...(body !== undefined ? { body } : {}) });
}
const askCode = (a: App, email: string) => call(a, 'POST', '/auth/code', { body: { email } });
const verify = (a: App, email: string, code: string) => call(a, 'POST', '/auth/verify', { body: { email, code } });
/** The cookie a Set-Cookie value sets, as the browser sends it back. */
const sent = (setCookie: string | null) => setCookie!.split(';')[0]!;
const wrongCode = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, '0');

async function signIn(t: TestAuth, a: App, email = ADMIN) {
	expect((await askCode(a, email)).status).toBe(202);
	const res = await verify(a, email, t.outbox.at(-1)!.code);
	expect(res.status).toBe(200);
	return sent(res.headers.get('set-cookie'));
}

describe('POST /auth/code and POST /auth/verify', () => {
	it('mails a code to a listed address, signs in with it, and sets the __Host- session cookie', async () => {
		const t = testAuth();
		const admin = await bootstrap(t);
		const a = app(t);
		const asked = await askCode(a, ' Admin@Example.test ');
		expect(asked.status).toBe(202);
		expect(await asked.json()).toEqual({});
		expect(t.outbox).toEqual([{ to: ADMIN, code: expect.stringMatching(/^\d{6}$/) }]);

		const res = await verify(a, ADMIN, t.outbox[0]!.code);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ user: { id: admin.id, email: ADMIN, isAdmin: true } });
		const cookie = res.headers.get('set-cookie')!;
		const [pair, ...attributes] = cookie.split('; ');
		expect(pair).toMatch(/^__Host-pitman_session=[A-Za-z0-9._-]+$/);
		expect(attributes.sort()).toEqual(['HttpOnly', 'Max-Age=604800', 'Path=/', 'SameSite=Strict', 'Secure']);
		expect(cookie).not.toMatch(/Domain=/i);

		const me = await call(a, 'GET', '/auth/me', { cookie: sent(cookie) });
		expect(me.status).toBe(200);
		expect(await me.json()).toEqual({ user: { id: admin.id, email: ADMIN, isAdmin: true } });
	});

	it('uses a plain pitman_session cookie, without Secure, only when the dev flag says so', async () => {
		const t = testAuth({ devCookie: true });
		await bootstrap(t);
		const a = app(t);
		await askCode(a, ADMIN);
		const res = await verify(a, ADMIN, t.outbox[0]!.code);
		const cookie = res.headers.get('set-cookie')!;
		expect(cookie).toMatch(/^pitman_session=[A-Za-z0-9._-]+; /);
		expect(cookie.split('; ').slice(1).sort()).toEqual(['HttpOnly', 'Max-Age=604800', 'Path=/', 'SameSite=Strict']);
		expect((await call(a, 'GET', '/auth/me', { cookie: sent(cookie) })).status).toBe(200);
		// The production name isn't read in dev, nor the dev name in production.
		expect((await call(a, 'GET', '/auth/me', { cookie: `__Host-${sent(cookie)}` })).status).toBe(401);
		expect((await call(app(testAuth()), 'GET', '/auth/me', { cookie: sent(cookie) })).status).toBe(401);
	});

	it('answers a listed and an unknown address identically, after the same floor, with the same store work', async () => {
		const calls: string[][] = [];
		let current: string[] = [];
		const counted = (store: Store): Store =>
			new Proxy(store, {
				get(target, prop, receiver) {
					const v = Reflect.get(target, prop, receiver) as unknown;
					return typeof v === 'function' ? (...args: unknown[]) => (current.push(String(prop)), (v as (...a: unknown[]) => unknown).apply(target, args)) : v;
				}
			});
		const store = memoryStore();
		const t = testAuth({ store: counted(store) as typeof store });
		await bootstrap(t);
		const a = app(t);
		const answers = [];
		for (const email of [ADMIN, STRANGER]) {
			current = [];
			const res = await askCode(a, email);
			calls.push(current);
			answers.push({ status: res.status, body: await res.text(), headers: [...res.headers.entries()] });
		}
		expect(answers[1]).toEqual(answers[0]);
		expect(answers[0]!.status).toBe(202);
		expect(calls[1]).toEqual(calls[0]);
		// Each was padded to the whole floor (the test clock doesn't move during the work), and only the listed one was mailed.
		expect(t.sleeps).toEqual([1000, 1000]);
		expect(t.outbox.map((m) => m.to)).toEqual([ADMIN]);
		// The stranger's address is stored nowhere in clear.
		expect(JSON.stringify(store.dump())).not.toContain(STRANGER);
	});

	it('still answers 202 when the mail fails, and logs the failure without the address', async () => {
		const t = testAuth({ mailFails: true });
		const admin = await bootstrap(t);
		const res = await askCode(app(t), ADMIN);
		expect(res.status).toBe(202);
		expect(eventsLogged()).toEqual([{ event: 'mail.send_failed', userId: admin.id, error: 'MessageRejected' }]);
		expect(t.sleeps).toEqual([1000]);
	});

	it('refuses a wrong, an expired and a reused code with 401', async () => {
		const t = testAuth();
		await bootstrap(t);
		const a = app(t);
		await askCode(a, ADMIN);
		const code = t.outbox[0]!.code;
		const wrong = await verify(a, ADMIN, wrongCode(code));
		expect(wrong.status).toBe(401);
		expect(await wrong.json()).toEqual({ error: expect.stringContaining('wrong or has expired') });
		expect(wrong.headers.get('set-cookie')).toBeNull();

		t.clock.advance(10 * 60_000);
		expect((await verify(a, ADMIN, code)).status).toBe(401);

		t.clock.advance(60_000);
		await askCode(a, ADMIN);
		const fresh = t.outbox[1]!.code;
		expect((await verify(a, ADMIN, fresh)).status).toBe(200);
		expect((await verify(a, ADMIN, fresh)).status).toBe(401);
	});

	it('spends a code after 3 wrong tries', async () => {
		const t = testAuth();
		await bootstrap(t);
		const a = app(t);
		await askCode(a, ADMIN);
		const code = t.outbox[0]!.code;
		for (let i = 0; i < 3; i++) expect((await verify(a, ADMIN, wrongCode(code))).status).toBe(401);
		expect((await verify(a, ADMIN, code)).status).toBe(401);
	});

	it('replaces the first code with the second', async () => {
		const t = testAuth();
		await bootstrap(t);
		const a = app(t);
		await askCode(a, ADMIN);
		t.clock.advance(61_000);
		await askCode(a, ADMIN);
		const [first, second] = t.outbox.map((m) => m.code);
		if (first !== second) expect((await verify(a, ADMIN, first!)).status).toBe(401);
		expect((await verify(a, ADMIN, second!)).status).toBe(200);
	});

	it('answers a second send inside a minute with 429 and Retry-After in seconds', async () => {
		const t = testAuth();
		await bootstrap(t);
		const a = app(t);
		await askCode(a, ADMIN);
		// The first request's 1 s floor moved the test clock too: the send was 21 s ago.
		t.clock.advance(20_000);
		const res = await askCode(a, ADMIN);
		expect(res.status).toBe(429);
		expect(res.headers.get('retry-after')).toBe('39');
		expect(t.outbox).toHaveLength(1);
	});

	it('locks after 5 wrong codes, doubling the lock, with Retry-After, and logs auth.locked once per lock', async () => {
		const t = testAuth();
		await bootstrap(t);
		const a = app(t);
		for (let i = 0; i < 4; i++) expect((await verify(a, ADMIN, '000000')).status).toBe(401);
		const locked = await verify(a, ADMIN, '000000');
		expect(locked.status).toBe(429);
		expect(locked.headers.get('retry-after')).toBe('60');
		expect(eventsLogged()).toEqual([{ event: 'auth.locked' }]);
		// During the lock: refused, unchecked, not extended and not logged again; asking for a code is refused too.
		t.clock.advance(30_000);
		const during = await verify(a, ADMIN, '000000');
		expect(during.status).toBe(429);
		expect(during.headers.get('retry-after')).toBe('30');
		expect((await askCode(a, ADMIN)).status).toBe(429);
		expect(eventsLogged()).toHaveLength(1);
		// The next wrong code after it ends doubles it.
		t.clock.advance(30_000);
		const again = await verify(a, ADMIN, '000000');
		expect(again.status).toBe(429);
		expect(again.headers.get('retry-after')).toBe('120');
		expect(eventsLogged()).toEqual([{ event: 'auth.locked' }, { event: 'auth.locked' }]);
	});

	it('refuses a malformed address with 400, and a body that is not a JSON object with 400', async () => {
		const a = app(testAuth());
		expect((await askCode(a, 'not an address')).status).toBe(400);
		expect((await call(a, 'POST', '/auth/code', { body: '{email:' })).status).toBe(400);
		expect((await call(a, 'POST', '/auth/code', { body: '["a@example.test"]' })).status).toBe(400);
		expect((await call(a, 'POST', '/auth/verify', { body: { email: ADMIN } })).status).toBe(400);
		expect((await call(a, 'POST', '/auth/verify', { body: { email: ADMIN, code: 123456 } })).status).toBe(400);
	});
});

describe('signing out', () => {
	it('revokes the session and clears the cookie; a request without one is still 204', async () => {
		const t = testAuth();
		await bootstrap(t);
		const a = app(t);
		const cookie = await signIn(t, a);
		const out = await call(a, 'POST', '/auth/logout', { cookie });
		expect(out.status).toBe(204);
		expect(out.headers.get('set-cookie')).toBe('__Host-pitman_session=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Strict');
		expect((await call(a, 'GET', '/auth/me', { cookie })).status).toBe(401);
		expect((await call(a, 'POST', '/auth/logout')).status).toBe(204);
	});

	it('signs out every session with logout-everywhere, which needs a session', async () => {
		const t = testAuth();
		const admin = await bootstrap(t);
		const a = app(t);
		const laptop = await cookieFor(t, admin);
		const phone = await cookieFor(t, admin);
		expect((await call(a, 'POST', '/auth/logout-everywhere')).status).toBe(401);
		t.clock.advance(1);
		const out = await call(a, 'POST', '/auth/logout-everywhere', { cookie: laptop });
		expect(out.status).toBe(204);
		expect(out.headers.get('set-cookie')).toMatch(/^__Host-pitman_session=; Max-Age=0;/);
		expect((await call(a, 'GET', '/auth/me', { cookie: laptop })).status).toBe(401);
		expect((await call(a, 'GET', '/auth/me', { cookie: phone })).status).toBe(401);
	});
});

/** Routes that answer without a session; everything else in app.routes must be behind the gate. */
const PUBLIC = new Set(['GET /health', 'POST /auth/code', 'POST /auth/verify', 'POST /auth/logout']);

function gatedRoutes(a: App) {
	const seen = new Set<string>();
	for (const r of a.routes) {
		if (r.method === 'ALL') continue; // middleware
		const key = `${r.method} ${r.path}`;
		if (!PUBLIC.has(key)) seen.add(key);
	}
	return [...seen].map((k) => {
		const [method, path] = k.split(' ') as [string, string];
		return { method, path: path.replace(/:[A-Za-z]+/g, 'some-id') };
	});
}

describe('the gate', () => {
	it('answers 401 on every route but the public ones without a session, or with a bad one', async () => {
		const t = testAuth();
		const a = app(t);
		const routes = gatedRoutes(a);
		// The data API and the session routes, so a route that moves above the gate fails here.
		for (const expected of ['POST /chirps/monthly', 'POST /map-grid/mean', 'POST /delineate', 'GET /channels', 'GET /quaternaries', 'POST /cfm/land-use', 'GET /auth/me', 'GET /users', 'DELETE /users/some-id', 'GET /audit']) {
			expect(routes.map((r) => `${r.method} ${r.path}`)).toContain(expected);
		}
		for (const r of routes) {
			const body = ['GET', 'HEAD'].includes(r.method) ? {} : { body: {} };
			for (const cookie of [undefined, '__Host-pitman_session=not.a.token']) {
				const res = await call(a, r.method, r.path, { ...body, ...(cookie ? { cookie } : {}) });
				expect(res.status, `${r.method} ${r.path}`).toBe(401);
				expect(await res.json()).toEqual({ error: 'sign in first' });
			}
		}
		// An unknown path is behind the gate too: no hint of which routes exist.
		expect((await call(a, 'GET', '/nope')).status).toBe(401);
	});

	it('lets a removed user’s next request through no longer', async () => {
		const t = testAuth();
		const admin = await bootstrap(t);
		const added = await t.auth.kit.addUser(admin, 'user@example.test', false);
		if (!added.ok) throw new Error(added.error);
		const a = app(t);
		const cookie = await cookieFor(t, added.value);
		expect((await call(a, 'GET', '/auth/me', { cookie })).status).toBe(200);
		await t.auth.kit.removeUser(admin, { id: added.value.id });
		expect((await call(a, 'GET', '/auth/me', { cookie })).status).toBe(401);
	});

	it('fails closed: unconfigured, every gated route and sign-in answer 503, and /health still answers', async () => {
		const a = app({ auth: { ready: false, problem: 'AUTH_CODE_KEY is missing' } });
		for (const r of gatedRoutes(a)) {
			const res = await call(a, r.method, r.path, ['GET', 'HEAD'].includes(r.method) ? {} : { body: {} });
			expect(res.status, `${r.method} ${r.path}`).toBe(503);
			expect(await res.json()).toEqual({ error: NOT_CONFIGURED });
		}
		expect((await askCode(a, ADMIN)).status).toBe(503);
		expect((await verify(a, ADMIN, '123456')).status).toBe(503);
		expect((await call(a, 'GET', '/health')).status).toBe(200);
	});

	it('fails closed on Lambda when a key or the table is missing', async () => {
		const lambda = { AWS_LAMBDA_FUNCTION_NAME: 'pitman-backend', USER_STORE: 'dynamodb', USERS_TABLE: 'pitman-users', MAIL_TRANSPORT: 'ses', MAIL_FROM: 'Pitman <no-reply@example.test>', SES_CONFIGURATION_SET: 'pitman', AUTH_CODE_KEY: 'c'.repeat(32), AUTH_SESSION_KEY: 's'.repeat(32) };
		for (const gap of [{ AUTH_CODE_KEY: undefined }, { AUTH_SESSION_KEY: 's'.repeat(31) }, { USERS_TABLE: undefined }, { USER_STORE: undefined }]) {
			const runtime = authRuntimeFromEnv({ ...lambda, ...gap });
			expect(runtime.ready).toBe(false);
			const a = app({ auth: runtime });
			expect((await call(a, 'POST', '/chirps/monthly', { body: {} })).status).toBe(503);
			expect((await askCode(a, ADMIN)).status).toBe(503);
		}
		expect(eventsLogged().map((e) => e.event)).toEqual(['auth.unconfigured', 'auth.unconfigured', 'auth.unconfigured', 'auth.unconfigured']);
	});
});

describe('request checks', () => {
	it('refuses a cross-origin form or text/plain POST with 403, and a same-origin non-JSON body with 415', async () => {
		const t = testAuth();
		await bootstrap(t);
		const a = app(t);
		const evil = 'https://evil.example';
		for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
			const res = await call(a, 'POST', '/auth/code', { origin: evil, headers: { 'content-type': type }, body: `email=${ADMIN}` });
			expect(res.status, type).toBe(403);
			expect(await res.json()).toEqual({ error: 'cross-origin request refused' });
		}
		const sameOrigin = await call(a, 'POST', '/auth/code', { headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ email: ADMIN }) });
		expect(sameOrigin.status).toBe(415);
		expect((await call(a, 'POST', '/chirps/monthly', { headers: { 'content-type': 'application/xml' }, body: '<a/>' })).status).toBe(415);
		expect(t.outbox).toEqual([]);
	});

	it('marks every sign-in, user and audit answer no-store, refusals included', async () => {
		const t = testAuth();
		await bootstrap(t);
		const a = app(t);
		const cookie = await signIn(t, a);
		const answers = [
			await askCode(a, STRANGER),
			await verify(a, STRANGER, '000000'),
			await call(a, 'GET', '/auth/me'),
			await call(a, 'GET', '/auth/me', { cookie }),
			await call(a, 'GET', '/users', { cookie }),
			await call(a, 'GET', '/users'),
			await call(a, 'PATCH', '/users/x', { cookie, body: { isAdmin: true } }),
			await call(a, 'GET', '/audit', { cookie }),
			await call(a, 'POST', '/auth/logout', { cookie })
		];
		for (const res of answers) expect(res.headers.get('cache-control'), `${res.status}`).toBe('no-store');
		expect((await call(a, 'GET', '/health')).headers.get('cache-control')).toBeNull();
	});

	it('answers a CORS preflight without credentials, so the cookie is never sent cross-origin', async () => {
		const a = app(testAuth());
		const pre = await a.request('/users', { method: 'OPTIONS', headers: { origin: TEST_ORIGIN, 'access-control-request-method': 'POST' } });
		expect(pre.headers.get('access-control-allow-credentials')).toBeNull();
	});
});

describe('the dev server path', () => {
	it('never reads DEV_ADMIN_EMAIL from the app, so a Lambda can’t seed an admin', async () => {
		vi.stubEnv('DEV_ADMIN_EMAIL', ADMIN);
		const t = testAuth();
		const a = app(t);
		expect(await t.store.adminCount()).toBeNull();
		expect((await askCode(a, ADMIN)).status).toBe(202);
		expect(t.outbox).toEqual([]);
		vi.unstubAllEnvs();
	});
});
