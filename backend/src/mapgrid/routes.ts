// POST /map-grid/mean (/api/map-grid/mean through CloudFront): `{ area }` → the area's mean MAP from the finest configured grid covering it
// (MapGridSample plus provenance, mean.ts), cached per instance by (area hash, grids).
import { Hono } from 'hono';
import { parseArea } from '../http/area.js';
import { ResultCache } from '../http/cache.js';
import { ApiError, errorResponse } from '../http/errors.js';
import { type MapGridMean, mapGridMean } from './mean.js';
import type { MapGridCatalog } from './source.js';

export const MAP_GRID_CACHE_ENTRIES = 500;

export interface MapGridRouteOptions {
	catalog: MapGridCatalog;
	cacheEntries?: number;
	/** Today's date, `YYYY-MM-DD` (MapGridSample.fetchedOn). */
	today?: () => string;
}

export function mapGridRoutes(opts: MapGridRouteOptions) {
	const cache = new ResultCache<MapGridMean>(opts.cacheEntries ?? MAP_GRID_CACHE_ENTRIES);
	const today = opts.today ?? (() => new Date().toISOString().slice(0, 10));
	const app = new Hono();
	app.post('/mean', async (c) => {
		try {
			const body = await c.req.json().catch(() => {
				throw new ApiError(400, 'the body is not JSON');
			});
			const area = parseArea(body);
			const grids = await opts.catalog.grids();
			const key = `${area.hash}:${grids.map((g) => `${g.source}/${g.grid.dataset}/${g.grid.version}`).join('+')}`;
			// The date isn't part of the key: a cached answer keeps the day it was computed, which is when the grid was read.
			const result = await cache.get(key, async () => {
				const r = mapGridMean(area.geometry, grids, today());
				if ('reasons' in r) throw new ApiError(422, `no MAP grid covers the area: ${r.reasons.join('; ')}; type the MAP instead`, { reasons: r.reasons });
				return r;
			});
			return c.json(result);
		} catch (err) {
			return errorResponse(c, err);
		}
	});
	return Object.assign(app, { cache });
}
