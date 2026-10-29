import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXIT_OK, EXIT_USAGE, USAGE, main } from './main.js';

function capture() {
	const out: string[] = [];
	const err: string[] = [];
	return { io: { out: (t: string) => out.push(t), err: (t: string) => err.push(t) }, out, err };
}

describe('wrsm main', () => {
	it.each(['run', 'compare'])('%s is not implemented yet and exits 2', async (command) => {
		const c = capture();
		expect(await main([command, 'some-dir'], c.io)).toBe(EXIT_USAGE);
		expect(c.err.join('')).toBe(`wrsm ${command}: not implemented yet\n`);
		expect(c.out).toEqual([]);
	});

	it('prints usage for help and exits 0', async () => {
		const c = capture();
		expect(await main(['help'], c.io)).toBe(EXIT_OK);
		expect(c.out.join('')).toBe(USAGE);
		expect(USAGE).toContain('presentDay|natural|historical');
	});

	it('prints usage to stderr with no command and exits 2', async () => {
		const c = capture();
		expect(await main([], c.io)).toBe(EXIT_USAGE);
		expect(c.err.join('')).toBe(USAGE);
	});

	it('rejects an unknown command', async () => {
		const c = capture();
		expect(await main(['frobnicate'], c.io)).toBe(EXIT_USAGE);
		expect(c.err.join('')).toContain("unknown command 'frobnicate'");
	});
});

describe('wrsm bin (smoke)', () => {
	const bin = fileURLToPath(new URL('./bin.ts', import.meta.url));
	const runBin = (...args: string[]) =>
		spawnSync(process.execPath, ['--import', 'tsx', bin, ...args], { encoding: 'utf8' });

	it('runs under tsx: run exits 2 with "not implemented yet"', () => {
		const result = runBin('run', 'some-dir');
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(2);
		expect(result.stderr).toContain('not implemented yet');
	});

	it('runs under tsx: help exits 0', () => {
		const result = runBin('help');
		expect(result.status).toBe(0);
		expect(result.stdout).toContain('Usage: wrsm');
	});
});
