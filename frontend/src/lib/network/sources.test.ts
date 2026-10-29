import { describe, expect, it } from 'vitest';
import { LoadError } from './limits.js';
import { fromDropEntries, fromFileList, readSources, sourceName, type DropEntry, type FileLike } from './sources.js';
import { packZip } from './zip.js';

const latin1 = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));

function file(name: string, text: string, webkitRelativePath = ''): FileLike {
	const bytes = latin1(text);
	return { name, size: bytes.length, webkitRelativePath, arrayBuffer: async () => bytes.slice().buffer };
}

/** A fake dropped folder: readEntries hands out `batch` entries per call, as browsers do. */
function folder(fullPath: string, children: DropEntry[], batch = 2): DropEntry {
	return {
		isFile: false,
		isDirectory: true,
		name: fullPath.slice(fullPath.lastIndexOf('/') + 1),
		fullPath,
		createReader() {
			let at = 0;
			return {
				readEntries(success) {
					success(children.slice(at, at + batch));
					at += batch;
				}
			};
		}
	};
}

function dropped(fullPath: string, text: string): DropEntry {
	const name = fullPath.slice(fullPath.lastIndexOf('/') + 1);
	return { isFile: true, isDirectory: false, name, fullPath, file: (success) => success(file(name, text)) };
}

describe('fromFileList', () => {
	it('uses the folder-relative path from <input webkitdirectory>, else the name', () => {
		const sources = fromFileList([file('A.NET', 'x', 'Net/A.NET'), file('B.zip', 'y')]);
		expect(sources.map((s) => s.path)).toEqual(['Net/A.NET', 'B.zip']);
	});
});

describe('fromDropEntries', () => {
	it('walks dropped folders, reading every batch of entries', async () => {
		const entries = [folder('/Net', [dropped('/Net/A.NET', 'a'), dropped('/Net/B.DAT', 'b'), folder('/Net/Out', [dropped('/Net/Out/C.ANS', 'c')])]), dropped('/x.txt', 'x')];
		const sources = await fromDropEntries(entries);
		expect(sources.map((s) => s.path)).toEqual(['Net/A.NET', 'Net/B.DAT', 'Net/Out/C.ANS', 'x.txt']);
		expect(await sources[1]?.bytes()).toEqual(latin1('b'));
	});
});

describe('sourceName', () => {
	it('names a zip by its file name and a folder by its top folder', () => {
		expect(sourceName(fromFileList([file('H00 network.zip', '')]))).toBe('H00 network');
		expect(sourceName(fromFileList([file('A.NET', '', 'H00/A.NET'), file('B', '', 'H00/B')]))).toBe('H00');
		expect(sourceName(fromFileList([file('A.NET', '')]))).toBe('network');
	});
});

describe('readSources', () => {
	it('unpacks a single zip', async () => {
		const zip = packZip({ 'Net/A.NET': 'a\r\n' });
		const source = { path: 'n.zip', size: zip.length, bytes: async () => zip };
		expect(await readSources([source])).toEqual({ 'Net/A.NET': 'a\r\n' });
	});

	it('reads loose files byte for byte (Latin-1), the sidecar as UTF-8', async () => {
		const sidecar = new TextEncoder().encode('{"n":"→"}');
		const sources = [...fromFileList([file('A.RAN', 'x\xe9', 'Net/A.RAN')]), { path: 'Net/pitman.json', size: sidecar.length, bytes: async () => sidecar }];
		expect(await readSources(sources)).toEqual({ 'Net/A.RAN': 'x\xe9', 'Net/pitman.json': '{"n":"→"}' });
	});

	it('refuses nothing, and too much, with a LoadError', async () => {
		await expect(readSources([])).rejects.toThrow(LoadError);
		const big = fromFileList([file('a', 'x'.repeat(100)), file('b', 'y'.repeat(100))]);
		await expect(readSources(big, { maxFiles: 10, maxFileBytes: 1000, maxTotalBytes: 150 })).rejects.toThrow(/add up to more than/);
	});
});
