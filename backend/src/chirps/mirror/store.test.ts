// The S3 store against a fake client (never the network): keys under a prefix, a missing key as
// undefined (an unwritten chunk), any other failure thrown (a 403 is a permission error, not "no rain",
// docs/data.md § Cross-account access), and the whole copy read through it.
import { describe, expect, it } from 'vitest';
import { FIXTURE_MIRROR_DIR, fakeS3 } from '../../__tests__/fakeS3.js';
import { openFinals, readFinalsBlock } from './arrays.js';
import { readManifest } from './manifest.js';
import { openStore, S3Store } from './store.js';

describe('S3Store', () => {
	it('reads keys under its prefix, and a missing key (NoSuchKey or 404) as undefined', async () => {
		const s3 = fakeS3(FIXTURE_MIRROR_DIR, { prefix: 'copy' });
		const store = new S3Store('bucket', '/copy/', { client: s3 });
		expect(store.key('/rnl/zarr.json')).toBe('copy/rnl/zarr.json');
		expect((await store.get('/rnl/zarr.json'))!.byteLength).toBeGreaterThan(100);
		expect(await store.get('/rnl/c/0/0/0/0')).toBeUndefined();
		s3.fail = () => Object.assign(new Error('gone'), { $metadata: { httpStatusCode: 404 } });
		expect(await store.get('/x')).toBeUndefined();
	});

	it('throws a 403 and any other failure rather than reading them as an unwritten chunk', async () => {
		const s3 = fakeS3(FIXTURE_MIRROR_DIR);
		const store = new S3Store('bucket', '', { client: s3 });
		s3.fail = () => Object.assign(new Error('AccessDenied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
		await expect(store.get('/rnl/zarr.json')).rejects.toThrow('AccessDenied');
		s3.fail = () => new Error('socket hang up');
		await expect(store.get('/rnl/zarr.json')).rejects.toThrow('socket hang up');
	});

	it('serves the whole copy: manifest, array and chunks, through openStore’s s3:// form', async () => {
		const s3 = fakeS3(FIXTURE_MIRROR_DIR, { bucket: 'water-management-mirror-1', prefix: 'p' });
		const store = openStore('s3://water-management-mirror-1/p', { s3, region: 'af-south-1' });
		const m = await readManifest(store, 'rnl');
		expect(m?.finalThrough).toBe('2025-12-31');
		const f = (await openFinals(store, 'rnl'))!;
		const got = await readFinalsBlock(f, 2024, 0, 365, { y0: 309, x0: 300, h: 1, w: 1 });
		expect(got.values.every(Number.isFinite)).toBe(true);
		// What the reader asks for (the cross-account grant, docs/data.md rows 1–2): only keys under rnl/,
		// never the root group's zarr.json.
		expect(s3.keys.every((k) => k.startsWith('p/rnl/'))).toBe(true);
		expect(s3.keys).toContain('p/rnl/manifest.json');
		expect(s3.keys).toContain('p/rnl/zarr.json');
		expect(s3.keys).not.toContain('p/zarr.json');
	});
});
