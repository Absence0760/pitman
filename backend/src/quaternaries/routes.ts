// GET /quaternaries (/api/quaternaries through CloudFront): the boundaries as QuaternaryCollection, or a
// 503 when none are configured, which the map panel explains (docs/data.md § Quaternaries, D-1).
import { Hono } from 'hono';
import { errorResponse } from '../http/errors.js';
import type { QuaternaryStore } from './source.js';

export function quaternaryRoutes(opts: { store: QuaternaryStore }) {
	const app = new Hono();
	app.get('/', (c) => {
		try {
			// Up to 5 MiB, and three parts of the page ask for it: the browser keeps one copy.
			return c.body(opts.store.body(), 200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' });
		} catch (err) {
			return errorResponse(c, err);
		}
	});
	return app;
}
