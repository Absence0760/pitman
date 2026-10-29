import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AnswerFile } from '@pitman/wrsm';
import { fakeEngine } from './fake-engine.js';
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, main } from './main.js';
import { capture, writeSyntheticNetwork } from './testing.test-support.js';

const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** A synthetic network run with the fake engine, plus a reference folder `refName` holding a copy of the run. */
async function ranNetwork(refName = 'Out') {
	const { dir } = await writeSyntheticNetwork();
	dirs.push(dir);
	expect(await main(['run', dir], capture().io, fakeEngine)).toBe(EXIT_OK);
	const out = join(dir, 'Out.pitman');
	const ref = join(dir, refName);
	await mkdir(ref, { recursive: true });
	// Reference names in a different case, as WRSM2000 folders mix them.
	for (const name of await readdir(out)) await cp(join(out, name), join(ref, name.replace('.ANS', '.ans')));
	return { dir, out, ref };
}

/** Scale every month of a reference answer file by `factor`. */
async function scale(path: string, factor: number) {
	const file = JSON.parse(await readFile(path, 'utf8')) as AnswerFile;
	const rows = file.rows.map((r) => ({ ...r, months: r.months.map((v) => v * factor) }));
	await writeFile(path, JSON.stringify({ ...file, rows }));
}

describe('wrsm compare', () => {
	it('pairs files by name ignoring case and prints one row per route', async () => {
		const { dir, out } = await ranNetwork();
		const c = capture();
		expect(await main(['compare', dir, out], c.io, fakeEngine)).toBe(EXIT_OK);
		const lines = c.out.join('').split('\n');
		expect(lines[0]).toMatch(/^route\s+MAR sim\s+MAR ref\s+% diff\s+NSE\s+max \|diff\|\s+first diverging\s+expected$/);
		expect(lines.slice(1, 4).map((l) => l.split(/\s+/)[0])).toEqual(['RQ1', 'RQ2', 'RQ3']);
		for (const row of lines.slice(1, 4)) expect(row).toMatch(/\s0\.00\s+1\.0000\s+0\.000\s+-\s*$/);
		expect(lines[4]).toBe(
			'3 simulated files; 0 reference files without a simulated one; 0 expected to match (|MAR diff| <= 1 %, NSE >= 0.99), 0 failed'
		);
		expect(c.err).toEqual([]);
		expect(c.text()).not.toContain(dir);
	});

	it('exits 1 when an expected route misses the thresholds, 0 when it meets them', async () => {
		const { dir, out, ref } = await ranNetwork();
		await scale(join(ref, 'SYRQ2.ans'), 1.05);
		const expectations = [
			{ network: basename(dir).toUpperCase(), route: 1 },
			{ network: basename(dir), route: 2 },
			{ network: 'another-network', route: 3 }
		];
		const c = capture();
		expect(await main(['compare', dir, out], c.io, fakeEngine, { expectations })).toBe(EXIT_FAILED);
		const text = c.out.join('');
		expect(text).toMatch(/^RQ1 .*\sok\n/m);
		expect(text).toMatch(/^RQ2 .*\s-4\.76\s.*\sHY1990 Oct\s+FAIL\n/m);
		expect(text).toMatch(/^RQ3 .*\s-\n/m);
		expect(text).toContain('2 expected to match (|MAR diff| <= 1 %, NSE >= 0.99), 1 failed');

		const pass = capture();
		expect(await main(['compare', dir, out], pass.io, fakeEngine, { expectations: [expectations[0]!] })).toBe(EXIT_OK);
	});

	it('fails an expected route with no simulated file', async () => {
		const { dir, out } = await ranNetwork();
		const c = capture();
		expect(await main(['compare', dir, out], c.io, fakeEngine, { expectations: [{ network: basename(dir), route: 7 }] })).toBe(
			EXIT_FAILED
		);
		expect(c.out.join('')).toContain('RQ7      no simulated file (FAIL)\n');
	});

	it('reports simulated files without a reference and unreadable files', async () => {
		const { dir, out, ref } = await ranNetwork();
		await rm(join(ref, 'SYRQ3.ans'));
		await writeFile(join(out, 'SYRQ5.ANS'), 'garbage');
		await writeFile(join(ref, 'SYRQ6.ANS'), '{}');
		const c = capture();
		expect(await main(['compare', dir, out], c.io, fakeEngine)).toBe(EXIT_OK);
		const text = c.out.join('');
		expect(text).toContain('RQ3      no reference file\n');
		expect(text).toContain('SYRQ5.ANS SYRQ5.ANS:1:1: not an answer file\n');
		expect(text).toContain('4 simulated files; 1 reference file without a simulated one;');
	});

	it('uses the network folder as the reference when it has no Out folder, or --reference', async () => {
		const { dir, out } = await ranNetwork('.');
		const c = capture();
		expect(await main(['compare', dir, out], c.io, fakeEngine)).toBe(EXIT_OK);
		expect(c.out.join('')).toContain('3 simulated files; 0 reference files');

		const other = join(dir, 'other');
		await mkdir(other);
		const r = capture();
		expect(await main(['compare', dir, out, '--reference', other], r.io, fakeEngine)).toBe(EXIT_OK);
		expect(r.out.join('')).toContain('RQ1      no reference file\n');
	});

	it.each([[[]], [['only-one']], [['a', 'b', 'c']], [['a', 'b', '--nope']], [['/nonexistent/x', '/nonexistent/y']]])(
		'usage error %j exits 2',
		async (args) => {
			const c = capture();
			expect(await main(['compare', ...args], c.io, fakeEngine)).toBe(EXIT_USAGE);
			expect(c.err.join('')).toMatch(/^wrsm compare: /);
		}
	);
});
