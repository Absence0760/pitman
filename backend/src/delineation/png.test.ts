// Copied from IC-WBT backend/src/delineation/png.test.ts at f888e4461 (MIT, same author).
import { describe, expect, it } from 'vitest';
import { decodePng, encodePng, PngError } from './png.js';

describe('PNG', () => {
	it('round-trips an RGB image (alpha is dropped as opaque)', () => {
		const argb = new Uint32Array(37 * 11);
		for (let i = 0; i < argb.length; i++) argb[i] = (0xff000000 | ((i * 2654435761) >>> 8)) >>> 0;
		const back = decodePng(new Uint8Array(encodePng({ width: 37, height: 11, argb })));
		expect([back.width, back.height]).toEqual([37, 11]);
		expect(Array.from(back.argb)).toEqual(Array.from(argb));
	});

	it('refuses what is not a PNG', () => {
		expect(() => decodePng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]))).toThrow(PngError);
	});
});
