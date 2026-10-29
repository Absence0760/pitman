// The data API end to end through createApp() (no server, no network, no AWS): POST /chirps/monthly
// and POST /map-grid/mean against the local fixture copies, the cache, the refusals (400, 404, 413,
// 422, 429, 503), CORS and the CloudFront shared secret; and the synthetic dev data the generator writes.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChirpsMonthly } from '@pitman/wrsm';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { FIXTURE_GEO_DIR, FIXTURE_MIRROR_DIR, fakeS3 } from './__tests__/fakeS3.js';
import { type AppDeps, createApp } from './app.js';
import { ChirpsCopy, chirpsCopyConfig } from './chirps/copy.js';
import { writeSyntheticChirps } from './chirps/synthetic.js';
import { MAX_BODY_BYTES } from './http/area.js';
import { localGridSource, MapGridCatalog } from './mapgrid/source.js';
import { syntheticMapGridJson } from './mapgrid/synthetic.js';

const tmp: string[] = [];
afterAll(() => tmp.forEach((d) => rmSync(d, { recursive: true, force: true })));
afterEach(() => vi.unstubAllEnvs());

const box = (w: number, s: number, e: number, n: number) => ({ type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });
/** The fixture copy's written grid (mirror y 300–309, x 300–307). */
const GRID = box(25.0, -20.5, 25.4, -20.0);
const many = { limit: 1000, windowMs: 60_000 };

function app(deps: Partial<AppDeps> = {}) {
	return createApp({
		chirps: new ChirpsCopy(chirpsCopyConfig({ CHIRPS_SOURCE: 'local', CHIRPS_LOCAL_DIR: FIXTURE_MIRROR_DIR })),
		mapGrids: new MapGridCatalog([localGridSource(join(FIXTURE_GEO_DIR, 'map-grid.synthetic.json'), 'synthetic')]),
		rateLimits: { chirps: many, mapGrid: many },
		today: () => '2026-10-29',
		...deps
	});
}
const post = (a: ReturnType<typeof createApp>, path: string, body: unknown, headers: Record<string, string> = {}) =>
	a.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

describe('POST /chirps/monthly', () => {
	it('answers the contract’s ChirpsMonthly for an area over the copy', async () => {
		const res = await post(app(), '/chirps/monthly', { area: GRID });
		expect(res.status).toBe(200);
		const body = (await res.json()) as ChirpsMonthly;
		expect(Object.keys(body).sort()).toEqual(['areaKm2', 'cells', 'finalThrough', 'months', 'product', 'revision', 'source', 'weightRemovedPct']);
		expect(body).toMatchObject({ cells: 79, product: 'CHIRPS v3 rnl (final)', revision: 1, finalThrough: '2025-12-31', source: 'local' });
		expect(body.months).toHaveLength(540);
		expect(Object.keys(body.months[0]!).sort()).toEqual(['mm', 'month', 'year']);
	});

	it('answers a repeated area from the cache, with no read of the copy', async () => {
		const s3 = fakeS3(FIXTURE_MIRROR_DIR, { bucket: 'water-management-mirror-1' });
		const a = app({ chirps: new ChirpsCopy(chirpsCopyConfig({ CHIRPS_SOURCE: 's3', CHIRPS_BUCKET: 'water-management-mirror-1' }), { s3 }) });
		const first = await (await post(a, '/chirps/monthly', { area: GRID })).json();
		expect(first).toMatchObject({ source: 's3' });
		const reads = s3.keys.length;
		expect(reads).toBeGreaterThan(2);
		const again = await (await post(a, '/chirps/monthly', { area: GRID })).json();
		expect(again).toEqual(first);
		expect(s3.keys.length).toBe(reads);
		// A different area is a different entry.
		await post(a, '/chirps/monthly', { area: box(25.0, -20.5, 25.2, -20.0) });
		expect(s3.keys.length).toBeGreaterThan(reads);
	});

	it('refuses a body that isn’t JSON, an invalid area and a GET, each with { error }', async () => {
		const a = app();
		const notJson = await post(a, '/chirps/monthly', '{area:');
		expect(notJson.status).toBe(400);
		expect(await notJson.json()).toEqual({ error: 'the body is not JSON' });
		const open = await post(a, '/chirps/monthly', { area: { type: 'Polygon', coordinates: [[[25, -20.5], [25.4, -20.5], [25.4, -20]]] } });
		expect(open.status).toBe(400);
		expect(await open.json()).toEqual({ error: expect.stringMatching(/^the area /) });
		const get = await a.request('/chirps/monthly');
		expect(get.status).toBe(404);
		expect(await get.json()).toEqual({ error: 'not found' });
	});

	it('refuses an area outside the copy, over 2 000 cells, or over sea only, as 422', async () => {
		const a = app();
		for (const area of [box(5, -20.5, 5.2, -20), box(20, -34, 23, -31), box(30, -30, 30.2, -29.8)]) {
			const res = await post(a, '/chirps/monthly', { area });
			expect(res.status).toBe(422);
			expect(await res.json()).toEqual({ error: expect.any(String) });
		}
	});

	it(`refuses a body over ${MAX_BODY_BYTES} bytes as 413`, async () => {
		const big = JSON.stringify({ area: GRID, pad: 'x'.repeat(MAX_BODY_BYTES) });
		const res = await post(app(), '/chirps/monthly', big, { 'content-length': String(Buffer.byteLength(big)) });
		expect(res.status).toBe(413);
		expect(await res.json()).toEqual({ error: expect.stringContaining('larger than 2 MiB') });
	});

	it('answers 503 with what to run when there is no local copy (local-first)', async () => {
		const res = await post(app({ chirps: new ChirpsCopy(chirpsCopyConfig({ CHIRPS_SOURCE: 'local', CHIRPS_LOCAL_DIR: '/nonexistent/pitman' })) }), '/chirps/monthly', { area: GRID });
		expect(res.status).toBe(503);
		expect(await res.json()).toEqual({ error: expect.stringContaining('pnpm dev:data:synthetic') });
	});

	it('limits each client per instance, 429 past the limit, the map-grid route counted apart', async () => {
		const a = app({ rateLimits: { chirps: { limit: 2, windowMs: 60_000 }, mapGrid: many } });
		const h = { 'x-forwarded-for': '203.0.113.9' };
		expect((await post(a, '/chirps/monthly', { area: GRID }, h)).status).toBe(200);
		expect((await post(a, '/chirps/monthly', { area: GRID }, h)).status).toBe(200);
		const third = await post(a, '/chirps/monthly', { area: GRID }, h);
		expect(third.status).toBe(429);
		expect(third.headers.get('retry-after')).toBeTruthy();
		expect((await post(a, '/map-grid/mean', { area: box(21.3, -33.7, 21.5, -33.5) }, h)).status).toBe(200);
	});
});

describe('POST /map-grid/mean', () => {
	it('answers MapGridSample (plus provenance) for an area over the grid', async () => {
		const res = await post(app(), '/map-grid/mean', { area: box(21.3, -33.7, 21.5, -33.5) });
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ grid: 'synthetic', cellCount: 400, meanMapMm: expect.any(Number), cellSizeM: expect.any(Number), fetchedOn: '2026-10-29', cellDeg: 0.01, coveragePct: 100, source: 'local', attribution: 'Synthetic test data' });
	});

	it('refuses an area the grid doesn’t cover as 422, with the reason', async () => {
		const res = await post(app(), '/map-grid/mean', { area: box(25, -20.5, 25.4, -20) });
		expect(res.status).toBe(422);
		expect(await res.json()).toEqual({ error: expect.stringContaining('no MAP grid covers the area'), reasons: ['synthetic has no value inside the area'] });
	});
});

describe('the template’s guards', () => {
	it('answers CORS preflights for the allowed origin only', async () => {
		const pre = (origin: string) => app().request('/chirps/monthly', { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST' } });
		expect((await pre('http://localhost:7777')).headers.get('access-control-allow-origin')).toBe('http://localhost:7777');
		expect((await pre('https://evil.example')).headers.get('access-control-allow-origin')).toBeNull();
	});

	it('refuses requests without the CloudFront shared secret when one is set', async () => {
		vi.stubEnv('CLOUDFRONT_SHARED_SECRET', 'not-a-real-secret');
		const a = app();
		expect((await post(a, '/chirps/monthly', { area: GRID })).status).toBe(403);
		expect((await post(a, '/chirps/monthly', { area: GRID }, { 'x-cloudfront-shared-secret': 'not-a-real-secret' })).status).toBe(200);
	});

	it('answers /health, and mounts the routes unprefixed (CloudFront strips /api, R4-I4)', async () => {
		expect(await (await app().request('/health')).json()).toEqual({ ok: true });
		expect((await post(app(), '/api/chirps/monthly', { area: GRID })).status).toBe(404);
	});

	it('compares the shared secret only at equal length (timing-safe), refusing a prefix or a longer value', async () => {
		vi.stubEnv('CLOUDFRONT_SHARED_SECRET', 'not-a-real-secret');
		const a = app();
		for (const v of ['not-a-real', 'not-a-real-secret-x', 'not-a-real-secreT']) expect((await a.request('/health', { headers: { 'x-cloudfront-shared-secret': v } })).status).toBe(403);
	});

	it('answers 503 "not configured" when the environment names no source, and reads the local copies .env.development names', async () => {
		const unset = createApp();
		const c = await post(unset, '/chirps/monthly', { area: GRID });
		expect(c.status).toBe(503);
		expect(await c.json()).toEqual({ error: expect.stringContaining('CHIRPS_SOURCE is not set') });
		expect(await (await post(unset, '/map-grid/mean', { area: GRID })).json()).toEqual({ error: expect.stringContaining('MAP_GRID_SOURCE is not set') });
		vi.stubEnv('CHIRPS_SOURCE', 'local');
		vi.stubEnv('CHIRPS_LOCAL_DIR', '/nonexistent/pitman-default');
		vi.stubEnv('MAP_GRID_SOURCE', 'local');
		vi.stubEnv('MAP_GRID_LOCAL_FILE', '/nonexistent/pitman-default.json');
		const local = createApp();
		expect(await (await post(local, '/chirps/monthly', { area: GRID })).json()).toEqual({ error: expect.stringContaining('/nonexistent/pitman-default') });
		expect(await (await post(local, '/map-grid/mean', { area: GRID })).json()).toEqual({ error: expect.stringContaining('/nonexistent/pitman-default.json') });
	});
});

describe('the synthetic dev data', () => {
	it('gives a synthetic quaternary a full CHIRPS record and a grid MAP', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'pitman-dev-'));
		tmp.push(dir);
		await writeSyntheticChirps({ dir: join(dir, 'mirror'), through: '1990-12-31' });
		writeFileSync(join(dir, 'grid.json'), syntheticMapGridJson());
		const q = JSON.parse(readFileSync(join(FIXTURE_GEO_DIR, 'quaternaries.synthetic.geojson'), 'utf8')) as { features: { properties: { code: string }; geometry: unknown }[] };
		const area = q.features.find((f) => f.properties.code === 'Z01A')!.geometry;
		const a = app({
			chirps: new ChirpsCopy(chirpsCopyConfig({ CHIRPS_SOURCE: 'local', CHIRPS_LOCAL_DIR: join(dir, 'mirror') })),
			mapGrids: new MapGridCatalog([localGridSource(join(dir, 'grid.json'), 'synthetic')])
		});
		const chirps = (await (await post(a, '/chirps/monthly', { area })).json()) as ChirpsMonthly;
		expect(chirps.months).toHaveLength(10 * 12);
		expect(chirps.months.every((m) => typeof m.mm === 'number')).toBe(true);
		expect(chirps.weightRemovedPct).toBe(0);
		const annual = chirps.months.reduce((s, m) => s + m.mm!, 0) / 10;
		expect(annual).toBeGreaterThan(150);
		expect(annual).toBeLessThan(1500);
		const map = await (await post(a, '/map-grid/mean', { area })).json();
		expect(map).toMatchObject({ grid: 'synthetic', coveragePct: 100, meanMapMm: expect.any(Number) });
	});
});
