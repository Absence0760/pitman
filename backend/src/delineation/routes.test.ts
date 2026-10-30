// POST /delineate and GET /channels through createApp(): the contract's shapes, the refusals, the 503 with
// no DEM, the limits. Against the synthetic terrain, read from its function (syntheticDem.ts), and for
// the refusals that need IC-WBT's valley, its committed fixture.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AreaGeometry, ChannelCollection } from '@pitman/wrsm';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { MapGridCatalog } from '../mapgrid/source.js';
import { ChirpsCopy } from '../chirps/copy.js';
import { openDem } from './dem.js';
import { DAM_CELL, fixtureLonLat } from './fixture.js';
import { MAX_CHANNEL_BOX_DEG, parseBbox, parsePoint, tilesOf, type DelineateAnswer } from './routes.js';
import { DemSource, type DemLocation } from './source.js';
import { syntheticDem } from './syntheticDem.js';
import { ApiError } from '../http/errors.js';

const many = { limit: 100_000, windowMs: 60_000 };
const quaternaries = JSON.parse(readFileSync(new URL('../../fixtures/geo/quaternaries.synthetic.geojson', import.meta.url), 'utf8')) as {
	features: { properties: { code: string }; geometry: AreaGeometry }[];
};
const Z01A = quaternaries.features.find((f) => f.properties.code === 'Z01A')!.geometry;
const TRIBUTARY: [number, number] = [21.1110878, -33.6584957];

const shared = new DemSource(syntheticDem());
const app = (dem: DemSource = shared, limits: { delineate?: typeof many; channels?: typeof many } = {}, now?: () => number) =>
	createApp({
		dem,
		chirps: new ChirpsCopy({ problem: 'unused' } as never),
		mapGrids: new MapGridCatalog({ problem: 'unused' }),
		rateLimits: { chirps: many, mapGrid: many, delineate: limits.delineate ?? many, channels: limits.channels ?? many },
		...(now ? { now } : {})
	});
const post = (a: ReturnType<typeof createApp>, body: unknown) =>
	a.request('/delineate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });

describe('POST /delineate', () => {
	it('answers the contract’s response: pieces, areas that add up, provenance', async () => {
		const res = await post(app(), { point: TRIBUTARY, within: Z01A });
		expect(res.status).toBe(200);
		const r = (await res.json()) as DelineateAnswer;
		expect(r.tributary.type).toBe('Polygon');
		expect(r.remainder.type).toBe('Polygon');
		expect(r.tributaryKm2).toBeGreaterThan(20);
		expect(r.remainderKm2).toBeGreaterThan(500);
		expect(r.outsidePct).toBeCloseTo(0, 6);
		expect(r.warning).toBeNull();
		expect(r.snapM).toBeGreaterThanOrEqual(0);
		expect(r.pansKm2).toBeGreaterThanOrEqual(0);
		expect(r.dem).toMatchObject({ label: expect.stringMatching(/^Synthetic DEM/), zoom: 11, attribution: 'Synthetic test data' });
		expect(r.dem.fingerprint).not.toBe('');
	});

	it('answers a repeated click from the cache, and a different one afresh', async () => {
		const reads = { n: 0 };
		const base = syntheticDem();
		const a = app(new DemSource({ info: base.info, tile: (z, x, y) => (reads.n++, base.tile(z, x, y)) }));
		await post(a, { point: TRIBUTARY, within: Z01A });
		const first = reads.n;
		expect(first).toBeGreaterThan(0);
		expect((await post(a, { point: TRIBUTARY, within: Z01A })).status).toBe(200);
		expect(reads.n).toBe(first);
		await post(a, { point: [TRIBUTARY[0] + 0.0001, TRIBUTARY[1]], within: Z01A });
		expect(reads.n).toBeGreaterThan(first);
	});

	it('refuses with a 422, `error` and `reason`', async () => {
		const off = await post(app(), { point: [21.24, -33.62], within: Z01A });
		expect(off.status).toBe(422);
		expect(await off.json()).toEqual({ error: expect.stringMatching(/^No terrain channel runs within 150 m/), reason: 'off_channel' });
		const whole = await post(app(), { point: [21.1066246, -33.7359036], within: Z01A });
		expect(await whole.json()).toEqual({ error: 'The tributary is almost the whole quaternary: there is nothing to split.', reason: 'whole_quaternary' });
	});

	it('names the larger channel, and keeps the point when asked (`keepPoint`)', async () => {
		const valley = new DemSource(openDem(fileURLToPath(new URL('../../fixtures/dem/synthetic-dem.pmtiles', import.meta.url))));
		const point = fixtureLonLat(DAM_CELL.x + 3.5, DAM_CELL.y + 60.5);
		const [lon, lat] = point;
		const d = 0.3;
		const within: AreaGeometry = { type: 'Polygon', coordinates: [[[lon - d, lat - d], [lon + d, lat - d], [lon + d, lat + d], [lon - d, lat + d], [lon - d, lat - d]]] };
		const res = await post(app(valley), { point, within });
		expect(res.status).toBe(422);
		const body = (await res.json()) as { reason: string; larger: { at: [number, number]; km2: number } };
		expect(body.reason).toBe('larger_channel');
		expect(body.larger.km2).toBeGreaterThan(100);
		const kept = await post(app(valley), { point, within, keepPoint: true });
		expect(kept.status).toBe(200);
	});

	it('refuses a body it can’t read with a 400 that says why', async () => {
		const bad = async (body: unknown, match: RegExp) => {
			const res = await post(app(), body);
			expect(res.status).toBe(400);
			expect(((await res.json()) as { error: string }).error).toMatch(match);
		};
		await bad('{', /not JSON/);
		await bad([], /JSON object/);
		await bad({ within: Z01A }, /no "point"/);
		await bad({ point: ['a', 1], within: Z01A }, /longitude, latitude/);
		await bad({ point: [200, 0], within: Z01A }, /longitude, latitude/);
		await bad({ point: TRIBUTARY }, /no "area"/);
	});

	it('answers 503 naming the command when the local DEM isn’t there', async () => {
		const res = await post(app(new DemSource({ kind: 'local', file: '/nowhere/synthetic.pmtiles' })), { point: TRIBUTARY, within: Z01A });
		expect(res.status).toBe(503);
		expect(((await res.json()) as { error: string }).error).toMatch(/pnpm dev:data:synthetic/);
	});

	it('answers 503 when no DEM is configured, and when the DEM fails mid-read', async () => {
		const unset: DemLocation = { problem: 'DEM_SOURCE is not set' };
		expect((await post(app(new DemSource(unset)), { point: TRIBUTARY, within: Z01A })).status).toBe(503);
		const base = syntheticDem();
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		const broken = new DemSource({ info: base.info, tile: async () => Promise.reject(new Error('socket hang up')) });
		const res = await post(app(broken), { point: TRIBUTARY, within: Z01A });
		log.mockRestore();
		expect(res.status).toBe(503);
		expect(((await res.json()) as { error: string }).error).toMatch(/could not be read/);
	});

	it('is rate limited tightly: the next call past the limit is a 429', async () => {
		const a = app(shared, { delineate: { limit: 1, windowMs: 60_000 } });
		expect((await post(a, { point: [21.24, -33.62], within: Z01A })).status).toBe(422);
		const res = await post(a, { point: [21.24, -33.62], within: Z01A });
		expect(res.status).toBe(429);
		expect(res.headers.get('retry-after')).toBeTruthy();
	});
});

describe('GET /channels', () => {
	it('answers the box’s terrain channels as lines carrying their area', async () => {
		const res = await app().request('/channels?bbox=21.05,-33.7,21.2,-33.6');
		expect(res.status).toBe(200);
		const c = (await res.json()) as ChannelCollection;
		expect(c.type).toBe('FeatureCollection');
		expect(c.features.length).toBeGreaterThan(50);
		expect(c.features[0]).toMatchObject({ type: 'Feature', geometry: { type: 'LineString' }, properties: { km2: expect.any(Number) } });
		expect(Math.max(...c.features.map((f) => f.properties['km2'] as number))).toBeGreaterThan(100);
	});

	it('answers an empty collection off the elevation model', async () => {
		const res = await app().request('/channels?bbox=30,-30,30.2,-29.8');
		expect(res.status).toBe(200);
		expect(((await res.json()) as ChannelCollection).features).toEqual([]);
	});

	it('refuses a box too large or malformed', async () => {
		const a = app();
		for (const q of ['', '?bbox=1,2,3', '?bbox=a,b,c,d', '?bbox=21,-33,20,-34', `?bbox=21,-34,${21 + MAX_CHANNEL_BOX_DEG + 0.01},-33.8`]) {
			expect((await a.request(`/channels${q}`)).status).toBe(400);
		}
	});

	it('stops at its deadline with a 504 and keeps the tiles done, so asking again finishes', async () => {
		let t = 0;
		let reads = 0;
		const base = syntheticDem();
		const counted = new DemSource({
			info: base.info,
			tile: (z, x, y) => {
				reads++;
				// Each read "takes" a second: the first tile alone uses up the budget.
				t += 1_000;
				return base.tile(z, x, y);
			}
		});
		const a = app(counted, {}, () => t);
		const bbox = '/channels?bbox=21.05,-33.65,21.3,-33.55';
		const late = await a.request(bbox);
		expect(late.status).toBe(504);
		expect(((await late.json()) as { error: string }).error).toMatch(/ask again/);
		const first = reads;
		expect(first).toBeGreaterThan(0);
		// The tile done is kept: the next try routes only the rest, and finishes when the deadline allows it.
		const again = await a.request('/channels?bbox=21.05,-33.65,21.15,-33.55');
		expect(again.status).toBe(200);
		expect(reads).toBe(first);
	});

	it('is rate limited on its own bucket', async () => {
		const a = app(shared, { channels: { limit: 1, windowMs: 60_000 } });
		expect((await a.request('/channels?bbox=30,-30,30.2,-29.8')).status).toBe(200);
		expect((await a.request('/channels?bbox=30,-30,30.2,-29.8')).status).toBe(429);
	});

	it('answers 503 naming the command when the local DEM isn’t there', async () => {
		const res = await app(new DemSource({ kind: 'local', file: '/nowhere/synthetic.pmtiles' })).request('/channels?bbox=21,-33.7,21.1,-33.6');
		expect(res.status).toBe(503);
		expect(((await res.json()) as { error: string }).error).toMatch(/pnpm dev:data:synthetic/);
	});
});

describe('parsePoint, parseBbox, tilesOf', () => {
	it('takes numbers in range, and nothing else', () => {
		expect(parsePoint([21, -33])).toEqual([21, -33]);
		expect(() => parsePoint([21])).toThrow(ApiError);
		expect(() => parsePoint([21, Number.NaN])).toThrow(ApiError);
		expect(parseBbox('21,-33.7,21.2,-33.5')).toEqual([21, -33.7, 21.2, -33.5]);
	});

	it('finds the fixed tiles a box touches, at most 3 × 3 at the largest box', () => {
		expect(tilesOf([21, -33.8, 21.2, -33.6])).toEqual([[105, -169]]);
		expect(tilesOf([21.1, -33.7, 21.3, -33.5]).length).toBe(4);
		expect(tilesOf([21.1, -33.7, 21.1 + MAX_CHANNEL_BOX_DEG, -33.7 + MAX_CHANNEL_BOX_DEG]).length).toBeLessThanOrEqual(9);
	});
});
