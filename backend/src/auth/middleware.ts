// The gate (A-AUTH-1): every route registered after it needs a live session. auth-kit's verifySession
// checks the token and re-reads the user and the revocation on every request, so a removal, a sign-out or
// "sign out everywhere" takes effect on the next one. Fails closed: with sign-in unconfigured, 503.
import type { Session, UserRecord } from '@absence0760/auth-kit';
import { createMiddleware } from 'hono/factory';
import type { AuthRuntime } from './runtime.js';

export type AuthEnv = { Variables: { user: UserRecord; session: Session } };

export const NOT_CONFIGURED = 'sign-in is not configured on this server';
export const NOT_SIGNED_IN = 'sign in first';

export function requireSession(auth: AuthRuntime) {
	return createMiddleware<AuthEnv>(async (c, next) => {
		if (!auth.ready) return c.json({ error: NOT_CONFIGURED }, 503);
		const signedIn = await auth.kit.verifySession(auth.cookie.read(c.req.header('cookie')));
		if (!signedIn) return c.json({ error: NOT_SIGNED_IN }, 401);
		c.set('user', signedIn.user);
		c.set('session', signedIn.session);
		await next();
	});
}
