import { timingSafeEqual } from 'node:crypto';
import { Hono, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { csrf } from 'hono/csrf';
import { HTTPException } from 'hono/http-exception';
import { onLambda } from './auth/config.js';
import { requireSession } from './auth/middleware.js';
import { publicAuthRoutes, sessionRoutes } from './auth/routes.js';
import { type AuthRuntime, authRuntimeFromEnv } from './auth/runtime.js';
import { landUseRoutes } from './cfm/routes.js';
import { type LandUseSource, landUseSourceFromEnv } from './cfm/source.js';
import { ChirpsCopy, chirpsCopyConfig } from './chirps/copy.js';
import { chirpsRoutes } from './chirps/routes.js';
import { delineationRoutes } from './delineation/routes.js';
import { DemSource, demLocationFromEnv } from './delineation/source.js';
import { MAX_BODY_BYTES } from './http/area.js';
import { jsonOnly } from './http/jsonOnly.js';
import { rateLimit } from './http/rateLimit.js';
import { logUnexpected } from './http/logError.js';
import { CROSS_ORIGIN_REFUSED, sameOriginWrites } from './http/sameOrigin.js';
import { securityHeaders } from './http/securityHeaders.js';
import { mapGridRoutes } from './mapgrid/routes.js';
import { MapGridCatalog, mapGridSourcesFromEnv } from './mapgrid/source.js';
import { quaternaryRoutes } from './quaternaries/routes.js';
import { QuaternaryStore, quaternarySourceFromEnv } from './quaternaries/source.js';
import { dailyQuota } from './usage/quota.js';
import { type UsageStore, usageStoreFromEnv } from './usage/store.js';

/** Per-instance request limits per client (http/rateLimit.ts): the WAF rule is the global per-IP one, DAILY_QUOTAS the per-user one. */
export const RATE_LIMITS = {
	chirps: { limit: 30, windowMs: 10 * 60_000 },
	mapGrid: { limit: 120, windowMs: 10 * 60_000 },
	// The costliest calls the API has: up to ~460 MB and 20 s a delineation, 3 × 3 routed windows a channel box.
	// Exploring a river takes many clicks, and one tool session up to four boxes; the 20 s budget and the caches bound each call.
	delineate: { limit: 30, windowMs: 10 * 60_000 },
	channels: { limit: 60, windowMs: 10 * 60_000 },
	quaternaries: { limit: 120, windowMs: 10 * 60_000 },
	// One fetch per area on the screen, cached; each miss may cost up to 20 upstream pages a layer (cfm/arcgis.ts CFM_MAX_PAGES).
	landUse: { limit: 20, windowMs: 10 * 60_000 },
	// Sign-in and the Users page, per instance; the WAF's /api/auth/* rule (A-AUTH-9) is the global one,
	// and auth-kit's per-address send limits and lockout the real ones.
	auth: { limit: 60, windowMs: 10 * 60_000 }
} as const;

/**
 * Requests per signed-in user per UTC day on the routes that cost real money (usage/quota.ts, decision R4-D7),
 * counted across every instance. The per-IP limits above bound a burst; these bound a day. Each is ~10 × a heavy
 * day of real work, so a hydrologist never meets one, and the worst a user (or a stolen session) can cost is:
 *
 *   Lambda, every request held to the 30 s timeout at 1 GB: 30 GB-s × $0.00001768 = $0.00053 a request.
 *   chirps      200/day × (16 chunks × 45 years = 720 GETs, R4-D6) = 144 000 GETs × $0.0004/1 000 = $0.058 (IC-WBT's bill)
 *                       + 200 × $0.00053 = $0.106 Lambda                                         → $0.16/day,  $4.91/month
 *   delineate   300/day × $0.00053 = $0.159 Lambda, + ≤ ~60 ranged DEM GETs each (6 × 6 512-px tiles at the 3 072-cell
 *                       window, plus PMTiles directories; cached per instance) = 18 000 × $0.0004/1 000 = $0.007
 *                                                                                                  → $0.17/day,  $4.99/month
 *   channels    400/day × $0.00053 = $0.212 Lambda, + ≤ ~60 DEM GETs each = $0.010                → $0.22/day,  $6.65/month
 *   landUse     100/day × $0.00053 = $0.053 Lambda; upstream ≤ 100 × 2 layers × 20 pages = 4 000 Cape Farm Mapper
 *                       calls (cfm/arcgis.ts), not billed to Pitman                                  → $0.05/day,  $1.59/month
 *   one user's worst day: $0.60, a 30-day month $18.14, of which $2.23 is S3 GETs on IC-WBT's buckets (mirror and tiles);
 *   the reserved concurrency still caps the whole service's Lambda line: 10 × 1 GB × 2 592 000 s ≈ $458/month.
 *
 * MAP-grid means and cells, and the quaternary list, are not counted: they read a file each instance loads once and
 * keeps (mapgrid/source.ts, quaternaries/source.ts), so a request costs milliseconds of Lambda and no upstream call.
 */
export const DAILY_QUOTAS = {
	chirps: 200,
	delineate: 300,
	channels: 400,
	landUse: 100
} as const;

/** The answer to every request on a Lambda whose CloudFront shared secret is unset. */
export const SHARED_SECRET_UNSET = 'this server is not configured (CLOUDFRONT_SHARED_SECRET is not set)';

/** What the data routes read; tests pass their own, the app builds them from the environment. */
export interface AppDeps {
	chirps: ChirpsCopy;
	mapGrids: MapGridCatalog;
	dem: DemSource;
	quaternaries: QuaternaryStore;
	landUse: LandUseSource | { problem: string };
	rateLimits: {
		chirps: { limit: number; windowMs: number };
		mapGrid: { limit: number; windowMs: number };
		delineate?: { limit: number; windowMs: number };
		channels?: { limit: number; windowMs: number };
		quaternaries?: { limit: number; windowMs: number };
		landUse?: { limit: number; windowMs: number };
		auth?: { limit: number; windowMs: number };
	};
	/** The per-user daily counts (usage/store.ts). Default: from USAGE_STORE; tests pass a memory store or a problem. */
	usage: UsageStore | { problem: string };
	dailyQuotas: Partial<Record<keyof typeof DAILY_QUOTAS, number>>;
	/** Sign-in (auth/runtime.ts). Default: built from the environment; tests pass one on a memory store. */
	auth: AuthRuntime;
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
	const landUse = deps.landUse ?? landUseSourceFromEnv();
	const limits = deps.rateLimits ?? RATE_LIMITS;
	const auth = deps.auth ?? authRuntimeFromEnv(process.env);
	const usage = deps.usage ?? usageStoreFromEnv(process.env);
	const quotas = { ...DAILY_QUOTAS, ...deps.dailyQuotas };

	// First, so every answer below carries the API's security headers,
	// refusals included: CloudFront's viewer-response function doesn't run on
	// an origin answer of 400 or more (http/securityHeaders.ts, R4-I14).
	app.use('*', securityHeaders());

	// CloudFront-stamped shared secret. In prod, CloudFront stamps every
	// /api/* request with X-CloudFront-Shared-Secret via the origin's
	// custom_header block (see infra/s3_cloudfront.tf). The first lock is in
	// front of this one: the Function URL is AWS_IAM behind CloudFront's
	// origin access control (issue #33, R4-I6), so a direct hit is refused by
	// Lambda before it gets here. This check is the second layer: it still
	// refuses a direct hit if the URL is ever back on NONE or the OAC stops
	// signing, so the bare URL never bypasses the WAF + per-IP rate limit.
	//
	// Local dev leaves CLOUDFRONT_SHARED_SECRET unset → the check no-ops,
	// because the Hono dev server (port 3001) is reached directly by the
	// dev frontend (port 7777) without CloudFront in the path. On Lambda an
	// unset or empty secret fails closed instead (503 on everything, like
	// sign-in's config, A-AUTH-8): the bare Function URL must never answer
	// past the WAF because a variable went missing.
	const sharedSecret = process.env.CLOUDFRONT_SHARED_SECRET ?? '';
	if (!sharedSecret && onLambda(process.env)) {
		console.error(JSON.stringify({ event: 'cloudfront_secret.unset' }));
		app.use('*', async (c) => c.json({ error: SHARED_SECRET_UNSET }, 503));
	} else if (sharedSecret) {
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
			// No credentials and no PATCH/DELETE: the browser only ever calls the API same-origin (CloudFront's
			// /api/* in production, the Vite proxy in dev), so CORS never has to carry the session cookie.
			// PATCH /users/:id and DELETE /users/:id (the admin's Users page) do exist; they are same-origin only,
			// so CORS doesn't list them, and sameOriginWrites below refuses them from anywhere else.
			allowMethods: ['GET', 'POST', 'OPTIONS'],
			allowHeaders: ['Content-Type'],
			maxAge: 600
		})
	);

	// A cross-origin form-like body (form, multipart, text/plain) is refused with 403 (A-AUTH-9). Cross-origin
	// JSON is stopped by the CORS preflight and the session cookie's SameSite=Strict.
	app.use('*', csrf({ origin: allowedOrigins }));
	// And any state-changing request, whatever its type, must come from the site itself (http/sameOrigin.ts):
	// Sec-Fetch-Site: same-origin or an allowed Origin, so the browser's preflight isn't the only check.
	app.use('*', sameOriginWrites(allowedOrigins));

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
	app.use('*', jsonOnly);

	// Sign-in (docs/architecture.md § Sign-in). Never cached: these answers are one person's.
	// One limiter for all of them, so the four paths share one count per client, except GET /auth/me:
	// every page load asks it who is signed in, so counting it would lock a busy user (or everyone
	// behind one NAT) out of sign-in. It is exempt from the WAF auth rule too (infra/waf.tf), and it
	// still needs a session (401 without one) and is still no-store.
	const authLimiter = rateLimit({ ...(limits.auth ?? RATE_LIMITS.auth), now });
	const authLimit: MiddlewareHandler = (c, next) => (c.req.method === 'GET' && c.req.path === '/auth/me' ? next() : authLimiter(c, next));
	for (const path of ['/auth/*', '/users', '/users/*', '/audit']) {
		app.use(path, async (c, next) => {
			await next();
			c.header('Cache-Control', 'no-store');
		});
		app.use(path, authLimit);
	}
	app.route('/', publicAuthRoutes(auth));

	// The gate (A-AUTH-1). Everything registered from here on needs a session: Hono runs handlers in the
	// order they were added, so only /health and the routes above answer without one, and a route added
	// below can't forget it (app.test.ts enumerates app.routes to prove it).
	app.use('*', requireSession(auth));
	app.route('/', sessionRoutes(auth));

	app.use('/chirps/*', rateLimit({ ...limits.chirps, now }));
	app.use('/map-grid/*', rateLimit({ ...limits.mapGrid, now }));
	app.use('/delineate', rateLimit({ ...(limits.delineate ?? RATE_LIMITS.delineate), now }));
	app.use('/channels', rateLimit({ ...(limits.channels ?? RATE_LIMITS.channels), now }));
	app.use('/quaternaries', rateLimit({ ...(limits.quaternaries ?? RATE_LIMITS.quaternaries), now }));
	app.use('/cfm/*', rateLimit({ ...(limits.landUse ?? RATE_LIMITS.landUse), now }));
	// Then the per-user day (DAILY_QUOTAS): after the per-IP limit, so a burst is refused before it costs a write.
	app.use('/chirps/*', dailyQuota({ usage, route: 'chirps', what: 'CHIRPS rainfall reads', limit: quotas.chirps, now }));
	app.use('/delineate', dailyQuota({ usage, route: 'delineate', what: 'tributary delineations', limit: quotas.delineate, now }));
	app.use('/channels', dailyQuota({ usage, route: 'channels', what: 'channel boxes', limit: quotas.channels, now }));
	app.use('/cfm/*', dailyQuota({ usage, route: 'landUse', what: 'land-use reads', limit: quotas.landUse, now }));
	app.route('/chirps', chirpsRoutes({ copy: chirps, now }));
	app.route('/map-grid', mapGridRoutes({ catalog: mapGrids, today: deps.today }));
	app.route('/', delineationRoutes({ dem, now }));
	// Synthetic in dev; a 503 "not configured" in production until D-1 gives Pitman licensed boundaries.
	app.route('/quaternaries', quaternaryRoutes({ store: quaternaries }));
	// Synthetic in dev; a 503 "not configured" in production until the operator's token arrives (D3).
	app.route('/cfm', landUseRoutes({ source: landUse, now, today: deps.today }));

	app.notFound((c) => c.json({ error: 'not found' }, 404));

	app.onError((err, c) => {
		// csrf() throws a 403.
		if (err instanceof HTTPException && err.status === 403) return c.json({ error: CROSS_ORIGIN_REFUSED }, 403);
		// Name and code only: a message can carry a request's values, an address among them (A-AUTH-11).
		logUnexpected('unhandled_error', err);
		return c.json({ error: 'Internal server error' }, 500);
	});

	return app;
}
