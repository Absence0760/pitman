/**
 * The client for the sign-in and user routes (issue #28 P3–P4). Browser paths
 * sit under the API base (`/api`, same origin in dev and production), and the
 * session is an HttpOnly cookie the browser sends itself: nothing here sees
 * it. Errors come back as `AuthRequestError` carrying the API's own `{error}`
 * sentence, which the screens show as it is.
 */

import { apiUrl } from '#lib/extend/api.js';
import { contentHashFetch } from '#lib/api/content-hash.js';
import { sessionFetch } from './unauthorized.js';

export interface User {
	readonly id: string;
	readonly email: string;
	readonly isAdmin: boolean;
}

export interface ListedUser extends User {
	/** An admin's address, or `operator` for the first admin. */
	readonly addedBy: string;
	/** ISO 8601. */
	readonly addedAt: string;
	/** The last hard bounce or spam complaint for the address, until an admin clears it; null when none. */
	readonly undeliverable: DeliveryProblem | null;
}

export interface DeliveryProblem {
	readonly kind: 'bounce' | 'complaint';
	/** ISO 8601: when the mail service saw it. */
	readonly at: string;
}

/** The API's `undeliverable`, or null for anything it can't be (an older API leaves it out). */
function readProblem(v: unknown): DeliveryProblem | null {
	const p = v as Partial<DeliveryProblem> | null | undefined;
	return p && (p.kind === 'bounce' || p.kind === 'complaint') && typeof p.at === 'string' ? { kind: p.kind, at: p.at } : null;
}

export interface AuditRow {
	/** ISO 8601. */
	readonly at: string;
	/** An address, `operator`, or `unlisted:<key>` for a sign-in attempt by an address not on the list. */
	readonly actor: string;
	readonly action: string;
	/** The address acted on; absent or null for a sign-in. */
	readonly target?: string | null;
	/** On `add`: whether the new user is an admin. */
	readonly admin?: boolean;
}

export class AuthRequestError extends Error {
	constructor(
		message: string,
		/** HTTP status; 0 when the API couldn't be reached. */
		readonly status: number,
		/** Seconds, from `Retry-After` on a 429. */
		readonly retryAfter?: number
	) {
		super(message);
		this.name = 'AuthRequestError';
	}
}

export interface AuthClientOptions {
	/** The API base (`PUBLIC_API_URL`). */
	readonly baseUrl: string | undefined;
	readonly fetch?: typeof fetch;
}

/** `Retry-After` as seconds: a number of seconds or an HTTP date. Undefined when absent or unreadable. */
export function retryAfterSeconds(header: string | null, now: number = Date.now()): number | undefined {
	if (header === null || header.trim() === '') return undefined;
	const text = header.trim();
	if (/^\d+$/.test(text)) return Number(text);
	const at = Date.parse(text);
	return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - now) / 1000));
}

/** A wait in words: "45 seconds", "about 2 minutes", "about 1 hour". */
export function waitText(seconds: number): string {
	const s = Math.max(1, Math.ceil(seconds));
	if (s < 60) return `${s} second${s === 1 ? '' : 's'}`;
	const m = Math.ceil(s / 60);
	if (m < 60) return `about ${m} minute${m === 1 ? '' : 's'}`;
	const h = Math.ceil(m / 60);
	return `about ${h} hour${h === 1 ? '' : 's'}`;
}

async function errorText(response: Response): Promise<string | undefined> {
	try {
		const body = (await response.json()) as { error?: unknown };
		return typeof body.error === 'string' && body.error.trim() !== '' ? body.error.trim() : undefined;
	} catch {
		return undefined; // Not JSON: the status says it.
	}
}

const FALLBACK: Record<number, string> = {
	400: 'Pitman could not read that. Check it and try again.',
	401: 'You are not signed in.',
	403: 'Only an admin can do that.',
	404: 'That user is no longer on the list.',
	409: 'Someone else changed the list at the same moment. Reload the list and try again.'
};

async function call(
	options: AuthClientOptions,
	path: string,
	init: { method?: string; body?: unknown },
	{ gated }: { gated: boolean }
): Promise<Response> {
	// The sign-in routes answer 401 as part of their job (wrong code, not signed in): only the gated routes report it.
	// Both state the body's SHA-256, which CloudFront's signed requests to the API need (issue #33).
	const doFetch = gated ? sessionFetch(options.fetch) : contentHashFetch(options.fetch);
	let response: Response;
	try {
		response = await doFetch(apiUrl(options.baseUrl, path), {
			method: init.method ?? 'GET',
			headers: init.body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
			body: init.body === undefined ? undefined : JSON.stringify(init.body),
			credentials: 'same-origin'
		});
	} catch {
		throw new AuthRequestError('Pitman could not reach its server. Check the connection and try again.', 0);
	}
	if (response.ok) return response;
	const message = await errorText(response);
	if (response.status === 429) {
		const wait = retryAfterSeconds(response.headers.get('retry-after'));
		throw new AuthRequestError(
			wait === undefined ? 'Too many tries. Wait a few minutes, then try again.' : `Too many tries. Wait ${waitText(wait)}, then try again.`,
			429,
			wait
		);
	}
	if (response.status >= 500) {
		throw new AuthRequestError(`Pitman’s server failed (HTTP ${response.status})${message ? `: ${message}` : ''}. Try again later.`, response.status);
	}
	throw new AuthRequestError(message ?? FALLBACK[response.status] ?? `The request was refused (HTTP ${response.status}).`, response.status);
}

async function json<T>(response: Response, check: (body: unknown) => T): Promise<T> {
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		throw new AuthRequestError('Pitman’s server sent an answer it can’t read (not JSON).', response.status);
	}
	return check(body);
}

function isUser(u: unknown): u is User {
	const v = u as Partial<User> | null;
	return typeof v === 'object' && v !== null && typeof v.id === 'string' && typeof v.email === 'string' && typeof v.isAdmin === 'boolean';
}

function readUser(body: unknown): User {
	const user = (body as { user?: unknown } | null)?.user;
	if (!isUser(user)) throw new AuthRequestError('Pitman’s server sent an answer it can’t read (no user).', 200);
	return { id: user.id, email: user.email, isAdmin: user.isAdmin };
}

/** `POST /auth/code`: the same answer whether or not the address is listed (A-AUTH-2). */
export async function requestCode(email: string, options: AuthClientOptions): Promise<void> {
	await call(options, '/auth/code', { method: 'POST', body: { email } }, { gated: false });
}

/** `POST /auth/verify`: the code is right, and the browser now holds the session cookie. */
export async function verifyCode(email: string, code: string, options: AuthClientOptions): Promise<User> {
	return json(await call(options, '/auth/verify', { method: 'POST', body: { email, code } }, { gated: false }), readUser);
}

/** `GET /auth/me`: the signed-in user, or null on 401. */
export async function fetchMe(options: AuthClientOptions): Promise<User | null> {
	try {
		return await json(await call(options, '/auth/me', {}, { gated: false }), readUser);
	} catch (error) {
		if (error instanceof AuthRequestError && error.status === 401) return null;
		throw error;
	}
}

export async function logout(options: AuthClientOptions): Promise<void> {
	await call(options, '/auth/logout', { method: 'POST' }, { gated: false });
}

export async function logoutEverywhere(options: AuthClientOptions): Promise<void> {
	await call(options, '/auth/logout-everywhere', { method: 'POST' }, { gated: true });
}

/** `GET /users` (admins only). */
export async function listUsers(options: AuthClientOptions): Promise<ListedUser[]> {
	return json(await call(options, '/users', {}, { gated: true }), (body) => {
		const users = (body as { users?: unknown } | null)?.users;
		if (!Array.isArray(users) || !users.every((u) => isUser(u) && typeof (u as ListedUser).addedAt === 'string')) {
			throw new AuthRequestError('Pitman’s server sent a user list it can’t read.', 200);
		}
		return users.map((u: ListedUser) => ({ id: u.id, email: u.email, isAdmin: u.isAdmin, addedBy: String(u.addedBy ?? ''), addedAt: u.addedAt, undeliverable: readProblem(u.undeliverable) }));
	});
}

export async function addUser(email: string, isAdmin: boolean, options: AuthClientOptions): Promise<User> {
	return json(await call(options, '/users', { method: 'POST', body: { email, isAdmin } }, { gated: true }), readUser);
}

export async function setAdmin(id: string, isAdmin: boolean, options: AuthClientOptions): Promise<void> {
	await call(options, `/users/${encodeURIComponent(id)}`, { method: 'PATCH', body: { isAdmin } }, { gated: true });
}

/** `POST /users/:id/clear-delivery-problem` (admins only): the address is fixed or confirmed, so the flag goes. */
export async function clearDeliveryProblem(id: string, options: AuthClientOptions): Promise<void> {
	await call(options, `/users/${encodeURIComponent(id)}/clear-delivery-problem`, { method: 'POST', body: {} }, { gated: true });
}

export async function removeUser(id: string, options: AuthClientOptions): Promise<void> {
	await call(options, `/users/${encodeURIComponent(id)}`, { method: 'DELETE' }, { gated: true });
}

/** `GET /audit?limit=N`: the most recent rows first. */
export async function listAudit(limit: number, options: AuthClientOptions): Promise<AuditRow[]> {
	return json(await call(options, `/audit?limit=${Math.max(1, Math.floor(limit))}`, {}, { gated: true }), (body) => {
		const rows = (body as { rows?: unknown } | null)?.rows;
		if (!Array.isArray(rows) || !rows.every((r) => typeof r?.at === 'string' && typeof r?.actor === 'string' && typeof r?.action === 'string')) {
			throw new AuthRequestError('Pitman’s server sent an audit log it can’t read.', 200);
		}
		return rows as AuditRow[];
	});
}
