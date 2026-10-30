// Copied from IC-WBT backend/src/delineation/hostile.test.ts at f888e4461 (MIT, same author).
// Hostile and malformed map data files (round-4 hardening; docs/security.md §
// Map data files): the hand-written readers of the delineation DEM and the
// water occurrence raster (PMTiles, lossless WebP, PNG) must refuse a
// truncated, oversized or corrupt file with their own error, quickly and
// without allocating what the file claims. A seeded generator mutates the
// committed fixtures (truncations, bit flips, random splices), so a failure
// reproduces from its seed.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { deflateSync, gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { byteSource, DemError, MIN_TILE_SIDE, openDem } from './dem.js';
import { FIXTURE_FILE } from './fixture.js';
import { PMTILES_LIMITS, PmtilesError, PmtilesReader, writePmtiles, type ByteSource } from './pmtiles.js';
import { decodePng, encodePng, PngError } from './png.js';
import { decodeWebp, MAX_TILE_SIDE, WebpError } from './webp.js';

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../../fixtures/dem/webp/${name}`, import.meta.url)));
const DEM = new Uint8Array(readFileSync(FIXTURE_FILE));
const memory =
	(b: Uint8Array): ByteSource =>
	async (o, l) =>
		b.subarray(o, o + l);

/** mulberry32: a small seeded generator, so a failing case names its seed. */
function rng(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** One mutation of `b`: cut short, bits flipped, a run of random bytes spliced in, or a 32-bit field set to a huge value. */
function mutate(b: Uint8Array, r: () => number): Uint8Array {
	const out = Uint8Array.from(b);
	switch (Math.floor(r() * 4)) {
		case 0:
			return out.subarray(0, Math.floor(r() * out.length));
		case 1:
			for (let k = 0, n = 1 + Math.floor(r() * 8); k < n; k++) out[Math.floor(r() * out.length)]! ^= 1 << Math.floor(r() * 8);
			return out;
		case 2: {
			const at = Math.floor(r() * out.length);
			for (let k = 0, n = Math.floor(r() * 64); k < n && at + k < out.length; k++) out[at + k] = Math.floor(r() * 256);
			return out;
		}
		default: {
			const at = Math.floor(r() * Math.max(1, out.length - 4));
			new DataView(out.buffer).setUint32(at, r() < 0.5 ? 0xffffffff : 0x7fffffff, r() < 0.5);
			return out;
		}
	}
}

/** Runs `f`; anything thrown must be one of `allowed` (a RangeError or a crash is a bug), and it must finish within `ms`. */
async function settles(f: () => unknown, allowed: readonly (new (...a: never[]) => Error)[], ms: number, label: string) {
	const t = performance.now();
	try {
		await f();
	} catch (e) {
		if (!allowed.some((A) => e instanceof A)) throw new Error(`${label}: threw ${(e as Error)?.constructor?.name}: ${(e as Error)?.message}`);
	}
	expect(performance.now() - t, label).toBeLessThan(ms);
}

describe('decoders against mutated fixtures (seeded)', () => {
	const CASES = 300;
	for (const name of ['terrarium.webp', 'palette.webp', 'noise.webp', 'mixed.webp']) {
		it(`decodeWebp refuses or decodes ${CASES} mutations of ${name}, never anything else`, async () => {
			const base = fixture(name);
			for (let seed = 1; seed <= CASES; seed++) {
				await settles(() => decodeWebp(mutate(base, rng(seed))), [WebpError], 2_000, `${name} seed ${seed}`);
			}
		});
	}

	it(`decodePng refuses or decodes ${CASES} mutations of a PNG tile`, async () => {
		const base = fixture('terrarium.png');
		for (let seed = 1; seed <= CASES; seed++) await settles(() => decodePng(mutate(base, rng(seed))), [PngError], 2_000, `png seed ${seed}`);
	});

	it(`the PMTiles reader refuses or reads ${CASES} mutations of the synthetic DEM`, async () => {
		for (let seed = 1; seed <= CASES; seed++) {
			const r = new PmtilesReader(memory(mutate(DEM, rng(seed))));
			await settles(
				async () => {
					await r.getHeader();
					await r.getMetadata();
					await r.getTile(10, 570, 612);
				},
				[PmtilesError, SyntaxError],
				2_000,
				`pmtiles seed ${seed}`
			);
		}
	});
});

/** A VP8L file of w × h px whose every code is a single symbol: no pixel takes a bit, so a few bytes claim any size. */
function tinyHugeWebp(w: number, h: number): Uint8Array {
	const bits: number[] = [];
	const put = (v: number, n: number) => {
		for (let i = 0; i < n; i++) bits.push((v >>> i) & 1);
	};
	put(w - 1, 14);
	put(h - 1, 14);
	put(0, 1); // alpha hint
	put(0, 3); // version
	put(0, 1); // no transform
	put(0, 1); // no colour cache
	put(0, 1); // no meta codes
	for (let c = 0; c < 5; c++) {
		put(1, 1); // simple code
		put(0, 1); // one symbol
		put(0, 1); // 1-bit symbol
		put(0, 1); // symbol 0
	}
	const body = new Uint8Array(1 + Math.ceil(bits.length / 8));
	body[0] = 0x2f;
	bits.forEach((b, i) => (body[1 + (i >> 3)]! |= b << (i & 7)));
	const file = new Uint8Array(20 + body.length + (body.length & 1));
	const dv = new DataView(file.buffer);
	file.set([82, 73, 70, 70], 0);
	dv.setUint32(4, file.length - 8, true);
	file.set([87, 69, 66, 80, 86, 80, 56, 76], 8);
	dv.setUint32(16, body.length, true);
	file.set(body, 20);
	return file;
}

describe('size bombs', () => {
	it('decodeWebp refuses a 16 384 px tile from a few bytes before allocating it, and still decodes the same trick at tile size', () => {
		const huge = tinyHugeWebp(16384, 16384);
		expect(huge.length).toBeLessThan(40);
		expect(() => decodeWebp(huge)).toThrow(/at most 1024 px/);
		const ok = decodeWebp(tinyHugeWebp(MAX_TILE_SIDE, 8));
		expect([ok.width, ok.height]).toEqual([MAX_TILE_SIDE, 8]);
	});

	it('decodePng refuses a tile larger than 1024 px and a deflate bomb past its rows', () => {
		const big = encodePng({ width: 2048, height: 2, argb: new Uint32Array(4096) });
		expect(() => decodePng(new Uint8Array(big))).toThrow(/at most 1024 px/);
		// A 16 × 16 RGB header with 64 MiB of zeros deflated behind it (about 64 KB).
		const small = Buffer.from(encodePng({ width: 16, height: 16, argb: new Uint32Array(256) }));
		const ihdrEnd = 8 + 25;
		const bomb = deflateSync(Buffer.alloc(64 * 1024 * 1024));
		const chunk = (type: string, data: Buffer) => {
			const head = Buffer.alloc(8);
			head.writeUInt32BE(data.length, 0);
			head.write(type, 4, 'latin1');
			return Buffer.concat([head, data, Buffer.alloc(4)]);
		};
		const file = Buffer.concat([small.subarray(0, ihdrEnd), chunk('IDAT', bomb), chunk('IEND', Buffer.alloc(0))]);
		expect(() => decodePng(new Uint8Array(file))).toThrow(/more image data than its size holds/);
	});

	it('PMTiles: a gzip bomb in the metadata, a directory claiming more entries than bytes, and lengths past the caps are refused', async () => {
		const tiles = [{ z: 10, x: 570, y: 612, data: new Uint8Array([1, 2, 3]) }];
		const archive = writePmtiles(tiles, { tileType: 2, bounds: [20, -34, 21, -33], metadata: { name: 'x' } });
		const h = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
		const rootOffset = Number(h.getBigUint64(8, true));
		const rootLength = Number(h.getBigUint64(16, true));

		// Metadata: 64 MiB of zeros gzipped, appended and pointed at.
		const bomb = gzipSync(Buffer.alloc(64 * 1024 * 1024));
		const withBomb = Buffer.concat([archive, bomb]);
		withBomb.writeBigUInt64LE(BigInt(archive.length), 24);
		withBomb.writeBigUInt64LE(BigInt(bomb.length), 32);
		await expect(new PmtilesReader(memory(withBomb)).getMetadata()).rejects.toThrow(/inflates past/);

		// A root directory whose count says a billion entries.
		const lie = gzipSync(Buffer.from([0x80, 0x94, 0xeb, 0xdc, 0x03, 1, 1, 1, 1]));
		const withLie = Buffer.concat([archive.subarray(0, rootOffset), lie, archive.subarray(rootOffset + rootLength)]);
		withLie.writeBigUInt64LE(BigInt(lie.length), 16);
		for (const o of [24, 40, 56]) withLie.writeBigUInt64LE(withLie.readBigUInt64LE(o) - BigInt(rootLength - lie.length), o);
		await expect(new PmtilesReader(memory(withLie)).getHeader()).rejects.toThrow(/claims \d+ entries/);

		// Lengths past the caps: the root directory, and the metadata.
		const longRoot = Buffer.from(archive);
		longRoot.writeBigUInt64LE(BigInt(PMTILES_LIMITS.directoryBytes + 1), 16);
		await expect(new PmtilesReader(memory(longRoot)).getHeader()).rejects.toThrow(/root directory of/);
		const longMeta = Buffer.from(archive);
		longMeta.writeBigUInt64LE(2n ** 60n, 32);
		await expect(new PmtilesReader(memory(longMeta)).getMetadata()).rejects.toThrow(/metadata of/);
	});

	it('PMTiles: a tile entry longer than the cap is refused before it is read', async () => {
		const big = new Uint8Array(PMTILES_LIMITS.tileBytes + 1);
		const archive = writePmtiles([{ z: 10, x: 570, y: 612, data: big }], { tileType: 2, bounds: [20, -34, 21, -33], metadata: {} });
		let asked = 0;
		const r = new PmtilesReader(async (o, l) => {
			asked = Math.max(asked, l);
			return archive.subarray(o, o + l);
		});
		await expect(r.getTile(10, 570, 612)).rejects.toThrow(/a tile of/);
		expect(asked).toBeLessThan(big.length);
	});

	it(`openDem refuses a tile smaller than ${MIN_TILE_SIDE} px, which would make a window millions of reads`, async () => {
		const tiny = encodePng({ width: 1, height: 1, argb: new Uint32Array([0xff800000]) });
		const archive = writePmtiles([{ z: 10, x: 570, y: 612, data: new Uint8Array(tiny) }], { tileType: 2, bounds: [20, -34, 21, -33], metadata: {} });
		const dir = await import('node:fs/promises').then((fs) => fs.mkdtemp(`${(process.env.TMPDIR ?? '/tmp').replace(/\/$/, '')}/dem-`));
		const path = `${dir}/tiny.pmtiles`;
		await import('node:fs/promises').then((fs) => fs.writeFile(path, archive));
		await expect(openDem(path).tile(10, 570, 612)).rejects.toThrow(DemError);
	});
});

describe('byteSource over HTTP', () => {
	let server: ReturnType<typeof createServer>;
	let url = '';
	beforeAll(async () => {
		server = createServer((req, res) => {
			if (req.url === '/ignores-range') return void res.writeHead(200).end(Buffer.from(DEM));
			if (req.url === '/redirect') return void res.writeHead(302, { location: '/ignores-range' }).end();
			// Answers 206 but sends far more than the range.
			if (req.url === '/oversends') return void res.writeHead(206).end(Buffer.alloc(1024 * 1024));
			res.writeHead(404).end();
		});
		await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
		url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	});
	afterAll(() => new Promise<void>((r) => server.close(() => r())));

	it('refuses a server that ignores Range, a redirect, and a body longer than the range, instead of buffering it', async () => {
		await expect(byteSource(`${url}/ignores-range`)(0, 16)).rejects.toThrow(/ignores Range/);
		await expect(byteSource(`${url}/redirect`)(0, 16)).rejects.toThrow();
		await expect(byteSource(`${url}/oversends`)(0, 16)).rejects.toThrow(/more than the range/);
	});
});
