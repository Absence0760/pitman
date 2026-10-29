// Where the MAP grid comes from (source.ts): the environment's settings and their local default, a
// local file, an S3 object (gzipped) through a fake client, a missing grid with a hint, and a grid read
// once per instance.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { FIXTURE_GEO_DIR, fakeS3 } from '../__tests__/fakeS3.js';
import { CopyUnavailableError } from '../chirps/copy.js';
import { DEFAULT_MAP_GRID_LOCAL_FILE, localGridSource, MapGridCatalog, mapGridSourcesFromEnv } from './source.js';
import { syntheticMapGridJson } from './synthetic.js';

const tmp: string[] = [];
afterAll(() => tmp.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('mapGridSourcesFromEnv', () => {
	it('is not configured when unset, and local defaults to the synthetic grid', () => {
		expect(mapGridSourcesFromEnv({})).toEqual({ problem: expect.stringContaining('MAP_GRID_SOURCE is not set') });
		expect(mapGridSourcesFromEnv({ MAP_GRID_SOURCE: 'local' })).toEqual([expect.objectContaining({ kind: 'local', dataset: 'synthetic', where: resolve(DEFAULT_MAP_GRID_LOCAL_FILE) })]);
	});

	it('takes s3://bucket/key, naming the grid from its file unless MAP_GRID_DATASET does, and refuses anything else', () => {
		expect(mapGridSourcesFromEnv({ MAP_GRID_SOURCE: 's3://b-1/reference/map-grid/waas-swcape-2007.json.gz' })).toEqual([
			expect.objectContaining({ kind: 's3', dataset: 'waas-swcape-2007', where: 's3://b-1/reference/map-grid/waas-swcape-2007.json.gz' })
		]);
		expect(mapGridSourcesFromEnv({ MAP_GRID_SOURCE: 's3://b-1/k.json', MAP_GRID_DATASET: 'WAAS-SWCape-2007' })).toEqual([expect.objectContaining({ dataset: 'WAAS-SWCape-2007' })]);
		expect(mapGridSourcesFromEnv({ MAP_GRID_SOURCE: 's3://b-1' })).toEqual({ problem: expect.stringContaining('must be local or s3://bucket/key') });
		expect(mapGridSourcesFromEnv({ MAP_GRID_SOURCE: 'ftp' })).toEqual({ problem: 'MAP_GRID_SOURCE must be local or s3://bucket/key, not ftp' });
	});
});

describe('MapGridCatalog', () => {
	it('reads a gzipped grid from S3 once per instance', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'pitman-grid-'));
		tmp.push(dir);
		writeFileSync(join(dir, 'grid.json.gz'), gzipSync(readFileSync(join(FIXTURE_GEO_DIR, 'map-grid.synthetic.json'))));
		const s3 = fakeS3(dir, { bucket: 'water-management-reference-1', prefix: 'reference/map-grid' });
		const sources = mapGridSourcesFromEnv(
			{ MAP_GRID_SOURCE: 's3://water-management-reference-1/reference/map-grid/grid.json.gz', MAP_GRID_DATASET: 'test-grid' },
			{ s3 }
		);
		const catalog = new MapGridCatalog(sources);
		const [g] = await catalog.grids();
		expect(g).toMatchObject({ source: 's3', grid: { dataset: 'test-grid', cellDeg: 0.01, cells: 1575 } });
		await catalog.grids();
		expect(s3.keys).toEqual(['reference/map-grid/grid.json.gz']);
	});

	it('says how to make the local grid when there is none, and reads it once it exists', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'pitman-grid-'));
		tmp.push(dir);
		const file = join(dir, 'synthetic.json');
		const catalog = new MapGridCatalog([localGridSource(file, 'synthetic')]);
		await expect(catalog.grids()).rejects.toThrow(CopyUnavailableError);
		await expect(catalog.grids()).rejects.toThrow(/pnpm dev:data:synthetic/);
		writeFileSync(file, syntheticMapGridJson());
		const [g] = await catalog.grids();
		expect(g!.grid).toMatchObject({ dataset: 'synthetic', cellDeg: 0.01, cells: 7500 });
	});

	it('refuses an unreadable grid file and a bad setting as 503s', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'pitman-grid-'));
		tmp.push(dir);
		writeFileSync(join(dir, 'bad.json'), '{"cellDeg": 0}');
		await expect(new MapGridCatalog([localGridSource(join(dir, 'bad.json'), 'bad')]).grids()).rejects.toThrow(/can't be read: the JSON file has no "cellDeg"/);
		await expect(new MapGridCatalog({ problem: 'x' }).grids()).rejects.toThrow(/not configured: x/);
	});
});
