// The session cookie. Production (and any Lambda) always uses auth-kit's `__Host-pitman_session`:
// Secure, HttpOnly, SameSite=Strict, Path=/, no Domain (A-AUTH-3). AUTH_DEV_COOKIE=true (local dev only,
// refused on Lambda by config.ts) swaps in a plain `pitman_session` without Secure, for a browser that
// won't keep a Secure cookie from http://localhost; it keeps HttpOnly, SameSite=Strict and Path=/.
import { clearSessionCookie, readCookie, sessionCookie } from '@absence0760/auth-kit';
import { parse } from 'hono/utils/cookie';

export const SESSION_COOKIE = 'pitman_session';

export interface SessionCookie {
	/** The cookie's full name. */
	name: string;
	/** A Set-Cookie value carrying the token. */
	set(token: string, maxAgeSeconds: number): string;
	/** A Set-Cookie value that removes it. */
	clear(): string;
	/** The token from a Cookie request header, or null. */
	read(header: string | null | undefined): string | null;
}

const hostCookie: SessionCookie = {
	name: `__Host-${SESSION_COOKIE}`,
	set: (token, maxAge) => sessionCookie(SESSION_COOKIE, token, maxAge),
	clear: () => clearSessionCookie(SESSION_COOKIE),
	read: (header) => readCookie(header, SESSION_COOKIE)
};

const TOKEN = /^[A-Za-z0-9._-]*$/;

const devCookie: SessionCookie = {
	name: SESSION_COOKIE,
	set(token, maxAge) {
		if (!TOKEN.test(token)) throw new Error('the cookie value must be base64url and dots');
		return `${SESSION_COOKIE}=${token}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Strict`;
	},
	clear: () => `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict`,
	read: (header) => (header ? (parse(header, SESSION_COOKIE)[SESSION_COOKIE] ?? null) : null)
};

export function sessionCookieFor(dev: boolean): SessionCookie {
	return dev ? devCookie : hostCookie;
}
