// JSON bodies only (A-AUTH-9): a POST, PUT, PATCH or DELETE that carries a body must say it is
// application/json, or it gets 415. With csrf() and sameOriginWrites() in front (which refuse a
// cross-origin form-like body, and any write not from the site), a cross-site form or text/plain POST can
// never reach a route, and a same-site one can't either.
import { createMiddleware } from 'hono/factory';

const WITH_BODY = /^(POST|PUT|PATCH|DELETE)$/;
const JSON_TYPE = /^application\/json\s*(;|$)/i;

export const jsonOnly = createMiddleware(async (c, next) => {
	if (WITH_BODY.test(c.req.method)) {
		const length = c.req.header('content-length');
		const hasBody = c.req.raw.body !== null || (length !== undefined && length !== '0') || c.req.header('transfer-encoding') !== undefined;
		if (hasBody && !JSON_TYPE.test(c.req.header('content-type') ?? '')) {
			return c.json({ error: 'send the body as application/json' }, 415);
		}
	}
	await next();
});
