import { describe, expect, it } from 'vitest';
import { fetchMapGridCells, fetchQuaternaries, MapRequestError, readMapGridCells, readQuaternaries } from './api.js';

const POLYGON = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };
const QUATERNARIES = { type: 'FeatureCollection', source: 'Invented', features: [{ type: 'Feature', properties: { code: 'Z01A' }, geometry: POLYGON }] };
const CELLS = { dataset: 'synthetic', source: 'Invented', cellDeg: 0.01, originLon: 21, originLat: -33, cols: 2, rows: 1, values: [300, null] };

const answer = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
const kindOf = (p: Promise<unknown>) => p.then(() => 'resolved', (e: MapRequestError) => e.kind);

describe('readQuaternaries', () => {
	it('takes a collection with its source', () => {
		expect(readQuaternaries(QUATERNARIES).source).toBe('Invented');
	});
	it.each([
		['null', null],
		['no features', { source: 's' }],
		['no source (rule 8)', { features: [] }],
		['a feature without its code', { source: 's', features: [{ properties: {}, geometry: POLYGON }] }],
		['a feature without its outline', { source: 's', features: [{ properties: { code: 'Z01A' }, geometry: { type: 'Point', coordinates: [0, 0] } }] }]
	])('refuses %s', (_name, body) => {
		expect(() => readQuaternaries(body)).toThrow(MapRequestError);
	});
});

describe('readMapGridCells', () => {
	it('takes a block', () => {
		expect(readMapGridCells(CELLS).cols).toBe(2);
	});
	it.each([
		['null', null],
		['no source (rule 8)', { ...CELLS, source: '' }],
		['no cell size', { ...CELLS, cellDeg: 0 }],
		['values that don’t fill the block', { ...CELLS, values: [1] }]
	])('refuses %s', (_name, body) => {
		expect(() => readMapGridCells(body)).toThrow(MapRequestError);
	});
});

describe('fetchQuaternaries', () => {
	it('asks the API base for the route', async () => {
		const urls: string[] = [];
		const doFetch = (async (url: string) => {
			urls.push(url);
			return new Response(JSON.stringify(QUATERNARIES));
		}) as unknown as typeof fetch;
		await fetchQuaternaries({ baseUrl: '/api/', fetch: doFetch });
		expect(urls).toEqual(['/api/quaternaries']);
	});
	it('names the 503 unavailable and keeps the server’s words', async () => {
		const failed = fetchQuaternaries({ baseUrl: '', fetch: answer(503, { error: 'not configured' }) });
		await expect(failed).rejects.toMatchObject({ kind: 'unavailable', message: 'not configured', status: 503 });
	});
	it('names the other failures', async () => {
		expect(await kindOf(fetchQuaternaries({ baseUrl: '', fetch: answer(429, {}) }))).toBe('busy');
		expect(await kindOf(fetchQuaternaries({ baseUrl: '', fetch: answer(500, {}) }))).toBe('server');
		expect(await kindOf(fetchQuaternaries({ baseUrl: '', fetch: (async () => new Response('not json')) as typeof fetch }))).toBe('invalid');
		const down = (async () => {
			throw new TypeError('offline');
		}) as typeof fetch;
		expect(await kindOf(fetchQuaternaries({ baseUrl: '', fetch: down }))).toBe('network');
	});
	it('times out', async () => {
		const never = ((_url: string, init: RequestInit) =>
			new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))) as unknown as typeof fetch;
		expect(await kindOf(fetchQuaternaries({ baseUrl: '', fetch: never, timeoutMs: 1 }))).toBe('timeout');
	});
});

describe('fetchMapGridCells', () => {
	it('posts the box and nothing else', async () => {
		let sent: RequestInit | undefined;
		const doFetch = (async (_url: string, init: RequestInit) => {
			sent = init;
			return new Response(JSON.stringify(CELLS));
		}) as unknown as typeof fetch;
		await fetchMapGridCells([21, -34, 22, -33], { baseUrl: '', fetch: doFetch });
		expect(sent?.method).toBe('POST');
		expect(JSON.parse(sent?.body as string)).toEqual({ bbox: [21, -34, 22, -33] });
	});
	it.each(['too_wide', 'too_dense', 'no_coverage'])('names the refusal %s', async (code) => {
		expect(await kindOf(fetchMapGridCells([0, 0, 1, 1], { baseUrl: '', fetch: answer(422, { error: 'no', code }) }))).toBe(code);
	});
	it('takes any other 4xx as refused', async () => {
		expect(await kindOf(fetchMapGridCells([0, 0, 1, 1], { baseUrl: '', fetch: answer(400, { error: 'no' }) }))).toBe('refused');
	});
	it('rethrows the caller’s abort', async () => {
		const controller = new AbortController();
		const aborted = (async () => {
			controller.abort();
			throw new DOMException('aborted', 'AbortError');
		}) as typeof fetch;
		await expect(fetchMapGridCells([0, 0, 1, 1], { baseUrl: '', fetch: aborted, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
	});
});
