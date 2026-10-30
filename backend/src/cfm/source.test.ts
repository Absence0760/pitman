import { describe, expect, it, vi } from 'vitest';
import { CopyUnavailableError } from '../chirps/copy.js';
import { CROP_LAYER, DAM_LAYER } from './adapter.js';
import { cfmLandUseSource, landUseSourceFromEnv, openLandUse } from './source.js';

const area = { type: 'Polygon', coordinates: [[[21, -34], [21.1, -34], [21.1, -33.9], [21, -33.9], [21, -34]]] } as const;
const limits = { deadline: 1000, now: () => 0 };
const ring = [[21.01, -33.99], [21.02, -33.99], [21.02, -33.98], [21.01, -33.99]];
const TOKEN = 'invented-test-credential';

describe('landUseSourceFromEnv', () => {
	it('is local for `local`, and not configured when unset', () => {
		expect(landUseSourceFromEnv({ CFM_SOURCE: 'local' })).toMatchObject({ kind: 'local' });
		expect(landUseSourceFromEnv({})).toEqual({ problem: expect.stringContaining('CFM_SOURCE is not set') });
		expect(landUseSourceFromEnv({ CFM_SOURCE: '  ' })).toEqual({ problem: expect.stringContaining('CFM_SOURCE is not set') });
		expect(landUseSourceFromEnv({ CFM_SOURCE: 'ftp' })).toEqual({ problem: expect.stringContaining('local or cfm') });
	});

	it('needs a token and an https crop layer for `cfm`, and never repeats a value', () => {
		expect(landUseSourceFromEnv({ CFM_SOURCE: 'cfm' })).toEqual({ problem: 'CFM_TOKEN is not set' });
		expect(landUseSourceFromEnv({ CFM_SOURCE: 'cfm', CFM_TOKEN: TOKEN })).toEqual({ problem: 'CFM_CROPS_LAYER_URL is not set' });
		const plain = landUseSourceFromEnv({ CFM_SOURCE: 'cfm', CFM_TOKEN: TOKEN, CFM_CROPS_LAYER_URL: 'http://gis.example.test/0' });
		expect(plain).toEqual({ problem: 'the CFM layer URLs must be https' });
		expect(landUseSourceFromEnv({ CFM_SOURCE: 'cfm', CFM_TOKEN: TOKEN, CFM_CROPS_LAYER_URL: 'https://gis.example.test/0' })).toMatchObject({ kind: 'cfm' });
	});

	it('answers 503 through openLandUse when not configured', () => {
		expect(() => openLandUse({ problem: 'CFM_TOKEN is not set' })).toThrow(CopyUnavailableError);
	});
});

describe('the cfm source', () => {
	const page = (url: string) => (url.includes('/dams/') ? [{ properties: { [DAM_LAYER.id]: 1 }, geometry: { type: 'Point', coordinates: [21.05, -33.95] } }, { properties: {} }] : [{ properties: { [CROP_LAYER.id]: 1, [CROP_LAYER.crop]: 'Apples' }, geometry: { type: 'Polygon', coordinates: [ring] } }, { properties: { [CROP_LAYER.id]: 1, [CROP_LAYER.crop]: 'Apples' }, geometry: { type: 'Polygon', coordinates: [ring] } }, { properties: {} }]);
	const stub = () => {
		const seen = new Set<string>();
		return vi.fn<typeof fetch>(async (url) => {
			const first = !seen.has(String(url));
			seen.add(String(url));
			return new Response(JSON.stringify({ features: first ? page(String(url)) : [] }));
		});
	};

	it('reads both layers through the adapter, each id once, and counts what it couldn’t read', async () => {
		const read = await cfmLandUseSource({ cropsUrl: 'https://gis.example.test/crops/0', damsUrl: 'https://gis.example.test/dams/0', token: TOKEN, fetchFn: stub() }).read(area, limits);
		expect(read.fields.map((f) => f.id)).toEqual(['1']);
		expect(read.dams.map((d) => d.id)).toEqual(['cfm-1']);
		expect(read.warnings).toEqual(['1 of the layer’s records could not be read and are left out of the areas.', '1 of the dams layer’s records could not be read and are left out.']);
	});

	it('says so when no dams layer is configured', async () => {
		const fetchFn = stub();
		const read = await cfmLandUseSource({ cropsUrl: 'https://gis.example.test/crops/0', token: TOKEN, fetchFn }).read(area, limits);
		expect(read.dams).toEqual([]);
		expect(read.warnings).toContain('No Cape Farm Mapper dams layer is configured, so no dams are listed.');
	});
});
