/**
 * Bytes ↔ text for a network folder, the encoding `readBundle` expects
 * (packages/wrsm/src/io/bundle.ts, docs/formats.md §1.1):
 *
 * - every file is **Latin-1**: one character per byte, so any byte
 *   (a stray non-ASCII character, a binary `.pdf` kept beside the network)
 *   survives a load and a save unchanged;
 * - except the sidecar, a `pitman.json` beside a `.NET`, which is **UTF-8**
 *   JSON (a note may hold any character). It is decoded strictly (invalid
 *   UTF-8 is a load error, never silently replaced) and a byte-order mark is
 *   kept, so it saves back unchanged. A `pitman.json` anywhere else is just
 *   a kept file, Latin-1 like the rest.
 */

import { SIDECAR_FILE } from './engine.js';
import { LoadError } from './limits.js';

/** Bytes to text, one character per byte. */
export function decodeLatin1(bytes: Uint8Array): string {
	let out = '';
	// Chunked: String.fromCharCode takes its bytes as arguments.
	for (let i = 0; i < bytes.length; i += 0x8000) {
		out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return out;
}

/** Text to bytes, one byte per character; a character above U+00FF is an error. */
export function encodeLatin1(text: string, path = 'file'): Uint8Array {
	const out = new Uint8Array(text.length);
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		if (c > 0xff) throw new Error(`${path}: character U+${c.toString(16).toUpperCase().padStart(4, '0')} at offset ${i} cannot be saved in a WRSM2000 file`);
		out[i] = c;
	}
	return out;
}

const dirOf = (path: string) => path.slice(0, path.lastIndexOf('/') + 1);
const baseOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/** The paths that are sidecars: `pitman.json` (any case) in a folder that holds a `.NET`. */
export function sidecarPaths(paths: Iterable<string>): Set<string> {
	const list = [...paths];
	const netDirs = new Set(list.filter((p) => /\.NET$/i.test(p) && !baseOf(p).startsWith('._')).map((p) => dirOf(p).toUpperCase()));
	return new Set(list.filter((p) => baseOf(p).toLowerCase() === SIDECAR_FILE && netDirs.has(dirOf(p).toUpperCase())));
}

/** Decode a folder's files: Latin-1, the sidecars strict UTF-8. Throws `LoadError` for a sidecar that isn't UTF-8. */
export function decodeFiles(files: Readonly<Record<string, Uint8Array>>): Record<string, string> {
	const utf8 = sidecarPaths(Object.keys(files));
	const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
	const out: Record<string, string> = {};
	for (const [path, bytes] of Object.entries(files)) {
		if (!utf8.has(path)) {
			out[path] = decodeLatin1(bytes);
			continue;
		}
		try {
			out[path] = decoder.decode(bytes);
		} catch {
			throw new LoadError(`${path} is not UTF-8 text, so it is not a Pitman sidecar; remove or rename it`);
		}
	}
	return out;
}

/** Encode a folder's files, the inverse of `decodeFiles`. */
export function encodeFiles(files: Readonly<Record<string, string>>): Record<string, Uint8Array> {
	const utf8 = sidecarPaths(Object.keys(files));
	const encoder = new TextEncoder();
	const out: Record<string, Uint8Array> = {};
	for (const [path, text] of Object.entries(files)) out[path] = utf8.has(path) ? encoder.encode(text) : encodeLatin1(text, path);
	return out;
}
