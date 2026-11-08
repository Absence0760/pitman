// Which CHIRPS copy the API reads (local-first, CLAUDE.md): `CHIRPS_SOURCE=local` (the committed
// backend/.env.development's value) reads a Zarr copy in a local directory, the synthetic one
// `pnpm dev:data:synthetic` writes; `CHIRPS_SOURCE=s3` reads IC-WBT's mirror bucket through the
// cross-account grant (docs/data.md § Cross-account access). Unset or empty is "not configured": every
// CHIRPS request answers a 503 saying so (decision R4-I4: the Lambda's env names the source explicitly).
//
// CHIRPS_PREFIX is the key prefix of the `rnl` array in the bucket (default `rnl`, the grant's
// `rnl/*`): the store is opened at its parent, so the reader asks only for keys under it.
//
// The opened array and its manifest are kept per instance for COPY_TTL_MS, so a cached answer costs no
// GET at all and a new manifest `revision` is seen within that time.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FeedFormatError, FeedUnavailableError } from './errors.js';
import { type FinalsArray, openFinals } from './mirror/arrays.js';
import { type Manifest, readManifest } from './mirror/manifest.js';
import { type MirrorStore, openStore, type S3Sender } from './mirror/store.js';
import { logUnexpected } from '../http/logError.js';

export type CopyKind = 'local' | 's3';

/** The copy can't be read: not there yet, not configured, or not answering. A 503. */
export class CopyUnavailableError extends FeedUnavailableError {}

/** Where the copy is, from the environment. */
export interface CopyConfig {
	kind: CopyKind;
	/** `file:///abs/dir/` or `s3://bucket[/prefix]`. */
	url: string;
	/** The bucket's region (s3 only). */
	region?: string;
	/** For messages: the local directory, or the bucket. */
	where: string;
}

/** The default local copy, relative to the backend's working directory (the dev server runs in `backend/`). */
export const DEFAULT_CHIRPS_LOCAL_DIR = '.local/mirror';
/** IC-WBT's region (docs/decisions.md D-6). */
export const DEFAULT_BUCKET_REGION = 'af-south-1';

type Env = Record<string, string | undefined>;

/** The copy the environment names, or a message saying what is wrong with the setting. */
export function chirpsCopyConfig(env: Env = process.env): CopyConfig | { problem: string } {
	const kind = (env.CHIRPS_SOURCE ?? '').trim();
	if (!kind) return { problem: 'CHIRPS_SOURCE is not set (local, or s3 with CHIRPS_BUCKET)' };
	if (kind === 'local') {
		const dir = resolve(env.CHIRPS_LOCAL_DIR?.trim() || DEFAULT_CHIRPS_LOCAL_DIR);
		return { kind, url: pathToFileURL(`${dir}/`).href, where: dir };
	}
	if (kind === 's3') {
		const bucket = env.CHIRPS_BUCKET?.trim();
		if (!bucket) return { problem: 'CHIRPS_SOURCE=s3 needs CHIRPS_BUCKET (IC-WBT’s mirror bucket)' };
		const prefix = (env.CHIRPS_PREFIX?.trim() || 'rnl').replace(/^\/+|\/+$/g, '');
		const parts = prefix.split('/');
		if (parts.at(-1) !== 'rnl') return { problem: `CHIRPS_PREFIX must name the rnl array (…/rnl), not ${prefix}` };
		const root = parts.slice(0, -1).join('/');
		return { kind, url: `s3://${bucket}${root ? `/${root}` : ''}`, region: env.DATA_REGION?.trim() || DEFAULT_BUCKET_REGION, where: `s3://${bucket}/${prefix}` };
	}
	return { problem: `CHIRPS_SOURCE must be local or s3, not ${kind}` };
}

/** An opened copy: the `rnl` finals array and its manifest. */
export interface OpenedCopy {
	kind: CopyKind;
	finals: FinalsArray;
	manifest: Manifest & { finalThrough: string };
}

/** How long an opened copy is reused before its manifest is read again (ms). */
export const COPY_TTL_MS = 5 * 60_000;

/**
 * The copy, opened lazily and kept for `ttlMs`. A failure isn't kept: the next request tries again.
 */
export class ChirpsCopy {
	readonly config: CopyConfig | { problem: string };
	readonly #ttlMs: number;
	readonly #now: () => number;
	readonly #s3?: S3Sender;
	#store?: MirrorStore;
	#open?: { at: number; promise: Promise<OpenedCopy> };

	constructor(config: CopyConfig | { problem: string }, opts: { ttlMs?: number; now?: () => number; s3?: S3Sender } = {}) {
		this.config = config;
		this.#ttlMs = opts.ttlMs ?? COPY_TTL_MS;
		this.#now = opts.now ?? Date.now;
		this.#s3 = opts.s3;
	}

	get kind(): CopyKind | null {
		return 'problem' in this.config ? null : this.config.kind;
	}

	open(): Promise<OpenedCopy> {
		const t = this.#now();
		if (this.#open && t - this.#open.at < this.#ttlMs) return this.#open.promise;
		const promise = this.#read();
		this.#open = { at: t, promise };
		promise.catch(() => {
			if (this.#open?.promise === promise) this.#open = undefined;
		});
		return promise;
	}

	async #read(): Promise<OpenedCopy> {
		const c = this.config;
		if ('problem' in c) throw new CopyUnavailableError(`the rain data copy is not configured: ${c.problem}`);
		if (c.kind === 'local' && !existsSync(c.where)) {
			throw new CopyUnavailableError(`there is no local CHIRPS copy at ${c.where}: run \`pnpm dev:data:synthetic\` to write the synthetic one, or set CHIRPS_LOCAL_DIR`);
		}
		this.#store ??= openStore(c.url, { s3: this.#s3, region: c.region });
		let manifest: Manifest | null;
		let finals: FinalsArray | null;
		try {
			[manifest, finals] = await Promise.all([readManifest(this.#store, 'rnl'), openFinals(this.#store, 'rnl')]);
		} catch (err) {
			logUnexpected('chirps.copy_open_failed', err);
			// A bad manifest or layout is the copy's fault, not the request's: a 503 either way.
			if (err instanceof FeedFormatError) throw new CopyUnavailableError(err.message);
			throw new CopyUnavailableError('the rain data copy is not answering; try again shortly');
		}
		if (!manifest || !finals) throw new CopyUnavailableError(`the rain data copy at ${c.where} holds no CHIRPS rnl finals yet`);
		if (manifest.finalThrough === null) throw new CopyUnavailableError('the rain data copy holds no final CHIRPS days yet');
		return { kind: c.kind, finals, manifest: manifest as Manifest & { finalThrough: string } };
	}
}
