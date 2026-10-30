// Copied from IC-WBT backend/src/delineation/webp.ts at f888e4461 (MIT, same author).
// A decoder for lossless WebP (VP8L, RFC 9649 § 3), enough to read the
// Terrarium elevation tiles of the delineation DEM (docs/design/delineation.md
// § The DEM). Mapterhorn's tiles are lossless WebP; a lossy one (VP8) is
// refused, since lossy elevations would be wrong by an unknown amount.
//
// No dependency: the format is small and fully specified, and a native image
// library (sharp, libvips) would put a platform binary in the API Lambda.
// Section numbers below are RFC 9649's.

export class WebpError extends Error {}

/**
 * The largest tile side either decoder takes (webp.ts, png.ts): a DEM or
 * water tile is 256 or 512 px, so a bigger one is a corrupt or hostile file,
 * refused before anything is allocated for it (docs/security.md § Map data
 * files). 1024² ARGB is 4 MiB.
 */
export const MAX_TILE_SIDE = 1024;
/** Prefix-code groups one image may keep (libwebp writes a few hundred at most): each costs a few KiB of tables. */
export const MAX_CODE_GROUPS = 4096;

const fail = (why: string): never => {
	throw new WebpError(`not a readable lossless WebP: ${why}`);
};

/** LSB-first bit reader over the VP8L stream (§ 3.3, ReadBits). */
class Bits {
	private pos = 0; // in bits
	private readonly end: number;
	constructor(
		private readonly b: Uint8Array,
		start: number,
		length: number
	) {
		this.pos = start * 8;
		this.end = (start + length) * 8;
	}
	/** The next n ≤ 24 bits, without consuming them (zeros past the end). */
	peek(n: number): number {
		const i = this.pos >>> 3;
		const b = this.b;
		const v = ((b[i] ?? 0) | ((b[i + 1] ?? 0) << 8) | ((b[i + 2] ?? 0) << 16) | ((b[i + 3] ?? 0) << 24)) >>> (this.pos & 7);
		return n === 32 ? v : v & ((1 << n) - 1);
	}
	skip(n: number) {
		this.pos += n;
		if (this.pos > this.end) fail('the stream ends early');
	}
	read(n: number): number {
		if (n === 0) return 0;
		const v = this.peek(n);
		this.skip(n);
		return v;
	}
}

const PEEK = 10;

/** A canonical prefix code (§ 3.7.2.1): a table for codes up to PEEK bits, a slower path for longer ones. */
class Code {
	/** Only one symbol: it takes no bits. */
	private single = -1;
	private table = new Int32Array(0); // (symbol << 4) | length; 0 = longer than PEEK
	private counts = new Int32Array(16);
	private sorted = new Int32Array(0);
	private peekBits = PEEK;

	constructor(lengths: Uint8Array) {
		let nonzero = 0;
		let last = 0;
		for (let s = 0; s < lengths.length; s++) {
			if (lengths[s]) {
				nonzero++;
				last = s;
			}
		}
		if (nonzero === 0) {
			// An empty code (§ 3.7.2.1.1 note): decodes as symbol 0.
			this.single = 0;
			return;
		}
		if (nonzero === 1) {
			this.single = last;
			return;
		}
		const counts = this.counts;
		for (let s = 0; s < lengths.length; s++) counts[lengths[s]!]!++;
		counts[0] = 0;
		// Complete tree check (§ 3.7.2.1: it must be complete).
		let left = 1;
		for (let len = 1; len < 16; len++) {
			left = left * 2 - counts[len]!;
			if (left < 0) fail('an over-subscribed prefix code');
		}
		if (left !== 0) fail('an incomplete prefix code');
		const offs = new Int32Array(16);
		for (let len = 1; len < 15; len++) offs[len + 1] = offs[len]! + counts[len]!;
		const sorted = new Int32Array(nonzero);
		for (let s = 0; s < lengths.length; s++) if (lengths[s]) sorted[offs[lengths[s]!]!++] = s;
		this.sorted = sorted;
		// The table only needs the longest code's bits (up to PEEK): a short code keeps a small table.
		let maxLen = 1;
		for (let len = 1; len < 16; len++) if (counts[len]) maxLen = len;
		this.peekBits = Math.min(PEEK, maxLen);
		this.table = new Int32Array(1 << this.peekBits);
		// Canonical codes, in order of length then symbol; the stream holds each code's bits first-bit-first, so the table is keyed on the reversed code.
		let code = 0;
		let k = 0;
		for (let len = 1; len < 16; len++) {
			for (let c = 0; c < counts[len]!; c++, k++, code++) {
				if (len <= this.peekBits) {
					let r = 0;
					for (let i = 0; i < len; i++) r |= ((code >>> i) & 1) << (len - 1 - i);
					if (len <= this.peekBits) for (let j = r; j < 1 << this.peekBits; j += 1 << len) this.table[j] = (sorted[k]! << 4) | len;
				}
			}
			code <<= 1;
		}
	}

	read(bits: Bits): number {
		if (this.single >= 0) return this.single;
		const e = this.table[bits.peek(this.peekBits)]!;
		if (e !== 0) {
			bits.skip(e & 15);
			return e >>> 4;
		}
		// Longer than PEEK: walk the canonical code a bit at a time.
		let code = 0;
		let first = 0;
		let index = 0;
		for (let len = 1; len < 16; len++) {
			code |= bits.read(1);
			const count = this.counts[len]!;
			if (code - first < count) return this.sorted[index + code - first]!;
			index += count;
			first = (first + count) << 1;
			code <<= 1;
		}
		return fail('a prefix code that matches no symbol');
	}
}

const CODE_LENGTH_ORDER = [17, 18, 0, 1, 2, 3, 4, 5, 16, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

/** One prefix code's lengths (§ 3.7.2.1.1, § 3.7.2.1.2). */
function readCode(bits: Bits, alphabet: number): Code {
	const lengths = new Uint8Array(alphabet);
	if (bits.read(1)) {
		const n = bits.read(1) + 1;
		const s0 = bits.read(bits.read(1) ? 8 : 1);
		if (s0 >= alphabet) fail('a symbol outside its alphabet');
		lengths[s0] = 1;
		if (n === 2) {
			const s1 = bits.read(8);
			if (s1 >= alphabet) fail('a symbol outside its alphabet');
			lengths[s1] = 1;
		}
		return new Code(lengths);
	}
	const clLengths = new Uint8Array(19);
	const n = bits.read(4) + 4;
	for (let i = 0; i < n; i++) clLengths[CODE_LENGTH_ORDER[i]!] = bits.read(3);
	const cl = new Code(clLengths);
	let max = alphabet;
	if (bits.read(1)) {
		const nbits = 2 + 2 * bits.read(3);
		max = 2 + bits.read(nbits);
		if (max > alphabet) fail('more code lengths than symbols');
	}
	let s = 0;
	let prev = 8;
	while (s < alphabet) {
		if (max-- === 0) break;
		const len = cl.read(bits);
		if (len < 16) {
			lengths[s++] = len;
			if (len !== 0) prev = len;
			continue;
		}
		const repeat = len === 16 ? 3 + bits.read(2) : len === 17 ? 3 + bits.read(3) : 11 + bits.read(7);
		if (s + repeat > alphabet) fail('a repeat past the end of the alphabet');
		const v = len === 16 ? prev : 0;
		for (let i = 0; i < repeat; i++) lengths[s++] = v;
	}
	return new Code(lengths);
}

/** Distance codes 1–120 as (dx, dy) (§ 3.6.2.2.1, Figure 20). */
// prettier-ignore
const DISTANCE_MAP = [
	0,1, 1,0, 1,1, -1,1, 0,2, 2,0, 1,2, -1,2, 2,1, -2,1, 2,2, -2,2, 0,3, 3,0, 1,3, -1,3, 3,1, -3,1, 2,3, -2,3, 3,2, -3,2, 0,4, 4,0, 1,4, -1,4,
	4,1, -4,1, 3,3, -3,3, 2,4, -2,4, 4,2, -4,2, 0,5, 3,4, -3,4, 4,3, -4,3, 5,0, 1,5, -1,5, 5,1, -5,1, 2,5, -2,5, 5,2, -5,2, 4,4, -4,4, 3,5, -3,5,
	5,3, -5,3, 0,6, 6,0, 1,6, -1,6, 6,1, -6,1, 2,6, -2,6, 6,2, -6,2, 4,5, -4,5, 5,4, -5,4, 3,6, -3,6, 6,3, -6,3, 0,7, 7,0, 1,7, -1,7, 5,5, -5,5,
	7,1, -7,1, 4,6, -4,6, 6,4, -6,4, 2,7, -2,7, 7,2, -7,2, 3,7, -3,7, 7,3, -7,3, 5,6, -5,6, 6,5, -6,5, 8,0, 4,7, -4,7, 7,4, -7,4, 8,1, 8,2, 6,6,
	-6,6, 8,3, 5,7, -5,7, 7,5, -7,5, 8,4, 6,7, -6,7, 7,6, -7,6, 8,5, 7,7, -7,7, 8,6, 8,7
];
if (DISTANCE_MAP.length !== 240) throw new Error('DISTANCE_MAP must hold 120 pairs');

/** A length or distance from its prefix code and extra bits (§ 3.6.2.2). */
function prefixValue(bits: Bits, prefix: number): number {
	if (prefix < 4) return prefix + 1;
	const extra = (prefix - 2) >> 1;
	const offset = (2 + (prefix & 1)) << extra;
	return offset + bits.read(extra) + 1;
}

const ALPHABET = [256 + 24, 256, 256, 256, 40];

/**
 * An entropy-coded image of w × h ARGB pixels (§ 3.6.2, § 3.7.2.3). Only
 * the main image (`main`) may carry meta prefix codes (§ 3.7.2.2).
 */
function readImage(bits: Bits, w: number, h: number, main: boolean): Uint32Array {
	let cacheBits = 0;
	if (bits.read(1)) {
		cacheBits = bits.read(4);
		if (cacheBits < 1 || cacheBits > 11) fail('a colour cache size outside 1–11 bits');
	}
	let prefixBits = 0;
	let meta: Uint32Array | null = null;
	let metaW = 0;
	let groups = 1;
	const used = new Set<number>();
	if (main && bits.read(1)) {
		prefixBits = bits.read(3) + 2;
		metaW = Math.ceil(w / (1 << prefixBits));
		const img = readImage(bits, metaW, Math.ceil(h / (1 << prefixBits)), false);
		meta = new Uint32Array(img.length);
		for (let i = 0; i < img.length; i++) {
			meta[i] = (img[i]! >>> 8) & 0xffff;
			if (meta[i]! + 1 > groups) groups = meta[i]! + 1;
			used.add(meta[i]!);
		}
		if (used.size > MAX_CODE_GROUPS) fail(`more than ${MAX_CODE_GROUPS} prefix-code groups`);
	}
	const cacheSize = cacheBits ? 1 << cacheBits : 0;
	// Every group's codes are in the stream and must be read, but only the ones the meta image names are kept (a hostile
	// file could otherwise name 65 536 groups and have each kept).
	const codes: Code[][] = [];
	for (let g = 0; g < groups; g++) {
		const group = ALPHABET.map((a, i) => readCode(bits, i === 0 ? a + cacheSize : a));
		if (!meta || used.has(g)) codes[g] = group;
	}

	const out = new Uint32Array(w * h);
	const cache = cacheSize ? new Uint32Array(cacheSize) : null;
	const shift = 32 - cacheBits;
	let group = codes[0]!;
	let pos = 0;
	let cached = 0; // pixels before this one are in the cache
	const total = w * h;
	while (pos < total) {
		// The group of this pixel's block (after a back reference too, which may have crossed blocks).
		if (meta) group = codes[meta[(((pos / w) | 0) >> prefixBits) * metaW + ((pos % w) >> prefixBits)]!]!;
		const s = group[0]!.read(bits);
		if (s < 256) {
			const r = group[1]!.read(bits);
			const b = group[2]!.read(bits);
			const a = group[3]!.read(bits);
			out[pos++] = ((a << 24) | (r << 16) | (s << 8) | b) >>> 0;
		} else if (s < 256 + 24) {
			const length = prefixValue(bits, s - 256);
			const code = prefixValue(bits, group[4]!.read(bits));
			let dist: number;
			if (code > 120) dist = code - 120;
			else {
				dist = DISTANCE_MAP[2 * (code - 1)]! + DISTANCE_MAP[2 * (code - 1) + 1]! * w;
				if (dist < 1) dist = 1;
			}
			if (dist > pos || pos + length > total) fail('a back reference outside the image');
			for (let i = 0; i < length; i++, pos++) out[pos] = out[pos - dist]!;
		} else {
			if (!cache) fail('a colour cache code without a cache');
			// Every pixel so far goes into the cache before a lookup (§ 3.6.2.3).
			while (cached < pos) cache![Math.imul(0x1e35a7bd, out[cached]!) >>> shift] = out[cached++]!;
			out[pos++] = cache![s - 280]!;
		}
		if (cache) while (cached < pos) cache[Math.imul(0x1e35a7bd, out[cached]!) >>> shift] = out[cached++]!;
	}
	return out;
}

type Transform =
	| { type: 0 | 1; bits: number; data: Uint32Array; w: number }
	| { type: 2; w: number }
	| { type: 3; table: Uint32Array; widthBits: number; w: number };

const avg = (a: number, b: number) =>
	((((a >>> 24) + (b >>> 24)) >>> 1) << 24) |
	(((((a >>> 16) & 255) + ((b >>> 16) & 255)) >>> 1) << 16) |
	(((((a >>> 8) & 255) + ((b >>> 8) & 255)) >>> 1) << 8) |
	(((a & 255) + (b & 255)) >>> 1);

const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

function select(l: number, t: number, tl: number): number {
	let pl = 0;
	let pt = 0;
	for (let sh = 0; sh < 32; sh += 8) {
		const cl = (l >>> sh) & 255;
		const ct = (t >>> sh) & 255;
		const p = cl + ct - ((tl >>> sh) & 255);
		pl += Math.abs(p - cl);
		pt += Math.abs(p - ct);
	}
	return pl < pt ? l : t;
}

function clampFull(a: number, b: number, c: number): number {
	let v = 0;
	for (let sh = 0; sh < 32; sh += 8) v |= clamp(((a >>> sh) & 255) + ((b >>> sh) & 255) - ((c >>> sh) & 255)) << sh;
	return v;
}

function clampHalf(a: number, b: number): number {
	let v = 0;
	for (let sh = 0; sh < 32; sh += 8) {
		const ca = (a >>> sh) & 255;
		v |= clamp(ca + Math.trunc((ca - ((b >>> sh) & 255)) / 2)) << sh;
	}
	return v;
}

/** Channel-wise sum mod 256. */
const addPixels = (a: number, b: number) =>
	(((((a >>> 24) + (b >>> 24)) & 255) << 24) |
		((((a >>> 16) + (b >>> 16)) & 255) << 16) |
		((((a >>> 8) + (b >>> 8)) & 255) << 8) |
		((a + b) & 255)) >>>
	0;

function predict(mode: number, l: number, t: number, tr: number, tl: number): number {
	switch (mode) {
		case 0:
			return 0xff000000;
		case 1:
			return l;
		case 2:
			return t;
		case 3:
			return tr;
		case 4:
			return tl;
		case 5:
			return avg(avg(l, tr), t);
		case 6:
			return avg(l, tl);
		case 7:
			return avg(l, t);
		case 8:
			return avg(tl, t);
		case 9:
			return avg(t, tr);
		case 10:
			return avg(avg(l, tl), avg(t, tr));
		case 11:
			return select(l, t, tl);
		case 12:
			return clampFull(l, t, tl);
		case 13:
			return clampHalf(avg(l, t), tl);
		default:
			return fail('a predictor mode above 13');
	}
}

/** Inverse predictor transform, in place (§ 3.5.1). */
function unpredict(px: Uint32Array, w: number, h: number, bits: number, data: Uint32Array) {
	const bw = Math.ceil(w / (1 << bits));
	px[0] = addPixels(px[0]!, 0xff000000);
	for (let x = 1; x < w; x++) px[x] = addPixels(px[x]!, px[x - 1]!);
	for (let y = 1; y < h; y++) {
		const row = y * w;
		px[row] = addPixels(px[row]!, px[row - w]!);
		const brow = (y >> bits) * bw;
		for (let x = 1; x < w; x++) {
			const i = row + x;
			const mode = (data[brow + (x >> bits)]! >>> 8) & 15;
			// TR of the rightmost column is the row's leftmost pixel: index i - w + 1 gives exactly that.
			px[i] = addPixels(px[i]!, predict(mode, px[i - 1]!, px[i - w]!, px[i - w + 1]!, px[i - w - 1]!));
		}
	}
}

const s8 = (v: number) => ((v & 255) << 24) >> 24;
const delta = (t: number, c: number) => (s8(t) * s8(c)) >> 5;

/** Inverse colour transform, in place (§ 3.5.2). */
function uncolor(px: Uint32Array, w: number, h: number, bits: number, data: Uint32Array) {
	const bw = Math.ceil(w / (1 << bits));
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const i = y * w + x;
			const e = data[(y >> bits) * bw + (x >> bits)]!;
			const g2r = e & 255;
			const g2b = (e >>> 8) & 255;
			const r2b = (e >>> 16) & 255;
			const p = px[i]!;
			const g = (p >>> 8) & 255;
			const r = (((p >>> 16) & 255) + delta(g2r, g)) & 255;
			const b = ((p & 255) + delta(g2b, g) + delta(r2b, r)) & 255;
			px[i] = ((p & 0xff00ff00) | (r << 16) | b) >>> 0;
		}
	}
}

export interface Rgba {
	width: number;
	height: number;
	/** ARGB, one 32-bit word per pixel (alpha in the top byte). */
	argb: Uint32Array;
}

/** The VP8L chunk of a WebP file (simple or extended layout, § 2.6, § 2.7). */
function vp8lChunk(buf: Uint8Array): { start: number; length: number } {
	const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	const tag = (o: number) => String.fromCharCode(buf[o]!, buf[o + 1]!, buf[o + 2]!, buf[o + 3]!);
	if (buf.length < 20 || tag(0) !== 'RIFF' || tag(8) !== 'WEBP') fail('no RIFF/WEBP header');
	let o = 12;
	while (o + 8 <= buf.length) {
		const fourcc = tag(o);
		const size = dv.getUint32(o + 4, true);
		if (fourcc === 'VP8L') {
			if (o + 8 + size > buf.length) fail('the VP8L chunk runs past the file');
			return { start: o + 8, length: size };
		}
		if (fourcc === 'VP8 ') fail('lossy (VP8) data, which the delineation DEM must not be');
		o += 8 + size + (size & 1);
	}
	return fail('no VP8L chunk');
}

/** Decode a lossless WebP file. */
export function decodeWebp(buf: Uint8Array): Rgba {
	const { start, length } = vp8lChunk(buf);
	if (buf[start] !== 0x2f) fail('a bad VP8L signature');
	const bits = new Bits(buf, start + 1, length - 1);
	const width = bits.read(14) + 1;
	const height = bits.read(14) + 1;
	// Checked before anything is allocated: a few bytes of a single-symbol code decode any number of pixels.
	if (width > MAX_TILE_SIDE || height > MAX_TILE_SIDE) fail(`an image of ${width} × ${height} px (tiles are at most ${MAX_TILE_SIDE} px a side)`);
	bits.read(1); // alpha_is_used: a hint only
	if (bits.read(3) !== 0) fail('a VP8L version other than 0');
	const transforms: Transform[] = [];
	const seen = new Set<number>();
	let w = width;
	while (bits.read(1)) {
		const type = bits.read(2);
		if (seen.has(type)) fail('a transform used twice');
		seen.add(type);
		if (type === 0 || type === 1) {
			const b = bits.read(3) + 2;
			const data = readImage(bits, Math.ceil(w / (1 << b)), Math.ceil(height / (1 << b)), false);
			transforms.push({ type, bits: b, data, w });
		} else if (type === 2) {
			transforms.push({ type, w });
		} else {
			const size = bits.read(8) + 1;
			const table = readImage(bits, size, 1, false);
			for (let i = 1; i < size; i++) table[i] = addPixels(table[i]!, table[i - 1]!);
			const widthBits = size <= 2 ? 3 : size <= 4 ? 2 : size <= 16 ? 1 : 0;
			transforms.push({ type: 3, table, widthBits, w });
			w = Math.ceil(w / (1 << widthBits));
		}
	}
	let px = readImage(bits, w, height, true);
	for (let t = transforms.length - 1; t >= 0; t--) {
		const tr = transforms[t]!;
		if (tr.type === 0 || tr.type === 1) (tr.type === 0 ? unpredict : uncolor)(px, tr.w, height, tr.bits, tr.data);
		else if (tr.type === 2) {
			for (let i = 0; i < px.length; i++) {
				const p = px[i]!;
				const g = (p >>> 8) & 255;
				px[i] = ((p & 0xff00ff00) | ((((p >>> 16) + g) & 255) << 16) | ((p + g) & 255)) >>> 0;
			}
		} else if (tr.type === 3) {
			// Colour indexing (§ 3.5.4): unbundle the packed indices, then look them up.
			const full = new Uint32Array(tr.w * height);
			const packedW = Math.ceil(tr.w / (1 << tr.widthBits));
			const per = 1 << tr.widthBits;
			const ibits = 8 >> tr.widthBits;
			const imask = (1 << ibits) - 1;
			for (let y = 0; y < height; y++) {
				for (let x = 0; x < tr.w; x++) {
					const g = (px[y * packedW + (x >> tr.widthBits)]! >>> 8) & 255;
					const idx = (g >>> ((x & (per - 1)) * ibits)) & imask;
					full[y * tr.w + x] = idx < tr.table.length ? tr.table[idx]! : 0;
				}
			}
			px = full;
		}
	}
	return { width, height, argb: px };
}
