/**
 * Bytes ↔ text for a network folder, the encoding `readBundle` expects
 * (packages/wrsm/src/io/bundle.ts, docs/formats.md §1.1):
 *
 * - every file is **Latin-1**: one character per byte, so any byte
 *   (a stray non-ASCII character, a binary `.pdf` kept beside the network)
 *   survives a load and a save unchanged;
 * - except the sidecar `pitman.json`, which is **UTF-8** JSON (a note may
 *   hold any character).
 */

import { SIDECAR_FILE } from './engine.js';

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

/** Whether a path is the UTF-8 sidecar. */
export function isSidecarPath(path: string): boolean {
	return (path.slice(path.lastIndexOf('/') + 1) || path).toLowerCase() === SIDECAR_FILE;
}

/** Decode one file of a network folder. */
export function decodeFile(path: string, bytes: Uint8Array): string {
	return isSidecarPath(path) ? new TextDecoder('utf-8').decode(bytes) : decodeLatin1(bytes);
}

/** Encode one file of a network folder. */
export function encodeFile(path: string, text: string): Uint8Array {
	return isSidecarPath(path) ? new TextEncoder().encode(text) : encodeLatin1(text, path);
}
