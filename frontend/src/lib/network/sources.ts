/**
 * Where a network comes from: a zip, a folder picked with
 * `<input webkitdirectory>`, or files and folders dropped on the page. Each
 * becomes a list of `SourceFile`s, then the path → text map `readBundle`
 * takes. Nothing is uploaded: the bytes are read in the browser
 * (issue #3 rule 7).
 */

import type { BundleFiles } from './engine.js';
import { decodeFiles } from './encoding.js';
import { DEFAULT_LIMITS, LimitTracker, LoadError, type LoadLimits } from './limits.js';
import { unpackZip } from './zip.js';

/** One file to load: its relative path and a way to read it. */
export interface SourceFile {
	/** Relative, `/`-separated path (`H00/H00.NET`); a bare name for a single picked file. */
	readonly path: string;
	readonly size: number;
	bytes(): Promise<Uint8Array>;
}

/** The part of a DOM `File` this module uses. */
export interface FileLike {
	readonly name: string;
	readonly size: number;
	/** Set by `<input webkitdirectory>`; `''` otherwise. */
	readonly webkitRelativePath?: string;
	arrayBuffer(): Promise<ArrayBuffer>;
}

/** Files from an `<input type="file">` (with or without `webkitdirectory`). */
export function fromFileList(files: Iterable<FileLike>): SourceFile[] {
	return [...files].map((file) => sourceOf(file.webkitRelativePath || file.name, file));
}

function sourceOf(path: string, file: FileLike): SourceFile {
	return { path: path.replace(/^\/+/, ''), size: file.size, bytes: async () => new Uint8Array(await file.arrayBuffer()) };
}

/** The part of the File and Directory Entries API (`webkitGetAsEntry`) a drop uses. */
export interface DropEntry {
	readonly isFile: boolean;
	readonly isDirectory: boolean;
	readonly name: string;
	/** `/H00/H00.NET` for a dropped folder's file. */
	readonly fullPath: string;
	file?(success: (file: FileLike) => void, failure?: (error: unknown) => void): void;
	createReader?(): { readEntries(success: (entries: DropEntry[]) => void, failure?: (error: unknown) => void): void };
}

/** Every file under the dropped entries, folders walked recursively. */
export async function fromDropEntries(entries: readonly DropEntry[]): Promise<SourceFile[]> {
	const out: SourceFile[] = [];
	const visit = async (entry: DropEntry): Promise<void> => {
		if (entry.isFile && entry.file) {
			const file = await new Promise<FileLike>((resolve, reject) => entry.file?.(resolve, reject));
			out.push(sourceOf(entry.fullPath || entry.name, file));
		} else if (entry.isDirectory && entry.createReader) {
			const reader = entry.createReader();
			// readEntries returns at most a batch (100 in Chrome) per call: read until an empty batch.
			for (;;) {
				const batch = await new Promise<DropEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
				if (batch.length === 0) break;
				for (const child of batch) await visit(child);
			}
		}
	};
	for (const entry of entries) await visit(entry);
	return out;
}

/** A name for what was loaded: the zip's name, or the top folder's. */
export function sourceName(sources: readonly SourceFile[]): string {
	const first = sources[0]?.path ?? '';
	if (sources.length === 1 && /\.zip$/i.test(first)) return baseName(first).replace(/\.zip$/i, '');
	const top = first.includes('/') ? first.slice(0, first.indexOf('/')) : '';
	return top !== '' && sources.every((s) => s.path.startsWith(`${top}/`)) ? top : 'network';
}

function baseName(path: string): string {
	return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * Read the sources into text files: one `.zip` is unpacked; anything else is
 * a folder of loose files. Throws `LoadError` past the size limits.
 */
export async function readSources(sources: readonly SourceFile[], limits: LoadLimits = DEFAULT_LIMITS): Promise<BundleFiles> {
	if (sources.length === 0) throw new LoadError('no files were chosen');
	const only = sources[0] as SourceFile;
	if (sources.length === 1 && /\.zip$/i.test(only.path)) {
		if (only.size > limits.maxTotalBytes) throw new LoadError(`${only.path} is larger than the size limit`);
		return unpackZip(await only.bytes(), limits);
	}
	const tracker = new LimitTracker(limits);
	for (const s of sources) tracker.add(s.path, s.size);
	const raw: Record<string, Uint8Array> = {};
	for (const s of sources) raw[s.path] = await s.bytes();
	return decodeFiles(raw);
}
