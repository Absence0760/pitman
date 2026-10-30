import type { AreaGeometry } from '@pitman/wrsm';
import { describe, expect, it } from 'vitest';
import { bboxOf, CHANNEL_BOX_DEG, channelBoxes, fetchChannels, fetchChannelsOver, fetchDelineation, readChannels, readDelineateAnswer, TributaryRequestError } from './api.js';

const within: AreaGeometry = {
	type: 'Polygon',
	coordinates: [
		[
			[21, -33.75],
			[21.25, -33.75],
			[21.25, -33.5],
			[21, -33.5],
			[21, -33.75]
		]
	]
};
const answer = {
	tributary: within,
	remainder: within,
	tributaryKm2: 29,
	remainderKm2: 614,
	outsideKm2: 0,
	outsidePct: 0,
	warning: null,
	snapM: 12,
	pansKm2: 0,
	dem: { label: 'Synthetic DEM', fingerprint: 'abc', zoom: 11, attribution: 'Synthetic test data' }
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const answering =
	(status: number, body: unknown): typeof fetch =>
	async () =>
		json(status, body);

async function failure(promise: Promise<unknown>): Promise<TributaryRequestError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof TributaryRequestError) return error;
		throw error;
	}
	throw new Error('expected a failure');
}

describe('fetchDelineation', () => {
	it('POSTs the click and the piece, and nothing else', async () => {
		let url = '';
		let sent: unknown;
		const f: typeof fetch = async (u, init) => {
			url = String(u);
			sent = JSON.parse(String(init?.body));
			return json(200, answer);
		};
		expect(await fetchDelineation([21.1, -33.6], within, { baseUrl: '/api', fetch: f })).toEqual(answer);
		expect(url).toBe('/api/delineate');
		expect(sent).toEqual({ point: [21.1, -33.6], within });
	});

	it('adds keepPoint only when asked', async () => {
		let sent: Record<string, unknown> = {};
		const f: typeof fetch = async (_u, init) => {
			sent = JSON.parse(String(init?.body));
			return json(200, answer);
		};
		await fetchDelineation([21.1, -33.6], within, { baseUrl: '', fetch: f, keepPoint: true });
		expect(sent['keepPoint']).toBe(true);
	});

	it('keeps a refusal’s message and reason', async () => {
		const e = await failure(fetchDelineation([21, -33], within, { baseUrl: '', fetch: answering(422, { error: 'No terrain channel runs within 150 m of that point.', reason: 'off_channel' }) }));
		expect(e).toMatchObject({ kind: 'refused', status: 422, reason: 'off_channel', message: 'No terrain channel runs within 150 m of that point.' });
	});

	it('carries the larger channel to offer', async () => {
		const larger = { at: [21.1, -33.6], distanceM: 400, km2: 500, pointKm2: 2 };
		const e = await failure(fetchDelineation([21, -33], within, { baseUrl: '', fetch: answering(422, { error: 'A much larger terrain channel…', reason: 'larger_channel', larger }) }));
		expect(e.larger).toEqual(larger);
	});

	it('drops a reason outside the contract, keeping the message', async () => {
		const e = await failure(fetchDelineation([21, -33], within, { baseUrl: '', fetch: answering(422, { error: 'The outline failed.', reason: 'made_up' }) }));
		expect(e.reason).toBeUndefined();
		expect(e.message).toBe('The outline failed.');
	});

	it('words busy, server, network and timeout', async () => {
		expect((await failure(fetchDelineation([21, -33], within, { baseUrl: '', fetch: answering(429, { error: 'x' }) }))).kind).toBe('busy');
		const down = await failure(fetchDelineation([21, -33], within, { baseUrl: '', fetch: answering(503, { error: 'run `pnpm dev:data:synthetic`' }) }));
		expect(down.kind).toBe('server');
		expect(down.message).toMatch(/pnpm dev:data:synthetic/);
		const f: typeof fetch = async () => Promise.reject(new TypeError('failed'));
		expect((await failure(fetchDelineation([21, -33], within, { baseUrl: '', fetch: f }))).kind).toBe('network');
		const hanging: typeof fetch = (_u, init) =>
			new Promise((_r, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
		expect((await failure(fetchDelineation([21, -33], within, { baseUrl: '', fetch: hanging, timeoutMs: 5 }))).kind).toBe('timeout');
	});

	it('rejects with the abort when the caller cancels', async () => {
		const c = new AbortController();
		const f: typeof fetch = (_u, init) =>
			new Promise((_r, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
		const p = fetchDelineation([21, -33], within, { baseUrl: '', fetch: f, signal: c.signal });
		c.abort();
		await expect(p).rejects.toMatchObject({ name: 'AbortError' });
	});
});

describe('readDelineateAnswer, readChannels', () => {
	it('refuses a body missing what the screen relies on', () => {
		expect(readDelineateAnswer(answer)).toBe(answer);
		expect(() => readDelineateAnswer(null)).toThrow(/can’t read/);
		expect(() => readDelineateAnswer({ ...answer, tributary: { type: 'Point' } })).toThrow(/no tributary/);
		expect(() => readDelineateAnswer({ ...answer, snapM: 'near' })).toThrow(/no snapM/);
		expect(() => readDelineateAnswer({ ...answer, dem: {} })).toThrow(/no dem/);
		expect(() => readChannels({ type: 'Feature' })).toThrow(/no channels/);
	});
});

describe('channel boxes', () => {
	it('finds a geometry’s box, holes and all parts included', () => {
		expect(bboxOf(within)).toEqual([21, -33.75, 21.25, -33.5]);
		expect(bboxOf({ type: 'MultiPolygon', coordinates: [within.coordinates as never, [[[22, -34], [22.1, -34], [22.1, -33.9], [22, -34]]]] })).toEqual([21, -34, 22.1, -33.5]);
	});

	it('cuts a box to the fixed grid, each within the backend’s limit', () => {
		expect(channelBoxes([21, -33.75, 21.25, -33.5])).toEqual([[20.8, -34, 21.2, -33.6], [21.2, -34, 21.6, -33.6], [20.8, -33.6, 21.2, -33.2], [21.2, -33.6, 21.6, -33.2]]);
		for (const [w, s, e, n] of channelBoxes([21.05, -34.3, 22.3, -33.1])) {
			expect(e - w).toBeLessThanOrEqual(CHANNEL_BOX_DEG + 1e-9);
			expect(n - s).toBeLessThanOrEqual(CHANNEL_BOX_DEG + 1e-9);
		}
	});
});

describe('fetchChannels', () => {
	const collection = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { km2: 3 }, geometry: { type: 'LineString', coordinates: [[21, -33], [21.1, -33]] } }] };

	it('asks for the box in the query', async () => {
		let url = '';
		const f: typeof fetch = async (u) => {
			url = String(u);
			return json(200, collection);
		};
		await fetchChannels([21, -33.8, 21.4, -33.4], { baseUrl: 'http://localhost:3001', fetch: f });
		expect(url).toBe('http://localhost:3001/channels?bbox=21,-33.8,21.4,-33.4');
	});

	it('asks again after a 504, whose work is kept, then gives up', async () => {
		let n = 0;
		const f: typeof fetch = async () => (++n < 3 ? json(504, { error: 'ask again' }) : json(200, collection));
		expect((await fetchChannels([21, -34, 21.4, -33.6], { baseUrl: '', fetch: f })).features).toHaveLength(1);
		expect(n).toBe(3);
		expect((await failure(fetchChannels([21, -34, 21.4, -33.6], { baseUrl: '', fetch: answering(504, { error: 'ask again' }) }))).status).toBe(504);
	});

	it('gathers a geometry’s boxes, reporting as they arrive', async () => {
		const seen: number[] = [];
		const all = await fetchChannelsOver(within, { baseUrl: '', fetch: answering(200, collection) }, (part) => seen.push(part.features.length));
		expect(seen).toEqual([1, 2, 3, 4]);
		expect(all.features).toHaveLength(4);
	});
});
