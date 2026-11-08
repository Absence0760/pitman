// The per-user daily quota (decision R4-D7) through createApp(): a 429 saying when it resets once a user has
// used the day's requests, counted per user (not per address, not per instance), a fresh count at 00:00 UTC,
// the per-IP limits still in front, and fail-closed: no usable store, or a store that doesn't answer, is a 503.
import type { UserRecord } from '@absence0760/auth-kit';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FIXTURE_GEO_DIR, FIXTURE_MIRROR_DIR } from '../__tests__/fakeS3.js';
import { eventsLogged, guardLogs } from '../__tests__/logGuard.js';
import { asSignedIn, bootstrap, cookieFor, testAuth, testClock } from '../__tests__/session.js';
import { type AppDeps, createApp, DAILY_QUOTAS } from '../app.js';
import { ChirpsCopy, chirpsCopyConfig } from '../chirps/copy.js';
import { localGridSource, MapGridCatalog } from '../mapgrid/source.js';
import { DAY_MS, QUOTA_UNAVAILABLE, QUOTA_UNCONFIGURED, quotaExpiresAt, quotaKey, resetQuotaLogForTests, utcDay } from './quota.js';
import { memoryUsageStore, usageStoreFromEnv, type UsageStore } from './store.js';

guardLogs();
afterEach(() => resetQuotaLogForTests());

const box = (w: number, s: number, e: number, n: number) => ({ type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });
/** The fixture copy's written grid. */
const GRID = box(25.0, -20.5, 25.4, -20.0);
const many = { limit: 1000, windowMs: 60_000 };

const t = testAuth();
const admin = await bootstrap(t);
const added = await t.auth.kit.addUser(admin, 'second@example.test', false);
if (!added.ok) throw new Error(added.error);
const second: UserRecord = added.value;

function app(deps: Partial<AppDeps>, user: UserRecord = admin) {
	const a = createApp({
		auth: t.auth,
		chirps: new ChirpsCopy(chirpsCopyConfig({ CHIRPS_SOURCE: 'local', CHIRPS_LOCAL_DIR: FIXTURE_MIRROR_DIR })),
		mapGrids: new MapGridCatalog([localGridSource(join(FIXTURE_GEO_DIR, 'map-grid.synthetic.json'), 'synthetic')]),
		rateLimits: { chirps: many, mapGrid: many, delineate: many, channels: many, landUse: many },
		...deps
	});
	return { as: async (u: UserRecord = user) => asSignedIn(a, await cookieFor(t, u)) };
}
const chirps = (r: { request: (p: string, i?: RequestInit) => Response | Promise<Response> }, headers: Record<string, string> = {}) =>
	r.request('/chirps/monthly', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ area: GRID }) });

/** An area the synthetic MAP grid covers. */
const mapMean = (r: { request: (p: string, i?: RequestInit) => Response | Promise<Response> }) =>
	r.request('/map-grid/mean', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ area: box(21.3, -33.7, 21.5, -33.5) }) });

describe('dailyQuota', () => {
	it('answers 429 once a user has used the day, saying when it resets, and counts nothing past the limit', async () => {
		const clock = testClock(Date.parse('2026-11-07T21:30:00Z'));
		const usage = memoryUsageStore(clock.now);
		const r = await app({ usage, dailyQuotas: { chirps: 2 }, now: clock.now }).as();
		expect((await chirps(r)).status).toBe(200);
		expect((await chirps(r)).status).toBe(200);
		const refused = await chirps(r);
		expect(refused.status).toBe(429);
		expect(refused.headers.get('retry-after')).toBe(String(2.5 * 3600));
		expect(await refused.json()).toEqual({ error: "you have used today's 2 CHIRPS rainfall reads, the daily limit per user; it resets at 00:00 UTC, in 2 h 30 min" });
		// A refused request is not counted: one more slot is still exactly one more.
		expect(await usage.take(quotaKey('chirps', admin.id, '2026-11-07'), 3, 0)).toBe(true);
		expect(await usage.take(quotaKey('chirps', admin.id, '2026-11-07'), 3, 0)).toBe(false);
	});

	it('starts a fresh count at 00:00 UTC, not at local midnight', async () => {
		const clock = testClock(Date.parse('2026-11-07T23:59:59Z'));
		const r = await app({ usage: memoryUsageStore(clock.now), dailyQuotas: { chirps: 1 }, now: clock.now }).as();
		expect((await chirps(r)).status).toBe(200);
		const refused = await chirps(r);
		expect(refused.status).toBe(429);
		expect(refused.headers.get('retry-after')).toBe('1');
		expect(((await refused.json()) as { error: string }).error).toMatch(/in 1 min$/);
		clock.advance(1_000);
		expect(utcDay(clock.now())).toBe('2026-11-08');
		expect((await chirps(r)).status).toBe(200);
		expect((await chirps(r)).status).toBe(429);
	});

	it('counts per user, not per address: a second user from the same address keeps their own day', async () => {
		const usage = memoryUsageStore();
		const a = app({ usage, dailyQuotas: { chirps: 1 } });
		const ip = { 'x-forwarded-for': '203.0.113.5' };
		expect((await chirps(await a.as(admin), ip)).status).toBe(200);
		expect((await chirps(await a.as(admin), ip)).status).toBe(429);
		expect((await chirps(await a.as(second), ip)).status).toBe(200);
		// A new session for the same user is the same count.
		expect((await chirps(await a.as(admin), { 'x-forwarded-for': '198.51.100.9' })).status).toBe(429);
	});

	it('counts per user across instances: two apps on one store (two Lambda instances on the table) share the day', async () => {
		const usage = memoryUsageStore();
		const one = await app({ usage, dailyQuotas: { chirps: 2 } }).as();
		const two = await app({ usage, dailyQuotas: { chirps: 2 } }).as();
		expect((await chirps(one)).status).toBe(200);
		expect((await chirps(two)).status).toBe(200);
		expect((await chirps(one)).status).toBe(429);
		expect((await chirps(two)).status).toBe(429);
	});

	it('keeps each route its own count, with its own message', async () => {
		const usage = memoryUsageStore();
		const r = await app({ usage, dailyQuotas: { chirps: 1, channels: 0, delineate: 0, landUse: 0 } }).as();
		expect((await chirps(r)).status).toBe(200);
		const channels = await r.request('/channels?bbox=25,-20.5,25.1,-20.4');
		expect(channels.status).toBe(429);
		expect(((await channels.json()) as { error: string }).error).toMatch(/^you have used today's 0 channel boxes/);
		const post = (path: string) => r.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
		expect(((await (await post('/delineate')).json()) as { error: string }).error).toMatch(/tributary delineations/);
		expect(((await (await post('/cfm/land-use')).json()) as { error: string }).error).toMatch(/land-use reads/);
		// Not counted: the MAP grid and the quaternary list.
		expect((await mapMean(r)).status).toBe(200);
	});

	it('keeps the per-address limit in front: a burst is refused before it reaches the count', async () => {
		const taken: string[] = [];
		const usage: UsageStore = { take: async (k) => (taken.push(k), true) };
		const r = await app({ usage, rateLimits: { chirps: { limit: 1, windowMs: 60_000 }, mapGrid: many } }).as();
		expect((await chirps(r)).status).toBe(200);
		expect((await chirps(r)).status).toBe(429);
		expect(taken).toEqual([quotaKey('chirps', admin.id, utcDay(Date.now()))]);
	});

	it('keys the count on the user id and the UTC day, and lets it expire a day after the day ends', () => {
		expect(quotaKey('chirps', 'u-1', '2026-11-07')).toBe('quota#chirps#u-1#2026-11-07');
		const t0 = Date.parse('2026-11-07T00:00:00Z');
		expect(quotaExpiresAt(t0)).toBe((t0 + 2 * DAY_MS) / 1000);
		expect(quotaExpiresAt(t0 + DAY_MS - 1)).toBe((t0 + 2 * DAY_MS) / 1000);
	});

	it('fails closed on the Lambda without a DynamoDB store: 503 on the counted routes, logged once, the rest still answer', async () => {
		const usage = usageStoreFromEnv({ AWS_LAMBDA_FUNCTION_NAME: 'pitman-backend' });
		const r = await app({ usage }).as();
		for (const res of [await chirps(r), await chirps(r)]) {
			expect(res.status).toBe(503);
			expect(await res.json()).toEqual({ error: QUOTA_UNCONFIGURED });
		}
		expect((await mapMean(r)).status).toBe(200);
		expect(eventsLogged()).toEqual([{ event: 'usage.unconfigured', problem: 'USAGE_STORE is not set (the Lambda needs dynamodb)' }]);
	});

	it('fails closed when the store does not answer: 503, logged by name and code only', async () => {
		const usage: UsageStore = {
			take: async () => {
				throw Object.assign(new Error('arn:aws:dynamodb:af-south-1:111111111111:table/pitman-usage throttled'), { name: 'ThrottlingException' });
			}
		};
		const res = await chirps(await app({ usage }).as());
		expect(res.status).toBe(503);
		expect(await res.json()).toEqual({ error: QUOTA_UNAVAILABLE });
		expect(eventsLogged()).toEqual([{ event: 'usage.quota_failed', error: 'ThrottlingException' }]);
	});

	it('sizes every quota as a positive whole number of requests', () => {
		for (const v of Object.values(DAILY_QUOTAS)) expect(Number.isInteger(v) && v > 0).toBe(true);
	});
});
