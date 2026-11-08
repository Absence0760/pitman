import type { MiddlewareHandler } from 'hono';

/**
 * The API's security headers, the "api" set CloudFront's viewer-response
 * function sets on /api/* (infra/functions/security_headers.js.tftpl, with
 * the CSP from infra/csp.json's `api`). CloudFront runs no viewer-response
 * function on an origin answer of 400 or more, so the app sets them itself
 * and its errors (401, 403, 404, 413, 422, 429, 503) keep them; on a 2xx/3xx
 * the function overwrites them with the same values (R4-I14).
 * securityHeaders.test.ts compares this with csp.json and the template, so
 * the two can't drift.
 */
export const API_SECURITY_HEADERS: Readonly<Record<string, string>> = {
	'content-security-policy': "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
	'strict-transport-security': 'max-age=63072000; includeSubDomains',
	'x-content-type-options': 'nosniff',
	'x-frame-options': 'DENY',
	'referrer-policy': 'no-referrer',
	'x-xss-protection': '0',
	'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
	'cross-origin-opener-policy': 'same-origin'
};

/** Sets API_SECURITY_HEADERS on every response, whatever a later handler answered or threw. */
export function securityHeaders(): MiddlewareHandler {
	return async (c, next) => {
		await next();
		for (const [name, value] of Object.entries(API_SECURITY_HEADERS)) c.res.headers.set(name, value);
	};
}
