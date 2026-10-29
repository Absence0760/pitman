// A fake S3 client for the store tests: answers GetObjectCommand from a local directory (the committed
// fixture copy), records every key asked for, and can be told to fail. Never the network.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { S3Sender } from '../chirps/mirror/store.js';

export interface FakeS3 extends S3Sender {
	keys: string[];
	fail?: (key: string) => unknown;
}

/** Serves `s3://bucket/<prefix>/<path>` from `<dir>/<path>`; a missing file answers NoSuchKey. */
export function fakeS3(dir: string, opts: { bucket?: string; prefix?: string } = {}): FakeS3 {
	const prefix = opts.prefix ? `${opts.prefix}/` : '';
	const fake: FakeS3 = {
		keys: [],
		async send(command: unknown) {
			const input = (command as { input: { Bucket: string; Key: string } }).input;
			fake.keys.push(input.Key);
			const failure = fake.fail?.(input.Key);
			if (failure) throw failure;
			if (opts.bucket && input.Bucket !== opts.bucket) throw Object.assign(new Error('wrong bucket'), { name: 'NoSuchBucket', $metadata: { httpStatusCode: 404 } });
			const rel = input.Key.startsWith(prefix) ? input.Key.slice(prefix.length) : null;
			const file = rel === null ? null : join(dir, rel);
			if (!file || !existsSync(file)) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
			const bytes = new Uint8Array(readFileSync(file));
			return { Body: { transformToByteArray: async () => bytes } };
		}
	};
	return fake;
}

/** The committed fixture copy (IC-WBT's synthetic finals 2023–2025, an invented grid). */
export const FIXTURE_MIRROR_DIR = new URL('../../fixtures/mirror/', import.meta.url).pathname;
export const FIXTURE_GEO_DIR = new URL('../../fixtures/geo/', import.meta.url).pathname;
