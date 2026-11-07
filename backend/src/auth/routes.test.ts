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
import { SES_SEND_WORST_CASE_MS } from './mail.js';
import { authRuntimeFromEnv, CODE_REQUEST_MIN_LATENCY_MS, type AuthRuntime } from './runtime.js';
import { AUTH_MESSAGES } from './routes.js';

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
		expect(t.sleeps).toEqual([CODE_REQUEST_MIN_LATENCY_MS, CODE_REQUEST_MIN_LATENCY_MS]);
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
		expect(t.sleeps).toEqual([CODE_REQUEST_MIN_LATENCY_MS]);
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
		// The first request's floor moved the test clock too: the send was 20 s + the floor ago.
		t.clock.advance(20_000);
		const res = await askCode(a, ADMIN);
		expect(res.status).toBe(429);
		expect(res.headers.get('retry-after')).toBe(String(Math.ceil((60_000 - 20_000 - CODE_REQUEST_MIN_LATENCY_MS) / 1000)));
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

describe('the alarm signals (auth-kit listed / capReached / limit: logs only, never the answer)', () => {
	/** The runtime with some of auth-kit's calls replaced. */
	const withKit = (t: TestAuth, kit: Partial<TestAuth['auth']['kit']>): { auth: AuthRuntime } => ({ auth: { ...t.auth, kit: { ...t.auth.kit, ...kit } } });
	const answer = async (res: Response) => ({ status: res.status, retryAfter: res.headers.get('retry-after'), body: await res.json() });

	/** Ten sends a day apart enough to pass the 60 s gap and the hourly limit: the day's budget. */
	async function spendTheDay(t: TestAuth, a: App, email: string) {
		const answers = [];
		for (let i = 0; i < 10; i++) {
			answers.push(await answer(await askCode(a, email)));
			t.clock.advance(i === 4 ? 60 * 60_000 : 61_000);
		}
		t.clock.advance(60 * 60_000);
		answers.push(await answer(await askCode(a, email)));
		return answers;
	}

	it('logs auth.send_capped on the send that spends a listed address’s day, and answers exactly as for an unlisted one', async () => {
		const t = testAuth();
		await bootstrap(t);
		const a = app(t);
		const unlisted = await spendTheDay(t, a, STRANGER);
		expect(eventsLogged()).toEqual([]);
		const listed = await spendTheDay(t, a, ADMIN);
		expect(eventsLogged()).toEqual([{ event: 'auth.send_capped' }]);
		expect(t.outbox).toHaveLength(10);
		expect(listed.map((r) => ({ ...r, retryAfter: r.retryAfter && 'set' }))).toEqual(unlisted.map((r) => ({ ...r, retryAfter: r.retryAfter && 'set' })));
		expect(listed.slice(0, 10).every((r) => r.status === 202)).toBe(true);
		expect(listed[10]).toMatchObject({ status: 429, body: { error: AUTH_MESSAGES.throttled } });
	});

	it('logs auth.locked for a listed address’s lock only, and answers the same either way', async () => {
		const t = testAuth();
		await bootstrap(t);
		const a = app(t);
		const lock = async (email: string) => {
			for (let i = 0; i < 4; i++) await verify(a, email, '000000');
			return answer(await verify(a, email, '000000'));
		};
		const unlisted = await lock(STRANGER);
		expect(eventsLogged()).toEqual([]);
		const listed = await lock(ADMIN);
		expect(eventsLogged()).toEqual([{ event: 'auth.locked' }]);
		expect(listed).toEqual(unlisted);
		expect(listed).toEqual({ status: 429, retryAfter: '60', body: { error: AUTH_MESSAGES.locked } });
	});

	it('never lets listed, capReached or limit change an answer', async () => {
		const t = testAuth();
		const codeAnswer = async (r: unknown) => answer(await askCode(app(withKit(t, { requestCode: async () => r as never })), ADMIN));
		const verifyAnswer = async (r: unknown) => answer(await verify(app(withKit(t, { verifyCode: async () => r as never })), ADMIN, '000000'));
		const groups = [
			[{ status: 'accepted', delivery: null, listed: false }, { status: 'accepted', delivery: null, listed: true }, { status: 'accepted', delivery: null, capReached: true, listed: true }, { status: 'accepted', delivery: null, capReached: true, listed: false }].map(codeAnswer),
			(['interval', 'hour', 'day'] as const).flatMap((limit) => [true, false].map((listed) => codeAnswer({ status: 'throttled', retryAfterMs: 61_000, limit, listed }))),
			[true, false].map((listed) => codeAnswer({ status: 'locked', retryAfterMs: 61_000, listed })),
			[true, false].flatMap((listed) => [true, false].map((lockStarted) => verifyAnswer({ status: 'locked', retryAfterMs: 61_000, lockStarted, listed })))
		];
		for (const group of groups) {
			const answers = await Promise.all(group);
			for (const a of answers) expect(a).toEqual(answers[0]);
		}
	});

	it('logs auth.slow_code_request, without the address, when a send runs past the floor, and still answers 202', async () => {
		const t = testAuth({ mailDelayMs: CODE_REQUEST_MIN_LATENCY_MS + 1 });
		await bootstrap(t);
		const a = app(t);
		const res = await askCode(a, ADMIN);
		expect(res.status).toBe(202);
		expect(await res.json()).toEqual({});
		expect(t.outbox).toHaveLength(1);
		expect(t.sleeps).toEqual([]);
		expect(eventsLogged()).toEqual([{ event: 'auth.slow_code_request' }]);
	});

	it('logs nothing when the send fits inside the floor', async () => {
		const t = testAuth({ mailDelayMs: 400 });
		await bootstrap(t);
		expect((await askCode(app(t), ADMIN)).status).toBe(202);
		expect(t.sleeps).toEqual([CODE_REQUEST_MIN_LATENCY_MS - 400]);
		expect(eventsLogged()).toEqual([]);
	});

	it('pads even an SES send at its worst case to the floor, so the answer comes no later than an unlisted one', async () => {
		// The review's case: a send at 2.5 s ran past auth-kit's 1 s floor. A send can now take up to
		// SES_SEND_WORST_CASE_MS (then sesMailer stops it); the default floor sits above that.
		const t = testAuth({ mailDelayMs: SES_SEND_WORST_CASE_MS });
		await bootstrap(t);
		const started = t.clock.now();
		expect((await askCode(app(t), ADMIN)).status).toBe(202);
		const listed = t.clock.now() - started;
		const u = testAuth();
		const s = u.clock.now();
		expect((await askCode(app(u), STRANGER)).status).toBe(202);
		expect(listed).toBe(u.clock.now() - s);
		expect(listed).toBe(CODE_REQUEST_MIN_LATENCY_MS);
		expect(eventsLogged()).toEqual([]);
	});

	it('logs an unexpected error by name and code, never its message, which may hold an address', async () => {
		const t = testAuth();
		const admin = await bootstrap(t);
		const failing = withKit(t, {
			listUsers: async () => {
				throw Object.assign(new Error(`ConditionalCheckFailed for user ${ADMIN}`), { name: 'TransactionCanceledException', code: 'TransactionCanceledException' });
			}
		});
		const res = await call(app(failing), 'GET', '/users', { cookie: await cookieFor(t, admin) });
		expect(res.status).toBe(500);
		expect(await res.json()).toEqual({ error: 'Internal server error' });
		expect(eventsLogged()).toEqual([{ event: 'unhandled_error', error: 'TransactionCanceledException', code: 'TransactionCanceledException' }]);
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

	it('refuses every state-changing request, JSON included, unless it comes from the site (Origin or Sec-Fetch-Site)', async () => {
		const t = testAuth();
		await bootstrap(t);
		const a = app(t);
		const cookie = await signIn(t, a);
		const evil = 'https://evil.example';
		const refusals = [
			// The review's probe: a valid cookie, JSON, from another origin. Stopped today by the preflight and
			// SameSite=Strict in a browser; refused here whatever the browser does.
			await call(a, 'POST', '/users', { cookie, origin: evil, body: { email: 'new@example.test' } }),
			await call(a, 'POST', '/auth/logout-everywhere', { cookie, origin: evil }),
			await call(a, 'POST', '/auth/logout', { cookie, origin: evil }),
			await call(a, 'PATCH', '/users/x', { cookie, origin: evil, body: { isAdmin: true } }),
			await call(a, 'DELETE', '/users/x', { cookie, origin: evil }),
			await call(a, 'POST', '/auth/code', { origin: evil, body: { email: ADMIN } }),
			// No Origin and no Sec-Fetch-Site (not a browser on the site), and a sibling subdomain.
			await call(a, 'POST', '/users', { cookie, origin: null, body: { email: 'new@example.test' } }),
			await call(a, 'POST', '/users', { cookie, origin: null, headers: { 'sec-fetch-site': 'same-site' }, body: { email: 'new@example.test' } }),
			await call(a, 'POST', '/users', { cookie, origin: null, headers: { 'sec-fetch-site': 'none' }, body: { email: 'new@example.test' } }),
			await call(a, 'POST', '/users', { cookie, origin: 'https://other.jaredhoward.com', headers: { 'sec-fetch-site': 'same-site' }, body: { email: 'new@example.test' } })
		];
		for (const res of refusals) {
			expect(res.status).toBe(403);
			expect(await res.json()).toEqual({ error: 'cross-origin request refused' });
		}
		expect((await t.store.listUsers()).map((u) => u.email)).toEqual([ADMIN]);
		expect(t.outbox).toHaveLength(1);

		// From the site: an allowed Origin, or Sec-Fetch-Site: same-origin without one (the dev proxy on another port).
		expect((await call(a, 'POST', '/users', { cookie, body: { email: 'one@example.test' } })).status).toBe(201);
		expect((await call(a, 'POST', '/users', { cookie, origin: null, headers: { 'sec-fetch-site': 'same-origin' }, body: { email: 'two@example.test' } })).status).toBe(201);
		expect((await call(a, 'POST', '/users', { cookie, origin: 'http://127.0.0.1:7777', headers: { 'sec-fetch-site': 'same-origin' }, body: { email: 'three@example.test' } })).status).toBe(201);
		// Reads need neither.
		expect((await call(a, 'GET', '/users', { cookie, origin: null })).status).toBe(200);
		expect((await call(a, 'GET', '/health', { origin: evil })).status).toBe(200);
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

	it('never counts GET /auth/me against the per-instance auth limit, which still bounds the code route', async () => {
		const t = testAuth();
		await bootstrap(t);
		const a = createApp({ auth: t.auth, rateLimits: { chirps: many, mapGrid: many, auth: { limit: 5, windowMs: 10 * 60_000 } } });
		const cookie = await signIn(t, a); // two requests of the five
		for (let i = 0; i < 100; i++) {
			const res = await call(a, 'GET', '/auth/me', { cookie });
			expect(res.status, `request ${i}`).toBe(200);
			expect(res.headers.get('cache-control')).toBe('no-store');
		}
		// Still gated: without a session it is 401, never 429, however many.
		for (let i = 0; i < 10; i++) expect((await call(a, 'GET', '/auth/me')).status).toBe(401);
		// The exemption is GET /auth/me only: the code route spends the three left, then 429s.
		const codes = [];
		for (let i = 0; i < 4; i++) codes.push((await askCode(a, `user${i}@example.test`)).status);
		expect(codes).toEqual([202, 202, 202, 429]);
		expect((await call(a, 'POST', '/auth/me', { cookie, body: {} })).status).toBe(429);
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
