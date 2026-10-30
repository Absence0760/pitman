import { describe, expect, it, vi } from 'vitest';
import { LAND_USE_PATH, LandUseRequestError, fetchLandUse, readLandUse } from './api.js';
import { ANSWER, AREA } from './fixtures.test-helper.js';

vi.mock('$app/env/public', () => ({ PUBLIC_API_URL: 'http://localhost:3001' }));

const options = (respond: () => Response | Promise<Response>) => {
	const fetchFn = vi.fn<typeof fetch>(async () => respond());
	return { fetchFn, opts: { baseUrl: 'http://api.test/', fetch: fetchFn } };
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const refused = async (respond: () => Response | Promise<Response>) => {
	const err = await fetchLandUse(AREA, options(respond).opts).catch((e: unknown) => e);
	expect(err).toBeInstanceOf(LandUseRequestError);
	return err as LandUseRequestError;
};

describe('fetchLandUse', () => {
	it('posts the geometry and nothing else, to the route under the base', async () => {
		const { fetchFn, opts } = options(() => json(ANSWER));
		expect(await fetchLandUse(AREA, opts)).toEqual(ANSWER);
		const [url, init] = fetchFn.mock.calls[0]!;
		expect(url).toBe(`http://api.test${LAND_USE_PATH}`);
		expect(JSON.parse(init?.body as string)).toEqual({ area: AREA });
		expect(init?.headers).not.toHaveProperty('authorization');
	});

	it('tells “not configured” from a refusal, keeping the service’s words', async () => {
		expect(await refused(() => json({ error: 'land-use data is not configured' }, 503))).toMatchObject({ kind: 'unavailable', message: 'land-use data is not configured', status: 503 });
		expect(await refused(() => json({ error: 'the area is too big' }, 422))).toMatchObject({ kind: 'refused', message: 'the area is too big' });
		expect(await refused(() => json({ error: 'try later' }, 429))).toMatchObject({ kind: 'busy', message: 'try later' });
		expect(await refused(() => json({ error: 'too long' }, 504))).toMatchObject({ kind: 'timeout', message: 'too long' });
		expect((await refused(() => new Response('<html>', { status: 500 }))).kind).toBe('server');
		expect((await refused(() => new Response('<html>', { status: 200 }))).kind).toBe('invalid');
		expect((await refused(() => Promise.reject(new TypeError('offline')))).kind).toBe('network');
	});

	it('times out in words', async () => {
		const fetchFn = vi.fn<typeof fetch>((_u, init) => new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))));
		const err = await fetchLandUse(AREA, { baseUrl: '', fetch: fetchFn, timeoutMs: 5 }).catch((e: unknown) => e);
		expect(err).toMatchObject({ kind: 'timeout' });
	});

	it('passes on the caller’s cancel as an abort', async () => {
		const controller = new AbortController();
		const fetchFn = vi.fn<typeof fetch>((_u, init) => new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))));
		const pending = fetchLandUse(AREA, { baseUrl: '', fetch: fetchFn, signal: controller.signal });
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
	});
});

describe('readLandUse', () => {
	it('takes a good answer, warnings or none', () => {
		expect(readLandUse(ANSWER)).toEqual(ANSWER);
		expect(readLandUse({ ...ANSWER, warnings: ['a note'] }).warnings).toEqual(['a note']);
	});

	it.each([
		['not an object', null],
		['no fields', { ...ANSWER, fields: 1 }],
		['a field without its crop', { ...ANSWER, fields: [{ ...ANSWER.fields[0], crop: '' }] }],
		['irrigation', { ...ANSWER, fields: [{ ...ANSWER.fields[0], irrigated: 'yes' }] }],
		['a field without its area', { ...ANSWER, fields: [{ ...ANSWER.fields[0], areaHa: -1 }] }],
		['a field without its shape', { ...ANSWER, fields: [{ ...ANSWER.fields[0], geometry: { type: 'Point', coordinates: [] } }] }],
		['no dams', { ...ANSWER, dams: null }],
		['a dam without its place', { ...ANSWER, dams: [{ ...ANSWER.dams[0], lon: 'x' }] }],
		['a dam without its source', { ...ANSWER, dams: [{ ...ANSWER.dams[0], source: 'hearsay' }] }],
		['figure', { ...ANSWER, dams: [{ ...ANSWER.dams[0], capacityMm3: -1 }] }],
		['no dataset', { ...ANSWER, dataset: '' }],
		['no survey year', { ...ANSWER, surveyYear: 2023.5 }],
		['no fetch date', { ...ANSWER, fetchedOn: 'today' }],
		['no source', { ...ANSWER, source: 'elsewhere' }],
		['warnings', { ...ANSWER, warnings: [1] }]
	])('refuses %s', (what, body) => {
		expect(() => readLandUse(body)).toThrow(new RegExp(what));
	});
});
