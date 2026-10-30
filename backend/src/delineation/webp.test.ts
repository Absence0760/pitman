// Copied from IC-WBT backend/src/delineation/webp.test.ts at f888e4461 (MIT, same author).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodePng } from './png.js';
import { decodeWebp, WebpError } from './webp.js';

const file = (name: string) => new Uint8Array(readFileSync(new URL(`../../fixtures/dem/webp/${name}`, import.meta.url)));

// Each lossless WebP was made from the PNG beside it with ImageMagick (libwebp), so the two must decode to the same pixels.
// They cover the transforms libwebp picks for each: predictor, colour and subtract-green (terrarium, mixed), colour
// indexing with pixel bundling (palette), alpha and the colour cache (noise), and meta prefix codes (mixed, terrarium).
describe('decodeWebp', () => {
	for (const name of ['terrarium', 'palette', 'noise', 'mixed']) {
		it(`decodes ${name}.webp to the pixels of ${name}.png`, () => {
			const webp = decodeWebp(file(`${name}.webp`));
			const png = decodePng(file(`${name}.png`));
			expect([webp.width, webp.height]).toEqual([png.width, png.height]);
			let differ = 0;
			for (let i = 0; i < png.argb.length; i++) if (webp.argb[i] !== png.argb[i]) differ++;
			expect(differ).toBe(0);
		});
	}

	it('refuses lossy WebP, whose elevations would be off by an unknown amount', () => {
		expect(() => decodeWebp(file('lossy.webp'))).toThrow(/lossy/);
	});

	it('refuses what is not WebP, and a truncated stream', () => {
		expect(() => decodeWebp(file('palette.png'))).toThrow(WebpError);
		const whole = file('terrarium.webp');
		const cut = whole.slice(0, 2000);
		// Keep the chunk size honest so the decoder reads into the missing bytes and notices.
		new DataView(cut.buffer).setUint32(16, cut.length - 20, true);
		expect(() => decodeWebp(cut)).toThrow(WebpError);
	});
});
