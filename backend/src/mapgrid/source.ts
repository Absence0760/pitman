// Where the API's MAP grids come from (local-first, CLAUDE.md). `MAP_GRID_SOURCE=local` (the committed
// backend/.env.development's value) reads a JSON grid file from disk (MAP_GRID_LOCAL_FILE), the
// synthetic one `pnpm dev:data:synthetic` writes; `MAP_GRID_SOURCE=s3://bucket/key` reads that one
// object (IC-WBT's reference bucket, docs/data.md § MAP grids, cross-account row 5), gzipped when its
// key ends `.gz`, in DATA_REGION. Unset or empty is "not configured" (a 503). MAP_GRID_DATASET names the
// grid in answers; by default the file name without `.json[.gz]`.
//
// A grid is read once per instance (a cold start) and kept. The real grids aren't available yet (D6:
// WAAS in the SW Cape pending D-4, CHELSA v2.1 nationally per D-5): each is one more MapGridSource in
// the catalogue, and the mean picks the finest one covering the area (mean.ts), so plugging one in is
// configuration plus, for CHELSA, a converter to this JSON form.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { CopyUnavailableError, DEFAULT_BUCKET_REGION } from '../chirps/copy.js';
import { S3_CONNECTION_TIMEOUT_MS, type S3Sender } from '../chirps/mirror/store.js';
import { type IndexedRainMap, indexRainMap, rainMapFromJson } from './rainMap.js';
import { logUnexpected } from '../http/logError.js';

/** One grid the API can read. */
export interface MapGridSource {
	kind: 'local' | 's3';
	dataset: string;
	/** For messages: the file or the bucket key. */
	where: string;
	/** The grid file's bytes (gzipped or not); undefined when it isn't there. */
	read(): Promise<Uint8Array | undefined>;
}

/** The largest grid file the API reads (bytes, after gunzip): IC-WBT's WAAS clip is ~25 MB of JSON per 1°². */
export const MAX_GRID_BYTES = 256 * 1024 * 1024;
export const DEFAULT_MAP_GRID_LOCAL_FILE = '.local/map-grid/synthetic.json';

type Env = Record<string, string | undefined>;

/** A grid file on disk. */
export function localGridSource(file: string, dataset: string): MapGridSource {
	const where = resolve(file);
	return { kind: 'local', dataset, where, read: async () => (existsSync(where) ? new Uint8Array(readFileSync(where)) : undefined) };
}

/** A grid object in a bucket; `client` is injected in tests. */
export function s3GridSource(bucket: string, key: string, dataset: string, opts: { region?: string; client?: S3Sender } = {}): MapGridSource {
	return {
		kind: 's3',
		dataset,
		where: `s3://${bucket}/${key}`,
		read: async () => {
			const sdk = await import('@aws-sdk/client-s3');
			// One large read at a cold start, so a minute, not the chunk reads' 10 s.
			const s3: S3Sender =
				opts.client ??
				new sdk.S3Client({ region: opts.region, maxAttempts: 3, requestHandler: { connectionTimeout: S3_CONNECTION_TIMEOUT_MS, requestTimeout: 60_000 } });
			try {
				const r = (await s3.send(new sdk.GetObjectCommand({ Bucket: bucket, Key: key }))) as { Body?: { transformToByteArray(): Promise<Uint8Array> } };
				return r.Body ? new Uint8Array(await r.Body.transformToByteArray()) : new Uint8Array(0);
			} catch (err) {
				const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
				if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) return undefined;
				throw err;
			}
		}
	};
}

/** The grid's name from its file name: `waas-swcape-2007.json.gz` → `waas-swcape-2007`. */
const datasetOf = (path: string) => path.split('/').at(-1)!.replace(/\.gz$/, '').replace(/\.json$/, '');

/** The grids the environment names (one for now), or what is wrong with the setting. */
export function mapGridSourcesFromEnv(env: Env = process.env, opts: { s3?: S3Sender } = {}): MapGridSource[] | { problem: string } {
	const source = (env.MAP_GRID_SOURCE ?? '').trim();
	const named = env.MAP_GRID_DATASET?.trim();
	if (!source) return { problem: 'MAP_GRID_SOURCE is not set (local, or s3://bucket/key)' };
	if (source === 'local') {
		const file = env.MAP_GRID_LOCAL_FILE?.trim() || DEFAULT_MAP_GRID_LOCAL_FILE;
		return [localGridSource(file, named || datasetOf(file))];
	}
	const m = /^s3:\/\/([a-z0-9][a-z0-9.-]{1,61}[a-z0-9])\/(.+)$/.exec(source);
	if (m) return [s3GridSource(m[1]!, m[2]!, named || datasetOf(m[2]!), { region: env.DATA_REGION?.trim() || DEFAULT_BUCKET_REGION, client: opts.s3 })];
	return { problem: `MAP_GRID_SOURCE must be local or s3://bucket/key, not ${source.slice(0, 80)}` };
}

/** Parse a grid file's bytes. */
export function parseGridFile(bytes: Uint8Array, dataset: string, gz: boolean): IndexedRainMap {
	const raw = gz ? gunzipSync(bytes, { maxOutputLength: MAX_GRID_BYTES }) : bytes;
	if (raw.byteLength > MAX_GRID_BYTES) throw new RangeError(`the grid file is larger than ${MAX_GRID_BYTES} bytes`);
	const parsed = rainMapFromJson(JSON.parse(new TextDecoder().decode(raw)));
	if (typeof parsed === 'string') throw new RangeError(parsed);
	return indexRainMap(dataset, parsed.grid, parsed.meta);
}

/** The configured grids, each loaded once and kept; a failed load isn't kept, so the next request retries. */
export class MapGridCatalog {
	readonly sources: MapGridSource[] | { problem: string };
	#loads = new Map<MapGridSource, Promise<IndexedRainMap>>();

	constructor(sources: MapGridSource[] | { problem: string }) {
		this.sources = sources;
	}

	async grids(): Promise<{ grid: IndexedRainMap; source: 'local' | 's3' }[]> {
		const s = this.sources;
		if ('problem' in s) throw new CopyUnavailableError(`the MAP grid is not configured: ${s.problem}`);
		return Promise.all(s.map(async (src) => ({ grid: await this.#load(src), source: src.kind })));
	}

	#load(src: MapGridSource): Promise<IndexedRainMap> {
		let p = this.#loads.get(src);
		if (!p) {
			p = (async () => {
				let bytes: Uint8Array | undefined;
				try {
					bytes = await src.read();
				} catch (err) {
					logUnexpected('map_grid.read_failed', err);
					throw new CopyUnavailableError('the MAP grid is not answering; try again shortly');
				}
				if (bytes === undefined) {
					throw new CopyUnavailableError(
						src.kind === 'local'
							? `there is no local MAP grid at ${src.where}: run \`pnpm dev:data:synthetic\` to write the synthetic one, or set MAP_GRID_LOCAL_FILE`
							: `the MAP grid ${src.dataset} is not in its bucket yet`
					);
				}
				try {
					return parseGridFile(bytes, src.dataset, src.where.endsWith('.gz'));
				} catch (err) {
					logUnexpected('map_grid.parse_failed', err);
					throw new CopyUnavailableError(`the MAP grid ${src.dataset} can't be read: ${(err as Error).message}`);
				}
			})();
			this.#loads.set(src, p);
			p.catch(() => this.#loads.delete(src));
		}
		return p;
	}
}
