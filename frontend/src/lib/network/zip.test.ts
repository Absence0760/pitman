import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { LoadError } from './limits.js';
import { packZip, unpackZip } from './zip.js';

const files = { 'SY/SY.NET': 'SY    1\r\n', 'SY/Out/A.ANS': 'x\xff\r\n', 'SY/pitman.json': '{"n":"→"}\n' };

describe('packZip / unpackZip', () => {
	it('round-trips text files, bytes above 127 and the UTF-8 sidecar', () => {
		expect(unpackZip(packZip(files))).toEqual(files);
	});

	it('is reproducible with a fixed date', () => {
		const mtime = new Date('2025-01-01T00:00:00Z');
		expect(packZip(files, { mtime })).toEqual(packZip(files, { mtime }));
	});

	it('drops directory entries', () => {
		const zip = zipSync({ 'SY/': new Uint8Array(0), 'SY/SY.NET': new TextEncoder().encode('x') });
		expect(Object.keys(unpackZip(zip))).toEqual(['SY/SY.NET']);
	});

	it('rejects something that is not a zip with a LoadError', () => {
		expect(() => unpackZip(new TextEncoder().encode('not a zip'))).toThrow(LoadError);
	});

	it('enforces the limits from the declared sizes', () => {
		const zip = packZip({ 'a.txt': 'x'.repeat(1000), 'b.txt': 'y'.repeat(1000) });
		expect(() => unpackZip(zip, { maxFiles: 1, maxFileBytes: 1e6, maxTotalBytes: 1e6 })).toThrow(/more than 1 files/);
		expect(() => unpackZip(zip, { maxFiles: 10, maxFileBytes: 500, maxTotalBytes: 1e6 })).toThrow(/a\.txt is larger/);
		expect(() => unpackZip(zip, { maxFiles: 10, maxFileBytes: 1e6, maxTotalBytes: 1500 })).toThrow(/add up to more than/);
	});
});
