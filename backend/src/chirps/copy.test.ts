// Which copy the API reads (copy.ts): the environment's settings and their defaults (local-first), the
// local copy missing with a hint, the S3 copy through a fake client, the opened copy kept for its TTL,
// and a failure not kept.
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FIXTURE_MIRROR_DIR, fakeS3 } from '../__tests__/fakeS3.js';
import { ChirpsCopy, chirpsCopyConfig, CopyUnavailableError, DEFAULT_CHIRPS_LOCAL_DIR } from './copy.js';

const tmp: string[] = [];
afterAll(() => tmp.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('chirpsCopyConfig', () => {
	it('is not configured when CHIRPS_SOURCE is unset or empty, and local defaults to .local/mirror', () => {
		expect(chirpsCopyConfig({})).toEqual({ problem: expect.stringContaining('CHIRPS_SOURCE is not set') });
		expect(chirpsCopyConfig({ CHIRPS_SOURCE: ' ' })).toEqual({ problem: expect.stringContaining('CHIRPS_SOURCE is not set') });
		expect(chirpsCopyConfig({ CHIRPS_SOURCE: 'local' })).toMatchObject({ kind: 'local', where: resolve(DEFAULT_CHIRPS_LOCAL_DIR) });
	});

	it('names IC-WBT’s bucket for s3, in af-south-1 unless told otherwise, and needs the bucket', () => {
		expect(chirpsCopyConfig({ CHIRPS_SOURCE: 's3', CHIRPS_BUCKET: 'water-management-mirror-1' })).toEqual({
			kind: 's3',
			url: 's3://water-management-mirror-1',
			region: 'af-south-1',
			where: 's3://water-management-mirror-1/rnl'
		});
		// CHIRPS_PREFIX is the rnl array's prefix; the store opens at its parent.
		expect(chirpsCopyConfig({ CHIRPS_SOURCE: 's3', CHIRPS_BUCKET: 'b-1', CHIRPS_PREFIX: '/x/rnl/', DATA_REGION: 'eu-west-1' })).toMatchObject({ url: 's3://b-1/x', region: 'eu-west-1' });
		expect(chirpsCopyConfig({ CHIRPS_SOURCE: 's3', CHIRPS_BUCKET: 'b-1', CHIRPS_PREFIX: 'sat' })).toEqual({ problem: expect.stringContaining('must name the rnl array') });
		expect(chirpsCopyConfig({ CHIRPS_SOURCE: 's3' })).toEqual({ problem: expect.stringContaining('CHIRPS_BUCKET') });
		expect(chirpsCopyConfig({ CHIRPS_SOURCE: 'http' })).toEqual({ problem: 'CHIRPS_SOURCE must be local or s3, not http' });
	});
});

describe('ChirpsCopy', () => {
	it('says how to make the local copy when there is none', async () => {
		const c = new ChirpsCopy(chirpsCopyConfig({ CHIRPS_SOURCE: 'local', CHIRPS_LOCAL_DIR: '/nonexistent/pitman-mirror' }));
		await expect(c.open()).rejects.toThrow(CopyUnavailableError);
		await expect(c.open()).rejects.toThrow(/pnpm dev:data:synthetic/);
		await expect(new ChirpsCopy({ problem: 'CHIRPS_BUCKET is missing' }).open()).rejects.toThrow(/not configured: CHIRPS_BUCKET is missing/);
	});

	it('reads IC-WBT’s copy through S3 (a fake client) and keeps it for its TTL, re-reading after', async () => {
		const s3 = fakeS3(FIXTURE_MIRROR_DIR, { bucket: 'water-management-mirror-1' });
		let t = 0;
		const c = new ChirpsCopy(chirpsCopyConfig({ CHIRPS_SOURCE: 's3', CHIRPS_BUCKET: 'water-management-mirror-1' }), { s3, ttlMs: 1000, now: () => t });
		const a = await c.open();
		expect(a).toMatchObject({ kind: 's3', manifest: { revision: 1, finalThrough: '2025-12-31' } });
		const gets = s3.keys.length;
		t = 999;
		expect(await c.open()).toBe(a);
		expect(s3.keys.length).toBe(gets);
		t = 1000;
		expect(await c.open()).not.toBe(a);
		expect(s3.keys.length).toBeGreaterThan(gets);
	});

	it('turns a failing bucket into a 503 message without the upstream text, and doesn’t keep the failure', async () => {
		const s3 = fakeS3(FIXTURE_MIRROR_DIR);
		s3.fail = () => Object.assign(new Error('AccessDenied: arn:aws:iam::123:role/x'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
		const c = new ChirpsCopy(chirpsCopyConfig({ CHIRPS_SOURCE: 's3', CHIRPS_BUCKET: 'b-1' }), { s3 });
		const err = await c.open().catch((e: Error) => e);
		expect(err).toBeInstanceOf(CopyUnavailableError);
		expect((err as Error).message).toBe('the rain data copy is not answering; try again shortly');
		s3.fail = undefined;
		await expect(c.open()).resolves.toMatchObject({ kind: 's3' });
	});

	it('refuses a copy whose manifest is broken or holds no final days, as the copy’s fault (503)', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'pitman-copy-'));
		tmp.push(dir);
		cpSync(FIXTURE_MIRROR_DIR, dir, { recursive: true });
		writeFileSync(join(dir, 'rnl/manifest.json'), '{"product":"rnl"}');
		await expect(new ChirpsCopy(chirpsCopyConfig({ CHIRPS_SOURCE: 'local', CHIRPS_LOCAL_DIR: dir })).open()).rejects.toThrow(CopyUnavailableError);
		rmSync(join(dir, 'rnl/manifest.json'));
		await expect(new ChirpsCopy(chirpsCopyConfig({ CHIRPS_SOURCE: 'local', CHIRPS_LOCAL_DIR: dir })).open()).rejects.toThrow(/holds no CHIRPS rnl finals yet/);
	});
});
