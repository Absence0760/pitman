/**
 * Zip in and out (fflate). A loaded zip becomes the path → text map
 * `readBundle` takes; a saved bundle becomes a zip WRSM2000 users can unpack
 * and open (issue #3 rule 7: the zip is the save file).
 */

import { unzipSync, zipSync, type Zippable } from 'fflate';
import type { BundleFiles } from './engine.js';
import { decodeFile, encodeFile } from './encoding.js';
import { DEFAULT_LIMITS, LimitTracker, LoadError, type LoadLimits } from './limits.js';

/** Unpack a zip into text files (directories dropped). Throws `LoadError` for a bad or oversized zip. */
export function unpackZip(bytes: Uint8Array, limits: LoadLimits = DEFAULT_LIMITS): Record<string, string> {
	const tracker = new LimitTracker(limits);
	let entries: Record<string, Uint8Array>;
	try {
		entries = unzipSync(bytes, {
			filter: (file) => {
				if (file.name.endsWith('/')) return false;
				// The declared size; fflate allocates by it, so checking it first bounds memory.
				tracker.add(file.name, file.originalSize);
				return true;
			}
		});
	} catch (error) {
		if (error instanceof LoadError) throw error;
		throw new LoadError(`not a zip file that can be read (${(error as Error).message})`);
	}
	const out: Record<string, string> = {};
	for (const [name, data] of Object.entries(entries)) {
		if (data.length > limits.maxFileBytes) throw new LoadError(`${name} is larger than its zip entry says`);
		out[name] = decodeFile(name, data);
	}
	return out;
}

export interface PackOptions {
	/** Modification time stamped on every entry (default now). Fixed in tests so a zip is reproducible. */
	readonly mtime?: Date;
}

/** Pack text files into a zip, in path order. */
export function packZip(files: BundleFiles, options: PackOptions = {}): Uint8Array {
	const zippable: Zippable = {};
	for (const path of Object.keys(files).sort()) {
		zippable[path] = [encodeFile(path, files[path] as string), options.mtime ? { mtime: options.mtime } : {}];
	}
	return zipSync(zippable, { level: 6 });
}
