// Pitman's sign-in and user routes (docs/architecture.md § Sign-in). The rules are auth-kit's; these only
// read the body, call it, and turn its answer into HTTP: status, cookie, Retry-After and `{ error }`.
// Paths as the Lambda sees them (CloudFront and the dev proxy strip `/api`).
//
// Logs carry an event name and at most a user id: never an address, a code or a token (A-AUTH-11).
import { SESSION_TTL_SECONDS, withMinimumLatency, type AuditEntry, type Result, type UserRecord } from '@absence0760/auth-kit';
import { Hono, type Context } from 'hono';
import { errorSummary } from '../http/logError.js';
import { sessionCookieFor } from './cookies.js';
import { NOT_CONFIGURED, type AuthEnv } from './middleware.js';
import type { AuthRuntime } from './runtime.js';

const logEvent = (fields: Record<string, unknown>) => console.log(JSON.stringify(fields));

export const AUTH_MESSAGES = {
	notJson: 'the body is not a JSON object',
	badEmail: 'Enter a whole email address, such as name@example.com.',
	verifyBody: 'Send the email address and the code.',
	wrongCode: 'That code is wrong or has expired. Ask for a new one.',
	throttled: 'Wait a little before asking for another code.',
	locked: 'Too many wrong codes. Try again later.'
} as const;

/** The body as an object, or null when it isn't JSON or isn't an object. */
async function jsonObject(c: Context): Promise<Record<string, unknown> | null> {
	const body: unknown = await c.req.json().catch(() => null);
	return body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

/** The signed-in user as the API shows it. */
const me = (u: UserRecord) => ({ id: u.id, email: u.email, isAdmin: u.isAdmin });
/** A user as the Users page lists them, with the last hard bounce or complaint until an admin clears it. */
const listed = (u: UserRecord) => ({ id: u.id, email: u.email, isAdmin: u.isAdmin, addedBy: u.addedBy, addedAt: u.addedAt, undeliverable: u.undeliverable ? { kind: u.undeliverable.kind, at: u.undeliverable.at } : null });
const auditRow = (a: AuditEntry) => ({ at: a.at, actor: a.actor, action: a.action, ...(a.target !== null ? { target: a.target } : {}), ...(a.admin !== undefined ? { admin: a.admin } : {}) });

const retryAfter = (ms: number) => String(Math.max(1, Math.ceil(ms / 1000)));

/** auth-kit's refusal as `{ error }` with its status (400, 403, 404 or 409). */
const refusal = (c: Context, r: Extract<Result<unknown>, { ok: false }>) => c.json({ error: r.error }, r.status);

/**
 * The routes that work without a session: asking for a code, signing in with it, and signing out
 * (which clears the cookie whether or not the session is still good). Mounted before the gate.
 */
export function publicAuthRoutes(auth: AuthRuntime) {
	const app = new Hono();

	app.post('/auth/code', async (c) => {
		if (!auth.ready) return c.json({ error: NOT_CONFIGURED }, 503);
		const body = await jsonObject(c);
		if (!body) return c.json({ error: AUTH_MESSAGES.notJson }, 400);
		const clock = auth.latency.clock ?? { now: () => Date.now() };
		const started = clock.now();
		// The floor covers auth-kit's store work and the enqueue. No mail is sent here (issue #30): a listed
		// address enqueues its code, an unlisted one a decoy of the same size, so both do the same work.
		const r = await withMinimumLatency(
			auth.latency.minMs,
			async () => {
				const r = await auth.kit.requestCode(body.email);
				if (r.status === 'accepted') {
					const d = r.delivery;
					try {
						await auth.queue.enqueue(d ? { to: d.to, code: d.code, expiresAt: d.expiresAt, userId: d.user.id } : null);
					} catch (e) {
						// By name and code only, never the message. The user waits for a code that never comes.
						logEvent({ event: 'mail.enqueue_failed', ...(d ? { userId: d.user.id } : {}), ...errorSummary(e) });
					}
				}
				return r;
			},
			auth.latency
		);
		// Past the floor the answer is late, for a listed and an unlisted address alike (a slow store or SQS):
		// logged, with no address, for the alarm auth-kit asks for. The answer is unchanged.
		if (clock.now() - started > auth.latency.minMs) logEvent({ event: 'auth.slow_code_request' });
		// This send used a listed address's last of the day: it gets no code for up to a day, a lockout nobody
		// would otherwise notice (docs/security.md § Known risks). Unlisted addresses never count, so strangers'
		// addresses can't hold the alarm in ALARM. `listed` and `capReached` never reach the answer.
		if (r.status === 'accepted' && r.capReached && r.listed) logEvent({ event: 'auth.send_capped' });
		switch (r.status) {
			case 'accepted':
				return c.json({}, 202);
			case 'invalid':
				return c.json({ error: AUTH_MESSAGES.badEmail }, 400);
			case 'throttled':
				c.header('Retry-After', retryAfter(r.retryAfterMs));
				return c.json({ error: AUTH_MESSAGES.throttled }, 429);
			case 'locked':
				c.header('Retry-After', retryAfter(r.retryAfterMs));
				return c.json({ error: AUTH_MESSAGES.locked }, 429);
		}
	});

	app.post('/auth/verify', async (c) => {
		if (!auth.ready) return c.json({ error: NOT_CONFIGURED }, 503);
		const body = await jsonObject(c);
		if (!body) return c.json({ error: AUTH_MESSAGES.notJson }, 400);
		if (typeof body.email !== 'string' || typeof body.code !== 'string') return c.json({ error: AUTH_MESSAGES.verifyBody }, 400);
		const v = await auth.kit.verifyCode(body.email, body.code);
		if (v.status === 'ok') {
			const { token } = await auth.kit.issueSession(v.user);
			c.header('Set-Cookie', auth.cookie.set(token, SESSION_TTL_SECONDS));
			return c.json({ user: me(v.user) }, 200);
		}
		if (v.status === 'locked') {
			// The alarm's metric filter counts this line (A-AUTH-7). No address: the lock is keyed by one.
			// A listed address's lock only, so wrong codes against made-up addresses can't keep the alarm in
			// ALARM and hide a real lockout. The answer is the same either way.
			if (v.lockStarted && v.listed) logEvent({ event: 'auth.locked' });
			c.header('Retry-After', retryAfter(v.retryAfterMs));
			return c.json({ error: AUTH_MESSAGES.locked }, 429);
		}
		return c.json({ error: AUTH_MESSAGES.wrongCode }, 401);
	});

	app.post('/auth/logout', async (c) => {
		if (auth.ready) {
			const signedIn = await auth.kit.verifySession(auth.cookie.read(c.req.header('cookie')));
			if (signedIn) await auth.kit.signOut(signedIn.session);
		}
		// Unconfigured, nothing can verify the token anyway; the cookie still goes.
		c.header('Set-Cookie', (auth.ready ? auth.cookie : sessionCookieFor(false)).clear());
		return c.body(null, 204);
	});

	return app;
}

/** The routes that need a session. Mounted after the gate, which sets `user`. Users and audit are admin-only (auth-kit's 403). */
export function sessionRoutes(auth: AuthRuntime) {
	const app = new Hono<AuthEnv>();
	// The gate answers 503 before any of these run when sign-in isn't configured.
	const kit = () => {
		if (!auth.ready) throw new Error('sign-in is not configured');
		return auth;
	};

	app.get('/auth/me', (c) => c.json({ user: me(c.var.user) }));

	app.post('/auth/logout-everywhere', async (c) => {
		const a = kit();
		await a.kit.signOutEverywhere(c.var.user.id);
		c.header('Set-Cookie', a.cookie.clear());
		return c.body(null, 204);
	});

	app.get('/users', async (c) => {
		const r = await kit().kit.listUsers(c.var.user);
		return r.ok ? c.json({ users: r.value.map(listed) }) : refusal(c, r);
	});

	app.post('/users', async (c) => {
		const body = await jsonObject(c);
		if (!body) return c.json({ error: AUTH_MESSAGES.notJson }, 400);
		const r = await kit().kit.addUser(c.var.user, body.email, body.isAdmin ?? false);
		return r.ok ? c.json({ user: listed(r.value) }, 201) : refusal(c, r);
	});

	app.patch('/users/:id', async (c) => {
		const body = await jsonObject(c);
		if (!body) return c.json({ error: AUTH_MESSAGES.notJson }, 400);
		const r = await kit().kit.setAdmin(c.var.user, { id: c.req.param('id') }, body.isAdmin);
		return r.ok ? c.json({ user: listed(r.value) }) : refusal(c, r);
	});

	// An admin clears a user's bounce or complaint flag once the address is fixed or confirmed (auth-kit's
	// clearDeliveryProblem, audited as mail.cleared). A POST with a JSON body like every other write.
	app.post('/users/:id/clear-delivery-problem', async (c) => {
		const body = await jsonObject(c);
		if (!body) return c.json({ error: AUTH_MESSAGES.notJson }, 400);
		const r = await kit().kit.clearDeliveryProblem(c.var.user, { id: c.req.param('id') });
		return r.ok ? c.json({ user: listed(r.value) }) : refusal(c, r);
	});

	app.delete('/users/:id', async (c) => {
		const r = await kit().kit.removeUser(c.var.user, { id: c.req.param('id') });
		return r.ok ? c.body(null, 204) : refusal(c, r);
	});

	app.get('/audit', async (c) => {
		const raw = c.req.query('limit');
		// Absent: auth-kit's default. Anything but a whole number is passed on for auth-kit's 400.
		const limit = raw === undefined ? undefined : /^\d+$/.test(raw) ? Number(raw) : raw;
		const r = await kit().kit.listAudit(c.var.user, limit);
		return r.ok ? c.json({ rows: r.value.map(auditRow) }) : refusal(c, r);
	});

	return app;
}
