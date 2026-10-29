import { describe, expect, it } from 'vitest';
import { decodeFile, decodeLatin1, encodeFile, encodeLatin1, isSidecarPath } from './encoding.js';

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

describe('per-file encoding', () => {
	it('treats pitman.json (any folder, any case) as UTF-8 and everything else as Latin-1', () => {
		expect(isSidecarPath('pitman.json')).toBe(true);
		expect(isSidecarPath('H00/Pitman.JSON')).toBe(true);
		expect(isSidecarPath('H00/H00.NET')).toBe(false);
		const note = '{"note":"≥ 2 % → ok"}';
		expect(decodeFile('pitman.json', encodeFile('pitman.json', note))).toBe(note);
		expect(encodeFile('A.RAN', '\xe9')).toEqual(Uint8Array.of(0xe9));
		expect(decodeFile('A.RAN', Uint8Array.of(0xc3, 0xa9))).toBe('\xc3\xa9');
	});
});
