import type { AreaGeometry } from '@pitman/wrsm';
import { describe, expect, it } from 'vitest';
import { ChirpsRequestError, apiUrl, fetchChirpsMonthly, readChirpsMonthly } from './api.js';
import { WORKED_CHIRPS } from './fixtures.test-helper.js';

const area: AreaGeometry = {
	type: 'Polygon',
	coordinates: [
		[
			[20, -30],
			[21, -30],
			[21, -29],
			[20, -30]
		]
	]
};

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A fetch that never answers until its signal aborts. */
const hanging: typeof fetch = (_input, init) =>
	new Promise((_resolve, reject) => {
		init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
	});

async function failure(promise: Promise<unknown>): Promise<ChirpsRequestError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof ChirpsRequestError) return error;
		throw error;
	}
	throw new Error('expected a failure');
}

describe('apiUrl', () => {
	it.each([
		['http://localhost:3001', 'http://localhost:3001/chirps/monthly'],
		['http://localhost:3001/', 'http://localhost:3001/chirps/monthly'],
		['/api', '/api/chirps/monthly'],
		['/api/', '/api/chirps/monthly'],
		['', '/chirps/monthly'],
		[undefined, '/chirps/monthly']
	])('%s', (base, url) => {
		expect(apiUrl(base, '/chirps/monthly')).toBe(url);
	});
});

describe('fetchChirpsMonthly', () => {
	it('POSTs the geometry and nothing else, and returns the series', async () => {
		const calls: { url: string; init: RequestInit | undefined }[] = [];
		const result = await fetchChirpsMonthly(area, {
			baseUrl: 'http://localhost:3001',
			fetch: async (input, init) => {
				calls.push({ url: String(input), init });
				return json(200, WORKED_CHIRPS);
			}
		});
		expect(result).toEqual(WORKED_CHIRPS);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe('http://localhost:3001/chirps/monthly');
		expect(calls[0]?.init?.method).toBe('POST');
		expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ area });
	});

	it('shows the backend’s own message for a 4xx { error }', async () => {
		const e = await failure(fetchChirpsMonthly(area, { baseUrl: '', fetch: async () => json(422, { error: 'The area touches 2 431 cells; the limit is 2 000.' }) }));
		expect([e.kind, e.status, e.message]).toEqual(['refused', 422, 'The area touches 2 431 cells; the limit is 2 000.']);
	});

	it('falls back to the status when a 4xx body has no message', async () => {
		const e = await failure(fetchChirpsMonthly(area, { baseUrl: '', fetch: async () => new Response('nope', { status: 400 }) }));
		expect(e.message).toBe('The rainfall service refused the area (HTTP 400).');
	});

	it('says "busy" for 429 and "failed" for a 5xx', async () => {
		expect((await failure(fetchChirpsMonthly(area, { baseUrl: '', fetch: async () => json(429, { error: 'slow down' }) }))).kind).toBe('busy');
		const e = await failure(fetchChirpsMonthly(area, { baseUrl: '', fetch: async () => json(500, { error: 'Internal server error' }) }));
		expect([e.kind, e.message]).toEqual(['server', 'The rainfall service failed (HTTP 500): Internal server error. Try again later.']);
	});

	it('turns a network failure into a plain message', async () => {
		const e = await failure(
			fetchChirpsMonthly(area, {
				baseUrl: '',
				fetch: async () => {
					throw new TypeError('Failed to fetch');
				}
			})
		);
		expect([e.kind, e.message]).toEqual(['network', 'Pitman could not reach the rainfall service. Check the connection and try again.']);
	});

	it('times out', async () => {
		const e = await failure(fetchChirpsMonthly(area, { baseUrl: '', fetch: hanging, timeoutMs: 10 }));
		expect(e.kind).toBe('timeout');
		expect(e.message).toMatch(/did not answer within 0 seconds/);
	});

	it('rethrows the AbortError when the caller cancels', async () => {
		const controller = new AbortController();
		const pending = fetchChirpsMonthly(area, { baseUrl: '', fetch: hanging, signal: controller.signal });
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
	});

	it('refuses a 200 that is not the expected shape', async () => {
		const e = await failure(fetchChirpsMonthly(area, { baseUrl: '', fetch: async () => new Response('<html>', { status: 200 }) }));
		expect(e.kind).toBe('invalid');
	});
});

describe('readChirpsMonthly', () => {
	it('accepts the worked example', () => {
		expect(readChirpsMonthly(WORKED_CHIRPS)).toBe(WORKED_CHIRPS);
	});

	it.each([
		['no months', { ...WORKED_CHIRPS, months: [] }, /no months/],
		['a skipped month', { ...WORKED_CHIRPS, months: WORKED_CHIRPS.months.filter((_, i) => i !== 5) }, /skipped/],
		['a negative total', { ...WORKED_CHIRPS, months: [{ year: 1981, month: 1, mm: -1 }] }, /not a number/],
		['a month 13', { ...WORKED_CHIRPS, months: [{ year: 1981, month: 13, mm: 1 }] }, /out of order/],
		['no cells', { ...WORKED_CHIRPS, cells: undefined }, /no cells/],
		['a bad date', { ...WORKED_CHIRPS, finalThrough: '1987-12' }, /finalThrough/],
		['an unknown source', { ...WORKED_CHIRPS, source: 'ftp' }, /no source/]
	])('refuses %s', (_name, body, message) => {
		expect(() => readChirpsMonthly(body)).toThrow(message);
	});
});
