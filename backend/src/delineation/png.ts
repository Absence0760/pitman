// Copied from IC-WBT backend/src/delineation/png.ts at f888e4461 (MIT, same author).
// PNG, 8-bit RGB or RGBA, not interlaced: the other tile type a Terrarium DEM
// comes in (PMTiles tile type 2), and the one the committed synthetic DEM
// fixture uses (backend/scripts/dem-fixture.ts writes it with `encodePng`).
// Node's zlib does the compression; nothing else is needed.
import { deflateSync, inflateSync } from 'node:zlib';
import { MAX_TILE_SIDE, type Rgba } from './webp.js';

export class PngError extends Error {}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();

function crc32(bytes: Uint8Array): number {
	let c = 0xffffffff;
	for (const b of bytes) c = CRC_TABLE[(c ^ b) & 255]! ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

const paeth = (a: number, b: number, c: number) => {
	const p = a + b - c;
	const pa = Math.abs(p - a);
	const pb = Math.abs(p - b);
	const pc = Math.abs(p - c);
	return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

export function decodePng(buf: Uint8Array): Rgba {
	const fail = (why: string): never => {
		throw new PngError(`not a readable PNG: ${why}`);
	};
	if (buf.length < 8 || SIGNATURE.some((v, i) => buf[i] !== v)) fail('no PNG signature');
	const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	let o = 8;
	let width = 0;
	let height = 0;
	let channels = 0;
	const idat: Uint8Array[] = [];
	while (o + 8 <= buf.length) {
		const len = dv.getUint32(o);
		const type = String.fromCharCode(buf[o + 4]!, buf[o + 5]!, buf[o + 6]!, buf[o + 7]!);
		const data = buf.subarray(o + 8, o + 8 + len);
		if (data.length !== len) fail('a chunk runs past the file');
		if (type === 'IHDR') {
			width = dv.getUint32(o + 8);
			height = dv.getUint32(o + 12);
			const depth = buf[o + 16];
			const colour = buf[o + 17];
			if (depth !== 8) fail('a bit depth other than 8');
			if (colour !== 2 && colour !== 6) fail('a colour type other than RGB or RGBA');
			if (buf[o + 20] !== 0) fail('interlacing');
			channels = colour === 2 ? 3 : 4;
			if (width > MAX_TILE_SIDE || height > MAX_TILE_SIDE) fail(`an image of ${width} × ${height} px (tiles are at most ${MAX_TILE_SIDE} px a side)`);
		} else if (type === 'IDAT') idat.push(data);
		else if (type === 'IEND') break;
		o += 12 + len;
	}
	if (!width || !height || !channels) fail('no IHDR');
	const stride = width * channels;
	// The image data never inflates past its rows (a filter byte each): a deflate bomb stops there.
	let raw: Buffer;
	try {
		raw = inflateSync(Buffer.concat(idat), { maxOutputLength: height * (stride + 1) });
	} catch (e) {
		return fail((e as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE' ? 'more image data than its size holds' : 'image data that does not inflate');
	}
	if (raw.length < height * (stride + 1)) fail('too little image data');
	const cur = new Uint8Array(stride);
	let prev = new Uint8Array(stride);
	const argb = new Uint32Array(width * height);
	for (let y = 0; y < height; y++) {
		const f = raw[y * (stride + 1)]!;
		const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
		for (let i = 0; i < stride; i++) {
			const a = i >= channels ? cur[i - channels]! : 0;
			const b = prev[i]!;
			const c = i >= channels ? prev[i - channels]! : 0;
			const x = line[i]!;
			cur[i] = (f === 0 ? x : f === 1 ? x + a : f === 2 ? x + b : f === 3 ? x + ((a + b) >> 1) : f === 4 ? x + paeth(a, b, c) : fail('an unknown row filter')) & 255;
		}
		for (let x = 0; x < width; x++) {
			const p = x * channels;
			const alpha = channels === 4 ? cur[p + 3]! : 255;
			argb[y * width + x] = ((alpha << 24) | (cur[p]! << 16) | (cur[p + 1]! << 8) | cur[p + 2]!) >>> 0;
		}
		prev = cur.slice();
	}
	return { width, height, argb };
}

function chunk(type: string, data: Uint8Array): Buffer {
	const head = Buffer.alloc(8);
	head.writeUInt32BE(data.length, 0);
	head.write(type, 4, 'latin1');
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
	return Buffer.concat([head, data, crc]);
}

/** An RGB PNG (alpha dropped), each row Sub-filtered: what the synthetic DEM fixture is written as. */
export function encodePng(img: Rgba): Buffer {
	const { width, height, argb } = img;
	const stride = width * 3;
	const raw = Buffer.alloc(height * (stride + 1));
	for (let y = 0; y < height; y++) {
		const o = y * (stride + 1);
		raw[o] = 1;
		let pr = 0;
		let pg = 0;
		let pb = 0;
		for (let x = 0; x < width; x++) {
			const p = argb[y * width + x]!;
			const r = (p >>> 16) & 255;
			const g = (p >>> 8) & 255;
			const b = p & 255;
			raw[o + 1 + x * 3] = (r - pr) & 255;
			raw[o + 2 + x * 3] = (g - pg) & 255;
			raw[o + 3 + x * 3] = (b - pb) & 255;
			pr = r;
			pg = g;
			pb = b;
		}
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 2;
	return Buffer.concat([Buffer.from(SIGNATURE), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', new Uint8Array(0))]);
}
