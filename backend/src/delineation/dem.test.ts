// Copied from IC-WBT backend/src/delineation/dem.test.ts at f888e4461 (MIT, same author).
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { byteSource, openDem, plainText, terrarium } from './dem.js';
import { FIXTURE_FILE, FIXTURE_X0, FIXTURE_Y0, FIXTURE_ZOOM, fixtureElevation } from './fixture.js';

const FIXTURE = fileURLToPath(FIXTURE_FILE);
const bytes = new Uint8Array(await import('node:fs').then((fs) => fs.readFileSync(FIXTURE)));

describe('terrarium', () => {
	it('decodes R·256 + G + B/256 − 32768', () => {
		expect(terrarium(0xff800000)).toBe(0);
		expect(terrarium(0xff80012c)).toBeCloseTo(1 + 0x2c / 256, 9);
		expect(terrarium(0xff000000)).toBe(-32768);
	});
});

describe('byteSource', () => {
	let server: ReturnType<typeof createServer>;
	let url = '';
	beforeAll(async () => {
		let dropped = 0;
		server = createServer((req, res) => {
			if (req.url === '/missing') return void res.writeHead(404).end();
			// A kept-alive socket the server already closed: the request dies before any answer (undici's "fetch failed").
			if (req.url === '/drops-once' && dropped++ === 0) return void req.socket.destroy();
			if (req.url === '/drops-always') return void req.socket.destroy();
			const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? '');
			if (!m) return void res.writeHead(200).end(Buffer.from(bytes));
			res.writeHead(206).end(Buffer.from(bytes.subarray(Number(m[1]), Number(m[2]) + 1)));
		});
		await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
		url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	});
	afterAll(() => new Promise<void>((r) => server.close(() => r())));

	it('reads the same ranges from a path, a file: URL and HTTP', async () => {
		const want = Array.from(bytes.subarray(100, 140));
		for (const src of [FIXTURE, pathToFileURL(FIXTURE).href, `${url}/dem.pmtiles`]) expect(Array.from(await byteSource(src)(100, 40))).toEqual(want);
		// Past the end: what there is.
		expect((await byteSource(FIXTURE)(bytes.length - 10, 100)).length).toBe(10);
	});

	it('sends a request again when the connection closed before any answer (a stale kept-alive socket)', async () => {
		expect(Array.from(await byteSource(`${url}/drops-once`)(100, 40))).toEqual(Array.from(bytes.subarray(100, 140)));
		// Not forever: a server that never answers is still an error.
		await expect(byteSource(`${url}/drops-always`)(0, 10)).rejects.toThrow(/fetch failed/);
	});

	it('does not send again when the connection was never made (refused)', async () => {
		// A port nothing listens on: bound, then closed, so the connection is refused.
		const probe = createServer();
		await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
		const port = (probe.address() as { port: number }).port;
		await new Promise<void>((r) => probe.close(() => r()));
		const real = globalThis.fetch;
		let calls = 0;
		globalThis.fetch = ((...a: Parameters<typeof fetch>) => (calls++, real(...a))) as typeof fetch;
		try {
			const err = await byteSource(`http://127.0.0.1:${port}/dem.pmtiles`)(0, 10).catch((e: unknown) => e);
			expect(err).toBeInstanceOf(TypeError);
			expect(((err as TypeError).cause as { code?: string }).code).toBe('ECONNREFUSED');
		} finally {
			globalThis.fetch = real;
		}
		expect(calls).toBe(1);
	});

	it('sends a dropped request once more, and no more', async () => {
		const real = globalThis.fetch;
		let calls = 0;
		globalThis.fetch = ((...a: Parameters<typeof fetch>) => (calls++, real(...a))) as typeof fetch;
		try {
			await expect(byteSource(`${url}/drops-always`)(0, 10)).rejects.toThrow(/fetch failed/);
		} finally {
			globalThis.fetch = real;
		}
		expect(calls).toBe(2);
	});

	it('fails on an HTTP error and a missing file', async () => {
		await expect(byteSource(`${url}/missing`)(0, 10)).rejects.toThrow(/HTTP 404/);
		await expect(byteSource('/nonexistent/dem.pmtiles')(0, 10)).rejects.toThrow();
	});

	it('refuses an s3:// URL without a key', () => {
		expect(() => byteSource('s3://bucket-only')).toThrow(/bucket and a key/);
	});
});

describe('openDem', () => {
	it('labels the fixture from its metadata, fingerprints it, and reads its elevations', async () => {
		const dem = openDem(FIXTURE);
		expect(await dem.info()).toMatchObject({ label: expect.stringMatching(/^Synthetic DEM/), tileType: 'png', maxZoom: FIXTURE_ZOOM, fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/) });
		expect((await openDem(FIXTURE, 'My DEM').info()).label).toBe('My DEM');
		const t = (await dem.tile(FIXTURE_ZOOM, FIXTURE_X0, FIXTURE_Y0))!;
		expect(t.size).toBe(256);
		expect(t.z[5 * 256 + 7]).toBeCloseTo(fixtureElevation(7, 5), 2);
		expect(await dem.tile(FIXTURE_ZOOM, 0, 0)).toBeNull();
	});

	it('forgets a failed read, so the next one tries again', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'dem-'));
		const path = join(dir, 'later.pmtiles');
		const dem = openDem(path);
		await expect(dem.info()).rejects.toThrow();
		writeFileSync(path, bytes);
		expect((await dem.info()).tileType).toBe('png');
	});

	it('keeps at most 64 decoded tiles: older ones are read again', async () => {
		const counting = openDem(FIXTURE);
		// Asking the same tile twice reads it once (cached); 65 other asks later it is read again.
		const first = await counting.tile(FIXTURE_ZOOM, FIXTURE_X0, FIXTURE_Y0);
		expect(await counting.tile(FIXTURE_ZOOM, FIXTURE_X0, FIXTURE_Y0)).toBe(first);
		for (let i = 0; i < 65; i++) await counting.tile(FIXTURE_ZOOM, i, 1);
		expect(await counting.tile(FIXTURE_ZOOM, FIXTURE_X0, FIXTURE_Y0)).not.toBe(first);
	});
});

describe('plainText', () => {
	it('keeps the text of an attribution link and drops every angle bracket, whatever the nesting', () => {
		expect(plainText('<a href="https://mapterhorn.com/attribution">© Mapterhorn</a>')).toBe('© Mapterhorn');
		expect(plainText('<scr<script>ipt>alert(1)</script>')).toBe('iptalert(1)');
		expect(plainText('a > b < c')).toBe('a b');
		expect(plainText('plain  text\n here')).toBe('plain text here');
		for (const s of ['<<a>>x<', '<scr<script>ipt>', 'x<y>z>']) expect(plainText(s)).not.toMatch(/[<>]/);
	});
});
