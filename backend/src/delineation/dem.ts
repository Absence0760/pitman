// Copied from IC-WBT backend/src/delineation/dem.ts at f888e4461 (MIT, same author).
// The DEM delineation reads (docs/data.md § DEM): a PMTiles archive of Terrarium-encoded elevation tiles,
// WebP (Mapterhorn's build of Copernicus GLO-30) or PNG (the synthetic DEMs), named by a URL:
//
//   /path/or/file:///…   a local file (`pnpm dev:data:synthetic`'s, a cached extract)
//   http(s)://…          ranged GETs
//   s3://bucket/key      ranged S3 GetObject (production; IC-WBT's tiles bucket, in `region`)
//
// Which URL applies is source.ts. The archive's fingerprint, a SHA-256 of its header and root directory,
// says exactly which extract a delineation came from.
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { S3_CONNECTION_TIMEOUT_MS, S3_REQUEST_TIMEOUT_MS } from '../chirps/mirror/store.js';
import { decodePng } from './png.js';
import { PmtilesReader, TILE_TYPES, type ByteSource, type Header } from './pmtiles.js';
import { decodeWebp, type Rgba } from './webp.js';

export class DemError extends Error {}

export interface DemInfo {
	label: string;
	/** The archive's own attribution, tags stripped ('' when it has none). */
	attribution: string;
	/** SHA-256 hex of the archive's first 16 KiB (header + root directory), first 16 characters. */
	fingerprint: string;
	tileType: string;
	maxZoom: number;
	bounds: [number, number, number, number];
}

export interface Dem {
	info(): Promise<DemInfo>;
	/** One tile's elevations (m, row-major) and its size, or null when the archive has none there. */
	tile(z: number, x: number, y: number): Promise<{ size: number; z: Float32Array } | null>;
}

/** Elevation of a Terrarium pixel (m): R·256 + G + B/256 − 32768. */
export const terrarium = (argb: number) => ((argb >>> 16) & 255) * 256 + ((argb >>> 8) & 255) + (argb & 255) / 256 - 32768;

/** The archive's sources (fetched lazily so the API bundle only loads the S3 SDK when it reads S3). */
export function byteSource(url: string, opts: { region?: string } = {}): ByteSource {
	if (url.startsWith('s3://')) {
		const m = /^s3:\/\/([^/]+)\/(.+)$/.exec(url);
		if (!m) throw new DemError('DEM_SOURCE s3://… needs a bucket and a key');
		const [, bucket, key] = m;
		let client: Promise<{ send: (o: number, l: number) => Promise<Uint8Array> }> | undefined;
		return async (offset, length) => {
			client ??= import('@aws-sdk/client-s3').then((sdk) => {
				const s3 = new sdk.S3Client({ region: opts.region, maxAttempts: 3, requestHandler: { connectionTimeout: S3_CONNECTION_TIMEOUT_MS, requestTimeout: S3_REQUEST_TIMEOUT_MS } });
				return {
					send: async (o: number, l: number) => {
						const r = await s3.send(new sdk.GetObjectCommand({ Bucket: bucket, Key: key, Range: `bytes=${o}-${o + l - 1}` }));
						return r.Body ? new Uint8Array(await r.Body.transformToByteArray()) : new Uint8Array(0);
					}
				};
			});
			return (await client).send(offset, length);
		};
	}
	if (/^https?:\/\//.test(url)) {
		return async (offset, length) => {
			// No redirects: DEM_SOURCE names the server, and nothing else is fetched.
			const get = () => fetch(url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` }, redirect: 'error', signal: AbortSignal.timeout(15_000) });
			let res: Response;
			try {
				res = await get();
			} catch (err) {
				// The connection closed before any answer: a kept-alive socket the server had closed while the routing held the event
				// loop (a large window routes for tens of seconds, so the close isn't seen until the next read reuses it). Sent once
				// more on a fresh connection. Only for a socket closed under the request (undici's "other side closed" is
				// UND_ERR_SOCKET, a reset ECONNRESET): a refused connection, a DNS failure, a refused redirect, a timeout
				// (DOMException) or a second failure stands.
				if (!socketClosed(err)) throw err;
				res = await get();
			}
			if (res.status === 416) {
				await res.body?.cancel();
				return new Uint8Array(0);
			}
			// A server that ignores Range would send the whole archive (gigabytes): refused, never buffered.
			if (res.status !== 206) {
				await res.body?.cancel();
				throw new DemError(res.status === 200 ? 'the DEM server ignores Range requests' : `the DEM answered HTTP ${res.status}`);
			}
			return readAtMost(res, length);
		};
	}
	const path = url.startsWith('file:') ? fileURLToPath(url) : url;
	// Opened and closed for each read, so no handle outlives the read: one held for the source's life was closed only by the
	// garbage collector once the source was dropped (a test's archive swapped), which Node 25 makes an error
	// (ERR_INVALID_STATE). An open is microseconds beside a tile's decode, and the decoded tiles are cached (openDem).
	return async (offset, length) => {
		const fh = await open(path, 'r');
		try {
			const b = Buffer.alloc(length);
			const { bytesRead } = await fh.read(b, 0, length, offset);
			return new Uint8Array(b.buffer, b.byteOffset, bytesRead);
		} finally {
			await fh.close();
		}
	};
}

/** fetch's TypeError whose cause is a connection closed under the request (not one never made). */
function socketClosed(err: unknown): boolean {
	if (!(err instanceof TypeError)) return false;
	const code = (err.cause as { code?: unknown } | undefined)?.code;
	return code === 'UND_ERR_SOCKET' || code === 'ECONNRESET';
}

/** A response body, refused once it passes `max` bytes (a ranged answer never should). */
async function readAtMost(res: Response, max: number): Promise<Uint8Array> {
	if (Number(res.headers.get('content-length') ?? 0) > max) {
		await res.body?.cancel();
		throw new DemError('the DEM sent more than the range asked for');
	}
	const out = new Uint8Array(max);
	let n = 0;
	const reader = res.body?.getReader();
	if (!reader) return out.subarray(0, 0);
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (n + value.length > max) {
			await reader.cancel();
			throw new DemError('the DEM sent more than the range asked for');
		}
		out.set(value, n);
		n += value.length;
	}
	return out.subarray(0, n);
}

/**
 * An archive's attribution as plain text: PMTiles metadata often holds an
 * HTML link (`<a href="…">© Mapterhorn</a>`). The text between tags is kept
 * and every angle bracket dropped, by a scan rather than a pattern, so no
 * markup can survive in any order. The app shows it escaped anyway (never as
 * HTML); this only keeps the label readable.
 */
export function plainText(s: string): string {
	let out = '';
	let inTag = false;
	for (const ch of s) {
		if (ch === '<') inTag = true;
		else if (ch === '>') inTag = false;
		else if (!inTag) out += ch;
	}
	return out.replace(/\s+/g, ' ').trim();
}

/** Tile sides a DEM may have: smaller would make a window thousands of tile reads; larger is refused by the decoders (webp.ts MAX_TILE_SIDE). */
export const MIN_TILE_SIDE = 64;

/** A decoded-tile cache across requests in one process (a Lambda container keeps it warm): ~1 MB a 512 px tile. */
const CACHE_TILES = 64;

export function openDem(url: string, label?: string, opts: { region?: string } = {}): Dem {
	const read = byteSource(url, opts);
	const reader = new PmtilesReader(read);
	let infoP: Promise<DemInfo> | undefined;
	const cache = new Map<string, Promise<{ size: number; z: Float32Array } | null>>();
	const decode = (h: Header, bytes: Uint8Array): Rgba => {
		if (h.tileType === 4) return decodeWebp(bytes);
		if (h.tileType === 2) return decodePng(bytes);
		throw new DemError(`the DEM's tiles are ${TILE_TYPES[h.tileType as keyof typeof TILE_TYPES] ?? 'of an unknown type'}; delineation reads Terrarium WebP or PNG`);
	};
	return {
		info() {
			infoP ??= (async () => {
				const h = await reader.getHeader();
				const meta = await reader.getMetadata();
				const head = await read(0, 16384);
				const name = typeof meta.name === 'string' ? meta.name : typeof meta.attribution === 'string' ? plainText(meta.attribution) : 'DEM';
				const version = typeof meta.version === 'string' ? ` ${meta.version}` : '';
				return {
					label: (label?.trim() || `${name}${version}`).slice(0, 200),
					attribution: typeof meta.attribution === 'string' ? plainText(meta.attribution).slice(0, 300) : '',
					fingerprint: createHash('sha256').update(head).digest('hex').slice(0, 16),
					tileType: TILE_TYPES[h.tileType as keyof typeof TILE_TYPES] ?? 'unknown',
					maxZoom: h.maxZoom,
					bounds: h.bounds
				};
			})();
			infoP.catch(() => (infoP = undefined));
			return infoP;
		},
		tile(z, x, y) {
			const key = `${z}/${x}/${y}`;
			let p = cache.get(key);
			if (p) {
				cache.delete(key);
				cache.set(key, p);
				return p;
			}
			p = (async () => {
				const h = await reader.getHeader();
				const bytes = await reader.getTile(z, x, y);
				if (!bytes) return null;
				const img = decode(h, bytes);
				if (img.width !== img.height) throw new DemError(`a DEM tile of ${img.width} × ${img.height} px; tiles must be square`);
				if (img.width < MIN_TILE_SIDE) throw new DemError(`a DEM tile of ${img.width} px; tiles are at least ${MIN_TILE_SIDE} px a side`);
				const out = new Float32Array(img.argb.length);
				for (let i = 0; i < out.length; i++) out[i] = terrarium(img.argb[i]!);
				return { size: img.width, z: out };
			})();
			p.catch(() => cache.delete(key));
			cache.set(key, p);
			while (cache.size > CACHE_TILES) cache.delete(cache.keys().next().value!);
			return p;
		}
	};
}
