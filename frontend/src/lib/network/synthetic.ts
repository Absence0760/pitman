/**
 * A synthetic network as files and as a zip, for tests (unit tests here and
 * the end-to-end test: load → run each mode → save → reload). Invented
 * values only (issue #3 rule 2).
 */

import { syntheticBundle as engineSyntheticBundle, type NetworkBundle, type SyntheticOptions } from '@pitman/wrsm';
import { writeBundle } from './engine.js';
import { packZip } from './zip.js';

/**
 * The engine's synthetic network bundle (`packages/wrsm/src/network/synthetic-bundle.ts`):
 * three runoff modules, an irrigation module, a reservoir, a channel reach, a
 * gauge with observed flow, and defined-flow files.
 */
export function syntheticBundle(options: SyntheticOptions = {}): NetworkBundle {
	return engineSyntheticBundle(options);
}

export interface SyntheticFilesOptions extends SyntheticOptions {
	/** Folder to put the files in (`SY/`), default none. */
	readonly folder?: string;
}

/** The synthetic network's files, path → text. */
export function syntheticNetworkFiles(options: SyntheticFilesOptions = {}): Record<string, string> {
	const files = writeBundle(syntheticBundle(options));
	const prefix = options.folder ? `${options.folder.replace(/\/+$/, '')}/` : '';
	return Object.fromEntries(Object.entries(files).map(([p, t]) => [prefix + p, t]));
}

/** The synthetic network as a zip (entry dates fixed, so the bytes are reproducible). */
export function syntheticNetworkZip(options: SyntheticFilesOptions = {}): Uint8Array {
	return packZip(syntheticNetworkFiles(options), { mtime: new Date('2025-01-01T00:00:00Z') });
}
