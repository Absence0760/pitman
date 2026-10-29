/**
 * Zip in and out (fflate). A loaded zip becomes the path → text map
 * `readBundle` takes; a saved bundle becomes a zip WRSM2000 users can unpack
 * and open (issue #3 rule 7: the zip is the save file).
 */

import { unzipSync, zipSync, type Zippable } from 'fflate';
import type { BundleFiles } from './engine.js';
import { decodeFiles, encodeFiles } from './encoding.js';
import { DEFAULT_LIMITS, LimitTracker, LoadError, type LoadLimits } from './limits.js';

/** Unpack a zip into text files (directories dropped). Throws `LoadError` for a bad, damaged or oversized zip. */
export function unpackZip(bytes: Uint8Array, limits: LoadLimits = DEFAULT_LIMITS): Record<string, string> {
	const tracker = new LimitTracker(limits);
	const declared = new Map<string, number>();
	let entries: Record<string, Uint8Array>;
	try {
		entries = unzipSync(bytes, {
			filter: (file) => {
				if (file.name.endsWith('/')) return false;
				// The declared size; fflate allocates by it, so checking it first bounds memory.
				tracker.add(file.name, file.originalSize);
				declared.set(file.name, file.originalSize);
				return true;
			}
		});
	} catch (error) {
		if (error instanceof LoadError) throw error;
		throw new LoadError(`not a zip file that can be read (${(error as Error).message})`);
	}
	// fflate sizes each entry by its declared size and doesn't check the CRC,
	// so a damaged entry would arrive cut short or wrong without an error.
	const crcs = centralDirectoryCrcs(bytes);
	for (const [name, data] of Object.entries(entries)) {
		const expected = crcs.get(name);
		if (data.length !== declared.get(name) || (expected !== undefined && crc32(data) !== expected)) {
			throw new LoadError(`${name} in the zip is damaged (its contents do not match the zip's checksum)`);
		}
	}
	return decodeFiles(entries);
}

export interface PackOptions {
	/** Modification time stamped on every entry (default now). Fixed in tests so a zip is reproducible. */
	readonly mtime?: Date;
}

/** Pack text files into a zip, in path order. */
export function packZip(files: BundleFiles, options: PackOptions = {}): Uint8Array {
	const zippable: Zippable = {};
	const bytes = encodeFiles(files);
	for (const path of Object.keys(bytes).sort()) {
		zippable[path] = [bytes[path] as Uint8Array, options.mtime ? { mtime: options.mtime } : {}];
	}
	return zipSync(zippable, { level: 6 });
}

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

/** CRC-32 (the zip checksum, PKZIP APPNOTE 4.4.7). */
export function crc32(bytes: Uint8Array): number {
	let c = 0xffffffff;
	for (let i = 0; i < bytes.length; i++) c = (CRC_TABLE[(c ^ (bytes[i] as number)) & 0xff] as number) ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

/** Each entry's CRC-32 from the zip's central directory (APPNOTE 4.3.12, 4.3.16), by name as fflate names it. */
function centralDirectoryCrcs(zip: Uint8Array): Map<string, number> {
	const out = new Map<string, number>();
	const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
	let end = zip.length - 22;
	while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
	if (end < 0) return out;
	const count = view.getUint16(end + 10, true);
	let at = view.getUint32(end + 16, true);
	for (let k = 0; k < count && at + 46 <= zip.length && view.getUint32(at, true) === 0x02014b50; k++) {
		const flags = view.getUint16(at + 8, true);
		const nameLength = view.getUint16(at + 28, true);
		const rawName = zip.subarray(at + 46, at + 46 + nameLength);
		const name = flags & 0x800 ? new TextDecoder().decode(rawName) : String.fromCharCode(...rawName);
		out.set(name, view.getUint32(at + 16, true));
		at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
	}
	return out;
}
