import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syntheticNetwork, writeNetwork, writeRainfall, writeRunoff } from '@pitman/wrsm';
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

	it('runs under tsx with the real engine: run writes answer files for a synthetic network', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'wrsm-bin-'));
		const { network, runoff, rainfall } = syntheticNetwork({ seed: 7, code: 'ZZ', startYear: 1990, years: 5 });
		await writeFile(join(dir, 'ZZ.NET'), writeNetwork(network));
		for (const m of runoff) await writeFile(join(dir, `ZZRU${m.number}.DAT`), writeRunoff(m));
		for (const r of rainfall) await writeFile(join(dir, r.fileName), writeRainfall(r.series));
		const result = runBin('run', dir);
		expect(result.error).toBeUndefined();
		expect(result.stderr).not.toContain('not implemented');
		expect(result.status).toBe(0);
		expect((await readdir(join(dir, 'Out.pitman'))).some((f) => /RQ\d+\.ANS$/i.test(f))).toBe(true);
	});

	it('runs under tsx: help exits 0', () => {
		const result = runBin('help');
		expect(result.status).toBe(0);
		expect(result.stdout).toContain('Usage: wrsm');
	});
});
