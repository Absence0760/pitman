// POST /cfm/land-use through the whole app: local-first, the 503, the bounds, the cache, the rate limit.
import type { AreaGeometry, LandUseAnswer } from '@pitman/wrsm';
import { describe, expect, it, vi } from 'vitest';
import { type AppDeps, createApp } from '../app.js';
import { ChirpsCopy, chirpsCopyConfig } from '../chirps/copy.js';
import { DemSource } from '../delineation/source.js';
import { MapGridCatalog } from '../mapgrid/source.js';
import { QuaternaryStore } from '../quaternaries/source.js';
import { CFM_MAX_AREA_KM2, CFM_MAX_AREA_VERTICES, landUseRoutes } from './routes.js';
import { localLandUseSource, type LandUseSource } from './source.js';
import { asSignedIn, signedIn } from '../__tests__/session.js';

const box = (w: number, s: number, e: number, n: number): AreaGeometry => ({ type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });
const Z01A = box(21, -33.75, 21.25, -33.5);
const unused = { problem: 'unused' };
// Behind the gate (A-AUTH-1): every request carries a signed-in admin's session.
const session = await signedIn();
const app = (deps: Partial<AppDeps> = {}) =>
	asSignedIn(createApp({
		auth: session.auth,
		chirps: new ChirpsCopy(chirpsCopyConfig({})),
		mapGrids: new MapGridCatalog(unused),
		dem: new DemSource(unused),
		quaternaries: new QuaternaryStore(unused),
		landUse: localLandUseSource(),
		today: () => '2026-10-30',
		...deps
	}), session.cookie);
const post = (a: ReturnType<typeof app>, body: unknown, headers: Record<string, string> = {}) =>
	a.request('/cfm/land-use', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

describe('POST /cfm/land-use', () => {
	it('answers the synthetic source with no token and no cloud', async () => {
		const res = await post(app(), { area: Z01A });
		expect(res.status).toBe(200);
		const a = (await res.json()) as LandUseAnswer;
		expect(a).toMatchObject({ source: 'local', surveyYear: 2023, fetchedOn: '2026-10-30' });
		expect(a.dataset).toMatch(/Synthetic/);
		expect(a.fields.length).toBeGreaterThan(200);
		expect(a.dams.length).toBeGreaterThan(10);
		expect(a.fields.every((f) => f.areaHa > 0 && f.geometry.type !== undefined)).toBe(true);
		expect(a.dams.every((d) => d.lon >= 21 && d.lon <= 21.25 && d.lat >= -33.75 && d.lat <= -33.5)).toBe(true);
	});

	it('clips to a part of the block, so the answer belongs to the area asked for', async () => {
		const whole = (await (await post(app(), { area: Z01A })).json()) as LandUseAnswer;
		const half = (await (await post(app(), { area: box(21, -33.75, 21.125, -33.5) })).json()) as LandUseAnswer;
		const sum = (a: LandUseAnswer) => a.fields.reduce((s, f) => s + f.areaHa, 0);
		expect(sum(half)).toBeLessThan(sum(whole) * 0.7);
		expect(sum(half)).toBeGreaterThan(sum(whole) * 0.3);
	});

	it('answers an empty list off the block', async () => {
		const a = (await (await post(app(), { area: box(25, -30, 25.1, -29.9) })).json()) as LandUseAnswer;
		expect([a.fields, a.dams]).toEqual([[], []]);
	});

	it('is a 503 saying why when not configured', async () => {
		const res = await post(app({ landUse: { problem: 'CFM_SOURCE is not set' } }), { area: Z01A });
		expect(res.status).toBe(503);
		expect(await res.json()).toEqual({ error: expect.stringContaining('not configured') });
	});

	it('checks the body before the configuration, as a 400', async () => {
		expect((await post(app({ landUse: unused }), '{')).status).toBe(400);
		expect((await post(app(), { area: { type: 'Point', coordinates: [21, -34] } })).status).toBe(400);
	});

	it(`refuses an area over ${CFM_MAX_AREA_KM2} km² before it reads anything`, async () => {
		const read = vi.fn<LandUseSource['read']>();
		const res = await post(app({ landUse: { ...localLandUseSource(), read } }), { area: box(21, -34, 23, -32) });
		expect(res.status).toBe(422);
		expect(await res.json()).toEqual({ error: expect.stringContaining('choose a (sub-)catchment') });
		expect(read).not.toHaveBeenCalled();
	});

	it(`refuses an outline of more than ${CFM_MAX_AREA_VERTICES} vertices before it reads anything`, async () => {
		const n = CFM_MAX_AREA_VERTICES + 1;
		const ring = Array.from({ length: n }, (_, i): [number, number] => [21.1 + 0.1 * Math.cos((2 * Math.PI * i) / n), -33.6 + 0.1 * Math.sin((2 * Math.PI * i) / n)]);
		ring.push(ring[0]!);
		const read = vi.fn<LandUseSource['read']>();
		const res = await post(app({ landUse: { ...localLandUseSource(), read } }), { area: { type: 'Polygon', coordinates: [ring] } });
		expect(res.status).toBe(422);
		expect(read).not.toHaveBeenCalled();
	});

	it('reads an area once, and keeps the day it read it', async () => {
		const source = localLandUseSource();
		const read = vi.fn(source.read);
		let day = '2026-10-30';
		const routes = landUseRoutes({ source: { ...source, read }, today: () => day });
		const ask = () => routes.request('/land-use', { method: 'POST', body: JSON.stringify({ area: Z01A }) });
		await ask();
		day = '2026-10-31';
		const again = (await (await ask()).json()) as LandUseAnswer;
		expect(read).toHaveBeenCalledTimes(1);
		expect(again.fetchedOn).toBe('2026-10-30');
		expect(routes.cache.hits).toBe(1);
	});

	it('doesn’t keep a failure', async () => {
		const source = localLandUseSource();
		const read = vi.fn(source.read).mockRejectedValueOnce(new Error('down'));
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		const routes = landUseRoutes({ source: { ...source, read } });
		const ask = () => routes.request('/land-use', { method: 'POST', body: JSON.stringify({ area: Z01A }) });
		expect((await ask()).status).toBe(500);
		expect((await ask()).status).toBe(200);
		log.mockRestore();
	});

	it('refuses an answer too big for one response, never a cut-down one', async () => {
		const routes = landUseRoutes({ source: localLandUseSource(), maxAnswerBytes: 1000 });
		const res = await routes.request('/land-use', { method: 'POST', body: JSON.stringify({ area: Z01A }) });
		expect(res.status).toBe(422);
		expect(await res.json()).toEqual({ error: expect.stringContaining('smaller (sub-)catchment') });
	});

	it('passes on what the source couldn’t do', async () => {
		const source: LandUseSource = { ...localLandUseSource(), read: async () => ({ fields: [], dams: [], warnings: ['from the source'] }) };
		const a = (await (await post(app({ landUse: source }), { area: Z01A })).json()) as LandUseAnswer;
		expect(a.warnings).toEqual(['from the source']);
	});

	it('stops a slow clip at the deadline', async () => {
		let t = 0;
		const routes = landUseRoutes({ source: localLandUseSource(), deadlineMs: 5, now: () => (t += 10) });
		const res = await routes.request('/land-use', { method: 'POST', body: JSON.stringify({ area: Z01A }) });
		expect(res.status).toBe(504);
	});

	it('rate limits per client, the cache behind the limit', async () => {
		const a = app({ rateLimits: { chirps: { limit: 1, windowMs: 1 }, mapGrid: { limit: 1, windowMs: 1 }, landUse: { limit: 1, windowMs: 60_000 } } });
		const h = { 'x-forwarded-for': '203.0.113.9' };
		expect((await post(a, { area: Z01A }, h)).status).toBe(200);
		expect((await post(a, { area: Z01A }, h)).status).toBe(429);
	});

	it('sends the browser no credential', async () => {
		const text = await (await post(app(), { area: Z01A })).text();
		expect(text).not.toMatch(/token/i);
	});
});
