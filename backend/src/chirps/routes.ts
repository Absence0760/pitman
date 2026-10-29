// POST /chirps/monthly (/api/chirps/monthly through CloudFront): `ChirpsMonthlyRequest` → `ChirpsMonthly` (packages/wrsm/src/extend/contract.ts).
// The area's monthly CHIRPS series from 1981 to the copy's finalThrough (docs/data.md § CHIRPS), cached
// per instance by (area hash, copy, manifest revision).
import type { ChirpsMonthly } from '@pitman/wrsm';
import { Hono } from 'hono';
import { parseArea } from '../http/area.js';
import { ResultCache } from '../http/cache.js';
import { ApiError, errorResponse } from '../http/errors.js';
import type { ChirpsCopy } from './copy.js';
import { chirpsMonthly } from './monthly.js';

/** How long one CHIRPS read may run before it stops (ms), under the Lambda's 30 s timeout. */
export const CHIRPS_DEADLINE_MS = 25_000;
/** Series kept per instance. */
export const CHIRPS_CACHE_ENTRIES = 200;

export interface ChirpsRouteOptions {
	copy: ChirpsCopy;
	deadlineMs?: number;
	cacheEntries?: number;
	now?: () => number;
}

export function chirpsRoutes(opts: ChirpsRouteOptions) {
	const cache = new ResultCache<ChirpsMonthly>(opts.cacheEntries ?? CHIRPS_CACHE_ENTRIES);
	const now = opts.now ?? Date.now;
	const app = new Hono();
	app.post('/monthly', async (c) => {
		try {
			const started = now();
			const body = await c.req.json().catch(() => {
				throw new ApiError(400, 'the body is not JSON');
			});
			const area = parseArea(body);
			const copy = await opts.copy.open();
			const key = `${area.hash}:${copy.kind}:${copy.manifest.revision}`;
			const result = await cache.get(key, () => chirpsMonthly(copy, area.geometry, { deadline: started + (opts.deadlineMs ?? CHIRPS_DEADLINE_MS), now }));
			return c.json(result);
		} catch (err) {
			return errorResponse(c, err);
		}
	});
	return Object.assign(app, { cache });
}
