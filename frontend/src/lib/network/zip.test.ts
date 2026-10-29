import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { LoadError } from './limits.js';
import { crc32, packZip, unpackZip } from './zip.js';

const files = { 'SY/SY.NET': 'SY    1\r\n', 'SY/Out/A.ANS': 'x\xff\r\n', 'SY/pitman.json': '{"n":"→"}\n' };

describe('packZip / unpackZip', () => {
	it('round-trips text files, bytes above 127 and the UTF-8 sidecar', () => {
		expect(unpackZip(packZip(files))).toEqual(files);
	});

	it('is reproducible with a fixed date', () => {
		const mtime = new Date('2025-01-01T00:00:00Z');
		expect(packZip(files, { mtime })).toEqual(packZip(files, { mtime }));
	});

	it('computes the zip CRC-32', () => {
		expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
	});

	it('drops directory entries', () => {
		const zip = zipSync({ 'SY/': new Uint8Array(0), 'SY/SY.NET': new TextEncoder().encode('x') });
		expect(Object.keys(unpackZip(zip))).toEqual(['SY/SY.NET']);
	});

	it('rejects something that is not a zip with a LoadError', () => {
		expect(() => unpackZip(new TextEncoder().encode('not a zip'))).toThrow(LoadError);
	});

	it('refuses an entry whose data is not the size the zip declares', () => {
		const zip = packZip({ 'a.txt': 'hello world hello world', 'b.txt': 'fine' });
		// Patch a.txt's uncompressed size in the central directory (entry offset 24) down: fflate would cut it short.
		const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
		const cd = view.getUint32(zip.length - 22 + 16, true);
		view.setUint32(cd + 24, 10, true);
		expect(() => unpackZip(zip)).toThrow(/a\.txt in the zip is damaged/);
	});

	it('enforces the limits from the declared sizes', () => {
		const zip = packZip({ 'a.txt': 'x'.repeat(1000), 'b.txt': 'y'.repeat(1000) });
		expect(() => unpackZip(zip, { maxFiles: 1, maxFileBytes: 1e6, maxTotalBytes: 1e6 })).toThrow(/more than 1 files/);
		expect(() => unpackZip(zip, { maxFiles: 10, maxFileBytes: 500, maxTotalBytes: 1e6 })).toThrow(/a\.txt is larger/);
		expect(() => unpackZip(zip, { maxFiles: 10, maxFileBytes: 1e6, maxTotalBytes: 1500 })).toThrow(/add up to more than/);
	});
});
