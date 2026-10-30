import { describe, expect, it } from 'vitest';
import { SubdivideRequestError, createSubdivideData, readMapGridCells, readMapGridMean, readQuaternaries } from './data.js';
import { CELLS, QUATERNARY, sample } from './fixtures.test-helper.js';

const COLLECTION = { type: 'FeatureCollection', source: 'Synthetic boundaries', features: [{ type: 'Feature', properties: { code: 'Z01A' }, geometry: QUATERNARY }] };

function answering(status: number, body: unknown, seen: { url?: string; init?: RequestInit } = {}) {
	return createSubdivideData({
		baseUrl: '/api/',
		fetch: (async (url: string, init: RequestInit) => {
			seen.url = url;
			seen.init = init;
			return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
		}) as unknown as typeof fetch
	});
}

const signal = new AbortController().signal;

describe('the backend client', () => {
	it('sends the geometry and nothing else (rule 7) and reads the mean with its provenance', async () => {
		const seen: { url?: string; init?: RequestInit } = {};
		const answer = await answering(200, sample(820), seen).mapGridMean(QUATERNARY, signal);
		expect(seen.url).toBe('/api/map-grid/mean');
		expect(Object.keys(JSON.parse(seen.init?.body as string))).toEqual(['area']);
		expect(answer.meanMapMm).toBe(820);
		expect(answer.coveragePct).toBe(98.5);
	});

	it('sends the box for the cells', async () => {
		const seen: { url?: string; init?: RequestInit } = {};
		await answering(200, CELLS, seen).mapGridCells([20, -33.3, 20.3, -33], signal);
		expect(seen.url).toBe('/api/map-grid/cells');
		expect(JSON.parse(seen.init?.body as string)).toEqual({ bbox: [20, -33.3, 20.3, -33] });
	});

	it('passes the service’s own sentence on a 422, the route a piece the grid doesn’t cover takes', async () => {
		const error = await answering(422, { error: 'no MAP grid covers the area: 40 % has values; type the MAP instead' })
			.mapGridMean(QUATERNARY, signal)
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(SubdivideRequestError);
		expect((error as SubdivideRequestError).status).toBe(422);
		expect((error as Error).message).toContain('type the MAP instead');
	});

	it('turns a 404 from /quaternaries into the upload advice (D-1: not served yet)', async () => {
		await expect(answering(404, {}).quaternaries(signal)).rejects.toThrow('Upload the boundary');
	});

	it('says busy on a 429 and failed on a 500', async () => {
		await expect(answering(429, {}).quaternaries(signal)).rejects.toThrow('busy');
		await expect(answering(500, { error: 'boom' }).mapGridMean(QUATERNARY, signal)).rejects.toThrow('failed (HTTP 500): boom');
	});

	it('says so when the network fails, and lets an abort through for the caller to ignore', async () => {
		const down = createSubdivideData({ baseUrl: '', fetch: (async () => { throw new TypeError('failed'); }) as unknown as typeof fetch });
		await expect(down.quaternaries(signal)).rejects.toThrow('could not reach');
		const controller = new AbortController();
		controller.abort();
		const aborted = createSubdivideData({ baseUrl: '', fetch: (async () => { throw new DOMException('Aborted', 'AbortError'); }) as unknown as typeof fetch });
		await expect(aborted.quaternaries(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
	});

	it('times out in words', async () => {
		const slow = createSubdivideData({
			baseUrl: '',
			timeoutMs: 1,
			fetch: ((_url: string, init: RequestInit) => new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))))) as unknown as typeof fetch
		});
		await expect(slow.quaternaries(signal)).rejects.toThrow('did not answer');
	});
});

describe('reading the answers', () => {
	it('accepts good shapes', () => {
		expect(readQuaternaries(COLLECTION).features).toHaveLength(1);
		expect(readMapGridCells(CELLS).cols).toBe(3);
		expect(readMapGridMean(sample(600)).meanMapMm).toBe(600);
	});

	it('refuses a feature without a code, or without a source to credit', () => {
		expect(() => readQuaternaries({ ...COLLECTION, features: [{ properties: {}, geometry: QUATERNARY }] })).toThrow('without its code');
		expect(() => readQuaternaries({ ...COLLECTION, source: '' })).toThrow('no source');
	});

	it('refuses cells that do not fill the block', () => {
		expect(() => readMapGridCells({ ...CELLS, rows: 4 })).toThrow('do not fill');
	});

	it('refuses a mean without its number', () => {
		expect(() => readMapGridMean({ ...sample(600), meanMapMm: null })).toThrow('no meanMapMm');
	});
});
