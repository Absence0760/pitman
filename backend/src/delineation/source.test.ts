// Which DEM the environment names (source.ts), and what each failure says.
import { describe, expect, it } from 'vitest';
import { CopyUnavailableError } from '../chirps/copy.js';
import { COPERNICUS_NOTICE, DemSource, demLocationFromEnv } from './source.js';
import { syntheticDem } from './syntheticDem.js';

describe('demLocationFromEnv', () => {
	it('is local with the default or a named file', () => {
		expect(demLocationFromEnv({ DEM_SOURCE: 'local' })).toMatchObject({ kind: 'local', file: expect.stringMatching(/\.local\/dem\/synthetic\.pmtiles$/) });
		expect(demLocationFromEnv({ DEM_SOURCE: ' local ', DEM_LOCAL_FILE: '/x/y.pmtiles', DEM_LABEL: 'Mine' })).toEqual({ kind: 'local', file: '/x/y.pmtiles', label: 'Mine' });
	});

	it('reads s3:// and https:// in DATA_REGION, af-south-1 by default', () => {
		expect(demLocationFromEnv({ DEM_SOURCE: 's3://water-management-tiles-1/tiles/terrain.pmtiles' })).toMatchObject({ kind: 'remote', region: 'af-south-1' });
		expect(demLocationFromEnv({ DEM_SOURCE: 'https://x.example/t.pmtiles', DATA_REGION: 'eu-west-1' })).toMatchObject({ kind: 'remote', region: 'eu-west-1' });
	});

	it('says what is wrong with anything else', () => {
		expect(demLocationFromEnv({})).toEqual({ problem: expect.stringMatching(/DEM_SOURCE is not set/) });
		expect(demLocationFromEnv({ DEM_SOURCE: 'ftp://x' })).toEqual({ problem: expect.stringMatching(/must be local/) });
	});
});

describe('DemSource', () => {
	it('refuses as unavailable, naming what to do', async () => {
		await expect(new DemSource({ problem: 'DEM_SOURCE is not set' }).open()).rejects.toThrow(CopyUnavailableError);
		await expect(new DemSource({ kind: 'local', file: '/nowhere.pmtiles' }).open()).rejects.toThrow(/pnpm dev:data:synthetic/);
	});

	it('gives a local DEM its own attribution, a remote one the licence’s notice', async () => {
		expect((await new DemSource(syntheticDem()).open()).attribution).toBe('Synthetic test data');
		expect(COPERNICUS_NOTICE).toContain('produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved');
		expect(COPERNICUS_NOTICE).toContain('© Mapterhorn');
	});
});
