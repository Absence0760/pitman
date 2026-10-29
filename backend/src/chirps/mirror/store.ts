// Copied from IC-WBT (Absence0760/project-water-management, MIT) backend/src/mirror/store.ts at f888e4461,
// stripped (docs/data.md § Code to copy): S3Store.get only (no set / delete: Pitman never writes to
// IC-WBT), the S3 client given an explicit region (the bucket's, af-south-1, not the Lambda's) and
// request timeouts, and NodeGzip kept whole (the synthetic copy's writer encodes with it).
//
// Where the copy lives: a local directory (`file:///abs/path`) in dev and tests, IC-WBT's private
// bucket (`s3://bucket[/prefix]`) in production. Either way a zarrita store: get(key) → bytes or
// undefined.
//
// The S3 store goes through @aws-sdk/client-s3, imported lazily so a process that never opens an s3://
// copy (local dev, the tests) never loads it.
import { gunzipSync, gzipSync } from 'node:zlib';
import FileSystemStore from '@zarrita/storage/fs';
import type { AbsolutePath, AsyncReadable } from '@zarrita/storage';
import * as zarr from 'zarrita';
import { parseMirrorUrl } from './url.js';

/** A mirror store: what zarrita reads through. */
export type MirrorStore = AsyncReadable;

/** The subset of S3Client the store sends through (an injected client in tests). */
export interface S3Sender {
	send(command: unknown): Promise<unknown>;
}

/** How long one S3 request may take before it fails (ms): a connection, then the whole response. */
export const S3_CONNECTION_TIMEOUT_MS = 3_000;
export const S3_REQUEST_TIMEOUT_MS = 10_000;

/**
 * The bucket as a zarrita store. A missing key (NoSuchKey, 404) is undefined: an unwritten chunk is all
 * fill (NaN), and a missing manifest or zarr.json is a product not in the copy yet. Every other failure
 * throws, a 403 included: S3 answers a missing key with 403 when the reader lacks s3:ListBucket, and
 * reading that as "no rain" would hide a permission error (docs/data.md § Cross-account access).
 */
export class S3Store implements AsyncReadable {
	readonly bucket: string;
	readonly prefix: string;
	#client: Promise<{ s3: S3Sender; sdk: typeof import('@aws-sdk/client-s3') }>;

	constructor(bucket: string, prefix = '', opts: { client?: S3Sender; region?: string } = {}) {
		this.bucket = bucket;
		this.prefix = prefix.replace(/^\/+|\/+$/g, '');
		this.#client = import('@aws-sdk/client-s3').then((sdk) => ({
			s3:
				opts.client ??
				new sdk.S3Client({
					region: opts.region,
					maxAttempts: 3,
					requestHandler: { connectionTimeout: S3_CONNECTION_TIMEOUT_MS, requestTimeout: S3_REQUEST_TIMEOUT_MS }
				}),
			sdk
		}));
	}

	key(path: AbsolutePath): string {
		const rel = path.replace(/^\/+/, '');
		return this.prefix ? `${this.prefix}/${rel}` : rel;
	}

	async get(path: AbsolutePath): Promise<Uint8Array | undefined> {
		const { s3, sdk } = await this.#client;
		try {
			const r = (await s3.send(new sdk.GetObjectCommand({ Bucket: this.bucket, Key: this.key(path) }))) as { Body?: { transformToByteArray(): Promise<Uint8Array> } };
			return r.Body ? new Uint8Array(await r.Body.transformToByteArray()) : new Uint8Array(0);
		} catch (err) {
			const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
			if (e.name === 'NoSuchKey' || e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) return undefined;
			throw err;
		}
	}
}

export { MirrorUrlError } from './url.js';

/** The store a mirror URL names (`file:///abs/path` or `s3://bucket[/prefix]`). */
export function openStore(url: string, opts: { s3?: S3Sender; region?: string } = {}): MirrorStore {
	registerNodeGzip();
	const at = parseMirrorUrl(url);
	return at.kind === 'file' ? new FileSystemStore(at.dir) : new S3Store(at.bucket, at.prefix, { client: opts.s3, region: opts.region });
}

/**
 * gzip over node:zlib. zarrita 0.7.5's own gzip codec only decodes (encode throws UnsupportedError), so
 * the synthetic copy's writer needs this one. It decodes too, synchronously, which is the faster path in
 * Node.
 */
export class NodeGzip {
	readonly kind = 'bytes_to_bytes';
	readonly level: number;
	constructor(level = 6) {
		this.level = level;
	}
	static fromConfig(c?: { level?: number }) {
		return new NodeGzip(c?.level ?? 6);
	}
	encode(bytes: Uint8Array): Uint8Array {
		return new Uint8Array(gzipSync(bytes, { level: this.level }));
	}
	decode(bytes: Uint8Array): Uint8Array {
		return new Uint8Array(gunzipSync(bytes));
	}
}

let registered = false;
/** Register NodeGzip as zarrita's `gzip` codec, once, before any array is opened. */
export function registerNodeGzip(): void {
	if (registered) return;
	zarr.registry.set('gzip', async () => NodeGzip as never);
	registered = true;
}
