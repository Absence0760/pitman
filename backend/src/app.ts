import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { ChirpsCopy, chirpsCopyConfig } from './chirps/copy.js';
import { chirpsRoutes } from './chirps/routes.js';
import { delineationRoutes } from './delineation/routes.js';
import { DemSource, demLocationFromEnv } from './delineation/source.js';
import { MAX_BODY_BYTES } from './http/area.js';
import { rateLimit } from './http/rateLimit.js';
import { mapGridRoutes } from './mapgrid/routes.js';
import { MapGridCatalog, mapGridSourcesFromEnv } from './mapgrid/source.js';
import { quaternaryRoutes } from './quaternaries/routes.js';
import { QuaternaryStore, quaternarySourceFromEnv } from './quaternaries/source.js';

/** Per-instance request limits per client (http/rateLimit.ts): the WAF rule is the global one. */
export const RATE_LIMITS = {
	chirps: { limit: 30, windowMs: 10 * 60_000 },
	mapGrid: { limit: 120, windowMs: 10 * 60_000 },
	// The costliest calls the API has: up to ~460 MB and 20 s a delineation, 3 × 3 routed windows a channel box.
	delineate: { limit: 12, windowMs: 10 * 60_000 },
	channels: { limit: 30, windowMs: 10 * 60_000 },
	quaternaries: { limit: 120, windowMs: 10 * 60_000 }
} as const;

/** What the data routes read; tests pass their own, the app builds them from the environment. */
export interface AppDeps {
	chirps: ChirpsCopy;
	mapGrids: MapGridCatalog;
	dem: DemSource;
	quaternaries: QuaternaryStore;
	rateLimits: {
		chirps: { limit: number; windowMs: number };
		mapGrid: { limit: number; windowMs: number };
		delineate?: { limit: number; windowMs: number };
		channels?: { limit: number; windowMs: number };
		quaternaries?: { limit: number; windowMs: number };
	};
	now: () => number;
	today: () => string;
}

export function createApp(deps: Partial<AppDeps> = {}) {
	const app = new Hono();
	const now = deps.now ?? Date.now;
	const chirps = deps.chirps ?? new ChirpsCopy(chirpsCopyConfig());
	const mapGrids = deps.mapGrids ?? new MapGridCatalog(mapGridSourcesFromEnv());
	const dem = deps.dem ?? new DemSource(demLocationFromEnv());
	const quaternaries = deps.quaternaries ?? new QuaternaryStore(quaternarySourceFromEnv());
	const limits = deps.rateLimits ?? RATE_LIMITS;

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
		const expected = Buffer.from(sharedSecret);
		app.use('*', async (c, next) => {
			const provided = Buffer.from(c.req.header('x-cloudfront-shared-secret') ?? '');
			// Timing-safe: equal-length buffers only (a length mismatch is a refusal without a compare).
			if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
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

	// The data API (docs/data.md, docs/architecture.md § Backend). CloudFront strips `/api` before the
	// Lambda (decision R4-I4): the browser calls /api/chirps/monthly in production and
	// http://localhost:3001/chirps/monthly in dev, and both reach /chirps/monthly here.
	app.use(
		'*',
		bodyLimit({
			maxSize: MAX_BODY_BYTES,
			onError: (c) => c.json({ error: `the body is larger than ${MAX_BODY_BYTES / 1024 / 1024} MiB; simplify the area` }, 413)
		})
	);
	app.use('/chirps/*', rateLimit({ ...limits.chirps, now }));
	app.use('/map-grid/*', rateLimit({ ...limits.mapGrid, now }));
	app.use('/delineate', rateLimit({ ...(limits.delineate ?? RATE_LIMITS.delineate), now }));
	app.use('/channels', rateLimit({ ...(limits.channels ?? RATE_LIMITS.channels), now }));
	app.use('/quaternaries', rateLimit({ ...(limits.quaternaries ?? RATE_LIMITS.quaternaries), now }));
	app.route('/chirps', chirpsRoutes({ copy: chirps, now }));
	app.route('/map-grid', mapGridRoutes({ catalog: mapGrids, today: deps.today }));
	app.route('/', delineationRoutes({ dem, now }));
	// Synthetic in dev; a 503 "not configured" in production until D-1 gives Pitman licensed boundaries.
	app.route('/quaternaries', quaternaryRoutes({ store: quaternaries }));

	app.notFound((c) => c.json({ error: 'not found' }, 404));

	app.onError((err, c) => {
		console.error('Unhandled error', err);
		return c.json({ error: 'Internal server error' }, 500);
	});

	return app;
}
