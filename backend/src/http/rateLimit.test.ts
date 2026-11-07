// The per-instance rate limit (rateLimit.ts): a fixed window per client, a 429 with Retry-After, the
// client read from CloudFront's headers (the last X-Forwarded-For entry, never the first), and the
// memory bound.
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { clientKey, rateLimit } from './rateLimit.js';

const app = (limit: number, now: () => number, maxClients?: number) => {
	const a = new Hono();
	a.use('*', rateLimit({ limit, windowMs: 60_000, now, maxClients }));
	a.get('/', (c) => c.text('ok'));
	return a;
};
const get = (a: Hono, headers: Record<string, string> = {}) => a.request('/', { headers });

describe('rateLimit', () => {
	it('lets `limit` requests through per window, then answers 429 with Retry-After until the window ends', async () => {
		let t = 0;
		const a = app(2, () => t);
		expect((await get(a)).status).toBe(200);
		expect((await get(a)).status).toBe(200);
		t = 15_000;
		const refused = await get(a);
		expect(refused.status).toBe(429);
		expect(refused.headers.get('retry-after')).toBe('45');
		expect(await refused.json()).toEqual({ error: expect.stringContaining('too many requests') });
		t = 60_000;
		expect((await get(a)).status).toBe(200);
	});

	it('counts each client on its own, by the address CloudFront appended, not one the client wrote', async () => {
		const a = app(1, () => 0);
		expect((await get(a, { 'x-forwarded-for': '1.1.1.1, 203.0.113.5' })).status).toBe(200);
		// The same viewer behind a forged first entry is the same client.
		expect((await get(a, { 'x-forwarded-for': '9.9.9.9, 203.0.113.5' })).status).toBe(429);
		expect((await get(a, { 'x-forwarded-for': '203.0.113.6' })).status).toBe(200);
		expect((await get(a, { 'cloudfront-viewer-address': '198.51.100.1:443' })).status).toBe(200);
		expect((await get(a, { 'cloudfront-viewer-address': '198.51.100.1:5000' })).status).toBe(429);
	});

	it('forgets the oldest clients past maxClients', async () => {
		const a = app(1, () => 0, 2);
		for (const ip of ['10.0.0.1', '10.0.0.2', '10.0.0.3']) expect((await get(a, { 'x-forwarded-for': ip })).status).toBe(200);
		// 10.0.0.1 was dropped to make room, so it starts a new window.
		expect((await get(a, { 'x-forwarded-for': '10.0.0.1' })).status).toBe(200);
		expect((await get(a, { 'x-forwarded-for': '10.0.0.3' })).status).toBe(429);
	});

	it('keys on the viewer CloudFront appended, whether or not the Function URL appends the edge after it', async () => {
		const key = async (xff: string, sourceIp?: string) => {
			const a = new Hono<{ Bindings: { event?: unknown } }>();
			a.get('/', (c) => c.text(clientKey(c)));
			const env = sourceIp ? { event: { requestContext: { http: { sourceIp } } } } : {};
			return (await a.request('/', { headers: { 'x-forwarded-for': xff } }, env)).text();
		};
		const EDGE = '130.176.0.7';
		// The Function URL leaves the header alone: the viewer is last.
		expect(await key('9.9.9.9, 203.0.113.5', EDGE)).toBe('203.0.113.5');
		// The Function URL appends the edge: dropped, so unrelated viewers on one edge never share a bucket.
		expect(await key('9.9.9.9, 203.0.113.5, 130.176.0.7', EDGE)).toBe('203.0.113.5');
		expect(await key('203.0.113.6, 130.176.0.7', EDGE)).toBe('203.0.113.6');
		// A client can't use the drop to pick its key: only right-hand entries equal to the edge go.
		expect(await key('130.176.0.7, 203.0.113.5', EDGE)).toBe('203.0.113.5');
		// Never empty: a lone entry equal to the source stays.
		expect(await key('130.176.0.7', EDGE)).toBe('130.176.0.7');
		expect(await key('203.0.113.5')).toBe('203.0.113.5');
	});
});
