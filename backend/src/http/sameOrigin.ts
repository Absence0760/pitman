// Every state-changing request must come from the site itself (A-AUTH-9): a method other than GET, HEAD or
// OPTIONS is refused with 403 unless the browser says so, by `Sec-Fetch-Site: same-origin` or by an
// `Origin` in ALLOWED_ORIGINS. Neither header can be set by a page's script, so a page on another origin
// can't pass, whatever content type it sends; a request with neither (curl, an old browser) is refused too.
//
// This doesn't rely on the CORS preflight or on the cookie's SameSite=Strict, which also stop cross-origin
// JSON today, nor on a sibling *.jaredhoward.com never being added to ALLOWED_ORIGINS for some other reason
// (Sec-Fetch-Site: same-site is not same-origin). Hono's csrf() in front only covers form-like types.
import { createMiddleware } from 'hono/factory';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

export const CROSS_ORIGIN_REFUSED = 'cross-origin request refused';

/** True when a browser sent this request from one of `allowedOrigins`. */
export function sameOriginRequest(headers: { origin?: string; secFetchSite?: string }, allowedOrigins: readonly string[]): boolean {
	if (headers.secFetchSite === 'same-origin') return true;
	return headers.origin !== undefined && allowedOrigins.includes(headers.origin);
}

export function sameOriginWrites(allowedOrigins: readonly string[]) {
	return createMiddleware(async (c, next) => {
		if (!SAFE.has(c.req.method)) {
			const origin = c.req.header('origin');
			const secFetchSite = c.req.header('sec-fetch-site');
			if (!sameOriginRequest({ ...(origin !== undefined ? { origin } : {}), ...(secFetchSite !== undefined ? { secFetchSite } : {}) }, allowedOrigins)) {
				return c.json({ error: CROSS_ORIGIN_REFUSED }, 403);
			}
		}
		await next();
	});
}
