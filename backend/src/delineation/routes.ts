// POST /delineate (/api/delineate through CloudFront): `{ point, within }` → the tributary and the
// remainder (`DelineateResponse`, packages/wrsm/src/subdivide/contract.ts); a refusal is a 422 with
// `{ error, reason }`, IC-WBT's codes. GET /channels?bbox=w,s,e,n → the DEM's terrain channels.
//
// A delineation is the costliest call the API has (up to ~460 MB and the 20 s budget at the largest
// window), so it has the tightest rate limit (app.ts), and answers are kept per instance by (DEM, area,
// point). Channels are routed by fixed tile and kept the same way, so a box of them costs what is new
// (IC-WBT's channelRoutes.ts, without its database). A box past its deadline answers 504 and keeps the
// tiles done: asking again finishes it.
//
// Beyond the contract, on purpose and flagged to the orchestrator: the request may carry `keepPoint`, the
// response `pansKm2` and `dem.attribution` (decision R5-D4).
import type { AreaGeometry, ChannelCollection, DelineateResponse, DemProvenance } from '@pitman/wrsm';
import { Hono } from 'hono';
import { parseArea } from '../http/area.js';
import { ResultCache } from '../http/cache.js';
import { ApiError, errorResponse } from '../http/errors.js';
import { CHANNEL_TILE_DEG, channelTile, type ChannelTile } from './channels.js';
import { DelineationRefused, TIME_BUDGET_MS } from './delineate.js';
import type { DemSource } from './source.js';
import { delineateTributary, type Tributary } from './tributary.js';

/** The longest side of a channel box (degrees): at most 3 × 3 tiles, each a 1 024-cell routing. Larger areas ask box by box. */
export const MAX_CHANNEL_BOX_DEG = 0.4;
/** How long one channel box may route (ms), under the Lambda's 30 s timeout. */
export const CHANNEL_BUDGET_MS = 20_000;
/** Tiles kept per instance: each is a few hundred KB of lines at most (IC-WBT's figure). */
export const CHANNEL_CACHE_TILES = 128;
/** Delineations kept per instance. */
export const DELINEATE_CACHE_ENTRIES = 50;

/** What `POST /delineate` answers: the contract's response and the two additions (R5-D4). */
export interface DelineateAnswer extends DelineateResponse {
	readonly dem: DemProvenance & { readonly attribution: string };
	/** What drains into closed pans inside the catchment, km²; reported only, never taken out. */
	readonly pansKm2: number;
}

export interface DelineationRouteOptions {
	dem: DemSource;
	budgetMs?: number;
	channelBudgetMs?: number;
	now?: () => number;
}

/** The body's click, or an ApiError(400). */
export function parsePoint(v: unknown): [number, number] {
	if (!Array.isArray(v) || v.length !== 2) throw new ApiError(400, 'the body has no "point" ([longitude, latitude])');
	const [lon, lat] = v as unknown[];
	if (typeof lon !== 'number' || typeof lat !== 'number' || !(Math.abs(lon) <= 180) || !(Math.abs(lat) <= 90)) {
		throw new ApiError(400, 'the point must be [longitude, latitude] in degrees');
	}
	return [lon, lat];
}

/** `w,s,e,n` → the box, or an ApiError(400) saying what is wrong. */
export function parseBbox(q: string | undefined): [number, number, number, number] {
	const parts = (q ?? '').split(',').map((v) => (v.trim() === '' ? Number.NaN : Number(v)));
	if (parts.length !== 4 || parts.some((v) => !Number.isFinite(v))) throw new ApiError(400, 'ask for one box as bbox=west,south,east,north (degrees)');
	const [w, s, e, n] = parts as [number, number, number, number];
	if (w < -180 || e > 180 || s < -90 || n > 90 || w >= e || s >= n) throw new ApiError(400, 'the box must be west,south,east,north, in degrees, west of east and south of north');
	// The tiny allowance is a box on the client's 0.4° grid, whose difference floats a hair over it.
	if (e - w > MAX_CHANNEL_BOX_DEG + 1e-9 || n - s > MAX_CHANNEL_BOX_DEG + 1e-9) throw new ApiError(400, `the box is too large: at most ${MAX_CHANNEL_BOX_DEG}° a side; zoom in`);
	return [w, s, e, n];
}

/** The fixed channel tiles a box touches. */
export function tilesOf([w, s, e, n]: readonly [number, number, number, number]): [number, number][] {
	const tiles: [number, number][] = [];
	// `e` and `n` are exclusive: a box ending on a tile's edge doesn't touch the next tile.
	const last = (v: number) => Math.ceil(v / CHANNEL_TILE_DEG) - 1;
	for (let j = Math.floor(s / CHANNEL_TILE_DEG); j <= last(n); j++) {
		for (let i = Math.floor(w / CHANNEL_TILE_DEG); i <= last(e); i++) tiles.push([i, j]);
	}
	return tiles;
}

function refusal(err: DelineationRefused) {
	// `outline` isn't one of the contract's DelineateRefusal codes, so it is answered without a `reason`.
	const reason = err.code === 'outline' ? {} : { reason: err.code };
	return new ApiError(422, err.message, { ...reason, ...(err.larger ? { larger: err.larger } : {}) });
}

function unreadable(err: unknown) {
	console.error('DEM read failed', err);
	return new ApiError(503, 'the elevation model could not be read just now; try again shortly');
}

export function delineationRoutes(opts: DelineationRouteOptions) {
	const delineations = new ResultCache<DelineateAnswer>(DELINEATE_CACHE_ENTRIES);
	const tiles = new ResultCache<ChannelTile>(CHANNEL_CACHE_TILES);
	const now = opts.now ?? Date.now;
	const app = new Hono();

	app.post('/delineate', async (c) => {
		try {
			const body = (await c.req.json().catch(() => {
				throw new ApiError(400, 'the body is not JSON');
			})) as { point?: unknown; within?: unknown; keepPoint?: unknown } | null;
			if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new ApiError(400, 'the body must be a JSON object { "point": [lon, lat], "within": <GeoJSON polygon> }');
			const point = parsePoint(body.point);
			const within = parseArea({ area: body.within });
			const keepPoint = body.keepPoint === true;
			const { dem, info, attribution } = await opts.dem.open();
			const key = `${info.fingerprint}:${within.hash}:${point[0].toFixed(7)},${point[1].toFixed(7)}:${keepPoint}`;
			const answer = await delineations.get(key, async () => {
				let t: Tributary;
				try {
					t = await delineateTributary(dem, point, within.geometry as AreaGeometry, { budgetMs: opts.budgetMs ?? TIME_BUDGET_MS, keepPoint });
				} catch (err) {
					throw err instanceof DelineationRefused ? refusal(err) : unreadable(err);
				}
				return {
					tributary: t.tributary,
					remainder: t.remainder,
					tributaryKm2: t.tributaryKm2,
					remainderKm2: t.remainderKm2,
					outsideKm2: t.outsideKm2,
					outsidePct: t.outsidePct,
					warning: t.warning,
					snapM: t.snapM,
					pansKm2: t.pansKm2,
					dem: { label: info.label, fingerprint: info.fingerprint, zoom: t.delineation.zoom, attribution }
				};
			});
			return c.json(answer);
		} catch (err) {
			return errorResponse(c, err);
		}
	});

	app.get('/channels', async (c) => {
		try {
			const box = parseBbox(c.req.query('bbox'));
			const { dem, info } = await opts.dem.open();
			const deadline = now() + (opts.channelBudgetMs ?? CHANNEL_BUDGET_MS);
			const features: ChannelCollection['features'][number][] = [];
			for (const tile of tilesOf(box)) {
				let t: ChannelTile;
				try {
					t = await tiles.get(`${info.fingerprint}:${tile[0]},${tile[1]}`, async () => {
						if (now() > deadline) throw new ApiError(504, 'routing these terrain channels is taking a while; the work so far is kept, so ask again');
						return channelTile(dem, tile);
					});
				} catch (err) {
					if (err instanceof ApiError) throw err;
					// Off the elevation model's edge there are simply no channels to draw.
					if (err instanceof DelineationRefused) continue;
					throw unreadable(err);
				}
				for (const line of t.lines) {
					features.push({ type: 'Feature', properties: { km2: line.km2 }, geometry: { type: 'LineString', coordinates: line.coordinates } });
				}
			}
			const collection: ChannelCollection = { type: 'FeatureCollection', features };
			return c.json(collection);
		} catch (err) {
			return errorResponse(c, err);
		}
	});

	return Object.assign(app, { delineations, tiles });
}
