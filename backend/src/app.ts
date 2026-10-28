import { Hono } from 'hono';
import { cors } from 'hono/cors';

export function createApp() {
	const app = new Hono();

	// CloudFront-stamped shared secret. In prod, CloudFront stamps every
	// /api/* request with X-CloudFront-Shared-Secret via the origin's
	// custom_header block (see infra/s3_cloudfront.tf). Direct hits to the
	// Function URL — which is publicly reachable by AWS design — are
	// rejected here. Without this check, the bare Function URL bypasses
	// the WAF + per-IP rate limit attached to the CloudFront distribution.
	//
	// Local dev leaves CLOUDFRONT_SHARED_SECRET unset → the check no-ops,
	// because the Hono dev server (port 3001) is reached directly by the
	// dev frontend (port 7777) without CloudFront in the path.
	const sharedSecret = process.env.CLOUDFRONT_SHARED_SECRET ?? '';
	if (sharedSecret) {
		app.use('*', async (c, next) => {
			const provided = c.req.header('x-cloudfront-shared-secret');
			if (provided !== sharedSecret) {
				return c.json({ error: 'forbidden' }, 403);
			}
			await next();
		});
	}

	const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:7777')
		.split(',')
		.map((o) => o.trim())
		.filter(Boolean);

	app.use(
		'*',
		cors({
			origin: (origin) => (allowedOrigins.includes(origin) ? origin : null),
			allowMethods: ['GET', 'POST', 'OPTIONS'],
			allowHeaders: ['Content-Type'],
			maxAge: 600
		})
	);

	app.get('/health', (c) => c.json({ ok: true }));

	// TODO: Mount your routes here.
	// Example:
	//   import { myRoute } from './routes/my-route.js';
	//   app.route('/my-route', myRoute);

	app.onError((err, c) => {
		console.error('Unhandled error', err);
		return c.json({ error: 'Internal server error' }, 500);
	});

	return app;
}
