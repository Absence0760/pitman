/**
 * Save a network as a WRSM2000 zip (issue #3 goal 6, rule 7): every file the
 * network was loaded with, unchanged files byte for byte, plus the
 * `pitman.json` sidecar (rule 8) stamped with who wrote it and when.
 * WRSM2000 ignores the sidecar.
 */

import type { NetworkBundle, Sidecar } from '@pitman/wrsm';
import { writeBundle } from './engine.js';
import { packZip } from './zip.js';

export interface SaveOptions {
	/** `Pitman 0.0.1`: recorded as the sidecar's `writtenBy`. */
	readonly writtenBy: string;
	/** Save time (default now): the sidecar's `savedAt` and the zip entries' dates. */
	readonly now?: Date;
}

/** The bundle with its sidecar stamped for saving (a new sidecar when it had none). */
export function stampSidecar(bundle: NetworkBundle, options: SaveOptions): NetworkBundle {
	const now = options.now ?? new Date();
	const sidecar: Sidecar = {
		...(bundle.sidecar ?? { schema: 'pitman-sidecar', schemaVersion: 1 }),
		writtenBy: options.writtenBy,
		savedAt: now.toISOString()
	};
	return { ...bundle, sidecar };
}

/** The file name to save under: the loaded name, else the network code. */
export function saveFileName(bundle: NetworkBundle, loadedName?: string): string {
	const base = (loadedName && loadedName !== 'network' ? loadedName : bundle.network.code).replace(/[\\/:*?"<>|]+/g, '_').trim();
	return `${base || 'network'}.zip`;
}

/** The files a save writes (path → text), sidecar included. */
export function saveFiles(bundle: NetworkBundle, options: SaveOptions): Record<string, string> {
	return writeBundle(stampSidecar(bundle, options));
}

/** The saved zip's bytes. */
export function saveZip(bundle: NetworkBundle, options: SaveOptions): Uint8Array {
	return packZip(saveFiles(bundle, options), { mtime: options.now ?? new Date() });
}
