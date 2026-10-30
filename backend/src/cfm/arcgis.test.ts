// The query against a stub server: the token's path, paging to the end, every bound, and no upstream text in a message.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CopyUnavailableError } from '../chirps/copy.js';
import { ApiError } from '../http/errors.js';
import { CFM_MAX_PAGES, CFM_MAX_QUERY_VERTICES, CFM_MAX_UPSTREAM_BYTES, CFM_PAGE_SIZE, esriGeometry, queryLayer } from './arcgis.js';

const area = { type: 'Polygon', coordinates: [[[21, -34], [21.1, -34], [21.1, -33.9], [21, -33.9], [21, -34]]] } as const;
const TOKEN = 'invented-test-credential';
const options = (fetchFn: typeof fetch, over: object = {}) => ({ layerUrl: 'https://gis.example.test/rest/Crops/MapServer/0/', token: TOKEN, area, outFields: 'A,B', orderBy: 'A', deadline: 1000, now: () => 0, fetch: fetchFn, ...over });
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const features = (n: number) => ({ features: Array.from({ length: n }, (_, i) => ({ id: i })) });

afterEach(() => {
	vi.restoreAllMocks();
});

describe('esriGeometry', () => {
	it('sends the outline with Esri’s ring order: outer clockwise, holes anticlockwise', () => {
		const hole = [[21.04, -33.96], [21.06, -33.96], [21.06, -33.94], [21.04, -33.94], [21.04, -33.96]] as [number, number][];
		const g = esriGeometry({ type: 'Polygon', coordinates: [area.coordinates[0], hole] });
		expect(g.geometryType).toBe('esriGeometryPolygon');
		const { rings } = JSON.parse(g.geometry) as { rings: [number, number][][] };
		const clockwise = (r: [number, number][]) => r.slice(1).reduce((s, p, i) => s + (p[0] - r[i]![0]) * (p[1] + r[i]![1]), 0) > 0;
		expect(rings.map(clockwise)).toEqual([true, false]);
	});

	it('sends the box when the outline is too long for a query', () => {
		const n = CFM_MAX_QUERY_VERTICES + 1;
		const ring = Array.from({ length: n }, (_, i): [number, number] => [21 + Math.cos((2 * Math.PI * i) / n), -34 + Math.sin((2 * Math.PI * i) / n)]);
		ring.push(ring[0]!);
		const g = esriGeometry({ type: 'Polygon', coordinates: [ring] });
		expect(g.geometryType).toBe('esriGeometryEnvelope');
		expect(JSON.parse(g.geometry)).toMatchObject({ xmin: expect.closeTo(20, 3), xmax: expect.closeTo(22, 3), spatialReference: { wkid: 4326 } });
	});
});

describe('queryLayer', () => {
	it('posts to the layer’s query, the token in the form and never the URL', async () => {
		const fetchFn = vi.fn<typeof fetch>(async () => json(features(0)));
		await queryLayer(options(fetchFn));
		const [url, init] = fetchFn.mock.calls[0]!;
		expect(url).toBe('https://gis.example.test/rest/Crops/MapServer/0/query');
		expect(String(url)).not.toContain(TOKEN);
		expect(init?.method).toBe('POST');
		const form = init?.body as URLSearchParams;
		expect(form.get('token')).toBe(TOKEN);
		expect(Object.fromEntries(form)).toMatchObject({ f: 'geojson', outSR: '4326', inSR: '4326', spatialRel: 'esriSpatialRelIntersects', outFields: 'A,B', orderByFields: 'A', resultOffset: '0' });
	});

	it('reads to an empty page, so a layer answering short pages isn’t cut off', async () => {
		const pages = [features(300), features(300), features(5), features(0)];
		const offsets: (string | null)[] = [];
		const fetchFn = vi.fn<typeof fetch>(async (_u, init) => {
			offsets.push((init?.body as URLSearchParams).get('resultOffset'));
			return json(pages.shift());
		});
		expect(await queryLayer(options(fetchFn))).toHaveLength(605);
		expect(offsets).toEqual(['0', '300', '600', '605']);
	});

	it(`refuses past ${CFM_MAX_PAGES} pages rather than answer part of the layer`, async () => {
		const fetchFn = vi.fn<typeof fetch>(async () => json(features(CFM_PAGE_SIZE)));
		await expect(queryLayer(options(fetchFn))).rejects.toMatchObject({ status: 422, message: expect.stringContaining('smaller area') });
		expect(fetchFn).toHaveBeenCalledTimes(CFM_MAX_PAGES);
	});

	it('refuses past its byte budget', async () => {
		const fetchFn = vi.fn<typeof fetch>(async () => new Response(`{"features":[${'0,'.repeat(CFM_MAX_UPSTREAM_BYTES / 2)}0]}`));
		await expect(queryLayer(options(fetchFn))).rejects.toMatchObject({ status: 422 });
		expect(fetchFn).toHaveBeenCalledTimes(1);
	});

	it('stops at the deadline', async () => {
		const fetchFn = vi.fn<typeof fetch>(async () => json(features(1)));
		let t = 0;
		const err = await queryLayer(options(fetchFn, { deadline: 3, now: () => t++ })).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ApiError);
		expect((err as ApiError).status).toBe(504);
	});

	it('turns ArcGIS’s errors in a 200 into a sentence of Pitman’s own, naming the token only when that is the trouble', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const expired = vi.fn<typeof fetch>(async () => json({ error: { code: 498, message: `Invalid token ${TOKEN}` } }));
		const err = await queryLayer(options(expired)).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(CopyUnavailableError);
		expect((err as Error).message).toMatch(/renew/);
		expect((err as Error).message).not.toContain(TOKEN);
		const other = vi.fn<typeof fetch>(async () => json({ error: { code: 400, message: 'upstream words' } }));
		await expect(queryLayer(options(other))).rejects.toThrow(/refused the query/);
	});

	it('answers a failed read as unavailable, and logs neither the token nor the upstream body', async () => {
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		await expect(queryLayer(options(vi.fn<typeof fetch>(async () => new Response(`denied ${TOKEN}`, { status: 500 }))))).rejects.toThrow(/HTTP 500/);
		await expect(queryLayer(options(vi.fn<typeof fetch>(async () => Promise.reject(new TypeError(`failed ${TOKEN}`)))))).rejects.toThrow(/not answering/);
		await expect(queryLayer(options(vi.fn<typeof fetch>(async () => new Response('<html>'))))).rejects.toThrow(/can’t read/);
		await expect(queryLayer(options(vi.fn<typeof fetch>(async () => json({}))))).rejects.toThrow(/can’t read/);
		expect(JSON.stringify(log.mock.calls)).not.toContain(TOKEN);
	});
});
