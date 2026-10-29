import { describe, expect, it } from 'vitest';
import { decodeFiles, decodeLatin1, encodeFiles, encodeLatin1, sidecarPaths } from './encoding.js';
import { LoadError } from './limits.js';

describe('Latin-1: one character per byte', () => {
	it('round-trips every byte value', () => {
		const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
		const text = decodeLatin1(bytes);
		expect(text.length).toBe(256);
		expect(encodeLatin1(text)).toEqual(bytes);
	});

	it('handles files larger than one decode chunk', () => {
		const bytes = Uint8Array.from({ length: 100_000 }, (_, i) => i % 251);
		expect(encodeLatin1(decodeLatin1(bytes))).toEqual(bytes);
	});

	it('refuses a character a byte cannot hold, naming the file', () => {
		expect(() => encodeLatin1('a→b', 'X.DAT')).toThrow(/^X\.DAT: character U\+2192 at offset 1/);
	});
});

describe('decodeFiles / encodeFiles', () => {
	const utf8 = (t: string) => new TextEncoder().encode(t);

	it('treats pitman.json beside a .NET (any case) as UTF-8, everything else as Latin-1', () => {
		const paths = ['H00/H00.NET', 'H00/Pitman.JSON', 'pitman.json', 'H00/Out/pitman.json', '__MACOSX/._X.NET'];
		expect([...sidecarPaths(paths)]).toEqual(['H00/Pitman.JSON']);
		const note = '{"note":"≥ 2 % → ok"}';
		const raw = { 'H00/H00.NET': Uint8Array.of(0x41), 'H00/Pitman.JSON': utf8(note), 'H00/Out/pitman.json': Uint8Array.of(0xc3, 0xa9) };
		const text = decodeFiles(raw);
		expect(text).toEqual({ 'H00/H00.NET': 'A', 'H00/Pitman.JSON': note, 'H00/Out/pitman.json': '\xc3\xa9' });
		expect(encodeFiles(text)).toEqual(raw);
	});

	it('keeps a byte-order mark, so the sidecar saves unchanged', () => {
		const raw = { 'A.NET': Uint8Array.of(0x41), 'pitman.json': Uint8Array.of(0xef, 0xbb, 0xbf, 0x7b, 0x7d) };
		expect(encodeFiles(decodeFiles(raw))).toEqual(raw);
	});

	it('refuses a sidecar that is not UTF-8 instead of replacing bytes', () => {
		expect(() => decodeFiles({ 'A.NET': Uint8Array.of(0x41), 'pitman.json': Uint8Array.of(0x7b, 0xff, 0x7d) })).toThrow(LoadError);
	});
});
