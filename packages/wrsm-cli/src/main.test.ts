import { spawnSync } from 'node:child_process';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXIT_OK, EXIT_USAGE, USAGE, main } from './main.js';
import { writeSyntheticNetwork } from './testing.test-support.js';

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

	it('runs under tsx with the real engine: run writes answer files for a synthetic network', async () => {
		const { dir } = await writeSyntheticNetwork();
		const result = runBin('run', dir);
		expect(result.error).toBeUndefined();
		expect(result.stderr).not.toContain('not implemented');
		expect(result.status).toBe(0);
		expect((await readdir(join(dir, 'Out.pitman'))).some((f) => /RQ\d+\.ANS$/i.test(f))).toBe(true);
		await rm(dir, { recursive: true, force: true });
	});

	it('runs under tsx: help exits 0', () => {
		const result = runBin('help');
		expect(result.status).toBe(0);
		expect(result.stdout).toContain('Usage: wrsm');
	});
});
