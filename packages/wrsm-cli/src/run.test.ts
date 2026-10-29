import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { answerFromSeries, readBundle, run, writeAnswer, type RunMode } from '@pitman/wrsm';
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, main } from './main.js';
import { capture, writeSyntheticNetwork } from './testing.test-support.js';
import { wrsmEngine } from './wrsm-engine.js';

const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function network(edit?: Parameters<typeof writeSyntheticNetwork>[0]) {
	const result = await writeSyntheticNetwork(edit);
	dirs.push(result.dir);
	return result;
}

const answerText = (dir: string, name: string) => readFile(join(dir, 'Out.pitman', name), 'latin1');

/** What the engine gives for `mode` on the network as written to disk. */
function expectedRun(files: Record<string, string>, mode: RunMode) {
	const read = readBundle(files);
	if (!read.ok) throw new Error(read.errors.map((e) => e.message).join('; '));
	return run(read.bundle, mode);
}
const ROUTES = [1, 2, 3, 4, 5, 6, 7, 8, 9];

describe('wrsm run', () => {
	it('runs the whole network and writes one .ANS per route and per reservoir into Out.pitman', async () => {
		const { dir, files } = await network();
		const c = capture();
		expect(await main(['run', dir], c.io, wrsmEngine)).toBe(EXIT_OK);
		expect((await readdir(join(dir, 'Out.pitman'))).sort()).toEqual([...ROUTES.map((r) => `SYRQ${r}.ANS`), 'SYRV5.ANS'].sort());
		expect(c.out.at(-1)).toBe('wrote 10 answer files to Out.pitman\n');
		// Irrigation is not simulated until Round 7: the run says so (R3-N6).
		expect(c.err.join('')).toMatch(/warning: RR6: /);

		const expected = expectedRun(files, { kind: 'historical' });
		expect(await answerText(dir, 'SYRQ4.ANS')).toBe(writeAnswer(answerFromSeries('RQ', 4, expected.routeFlows[4]!)));
		expect(await answerText(dir, 'SYRV5.ANS')).toBe(writeAnswer(answerFromSeries('RV', 5, expected.reservoirStorage[5]!)));
	});

	it.each<[string[], RunMode]>([
		[['--mode', 'natural'], { kind: 'natural' }],
		[['--mode', 'presentDay', '--year', '2025'], { kind: 'presentDay', year: 2025 }]
	])('runs the mode it is given (%j)', async (args, mode) => {
		const { dir, files } = await network();
		expect(await main(['run', dir, ...args], capture().io, wrsmEngine)).toBe(EXIT_OK);
		const expected = expectedRun(files, mode);
		expect(await answerText(dir, 'SYRQ5.ANS')).toBe(writeAnswer(answerFromSeries('RQ', 5, expected.routeFlows[5]!)));
	});

	it('writes to --out and never reads its own output folder back in', async () => {
		const { dir } = await network();
		const out = join(dir, 'elsewhere', 'deep');
		const c = capture();
		expect(await main(['run', dir, '--out', out], c.io, wrsmEngine)).toBe(EXIT_OK);
		expect(await readdir(out)).toHaveLength(10);
		expect(c.out.at(-1)).toBe(`wrote 10 answer files to ${join('elsewhere', 'deep')}\n`);
		// A second run with the default folder ignores Out.pitman's .ANS files, then overwrites them.
		expect(await main(['run', dir], capture().io, wrsmEngine)).toBe(EXIT_OK);
		expect(await main(['run', dir], capture().io, wrsmEngine)).toBe(EXIT_OK);
	});

	it('reports every missing file with its location and fails (exit 1)', async () => {
		const { dir } = await network((files) => {
			delete files['SYA.RAN'];
			delete files['SYCR4.DAT'];
		});
		const c = capture();
		expect(await main(['run', dir], c.io, wrsmEngine)).toBe(EXIT_FAILED);
		const err = c.err.join('');
		expect(err).toContain('SYCR4.DAT');
		expect(err).toContain('SYA.RAN');
		await expect(readdir(join(dir, 'Out.pitman'))).rejects.toThrow();
	});

	it('prints the run error messages of a network that cannot run', async () => {
		const { dir } = await network((files) => {
			// Drop the reservoir's capacity table below the run's last year.
			const rv = files['SYRV5.DAT']!.split('\r\n');
			const count = rv.findIndex((l, i) => i > 1 && /^\s*2\s*$/.test(l));
			expect(count).toBeGreaterThan(0);
			files['SYRV5.DAT'] = [...rv.slice(0, count), rv[count]!.replace('2', '1'), ...rv.slice(count + 1).filter((_, j) => ![1, 3, 5].includes(j))].join('\r\n');
		});
		const c = capture();
		const code = await main(['run', dir], c.io, wrsmEngine);
		expect(code).toBe(EXIT_FAILED);
		expect(c.err.join('')).toMatch(/^error: .*RV ?5/m);
	});

	it('picks one of several .NET files with --net', async () => {
		const { dir } = await network();
		await writeFile(join(dir, 'SX.NET'), await readFile(join(dir, 'SY.NET'), 'latin1'), 'latin1');
		const c = capture();
		expect(await main(['run', dir], c.io, wrsmEngine)).toBe(EXIT_FAILED);
		expect(c.err.join('')).toContain('choose one with --net <file>');
		expect(await main(['run', dir, '--net', 'sy.net'], capture().io, wrsmEngine)).toBe(EXIT_OK);
		const e = capture();
		expect(await main(['run', dir, '--net', 'NONE.NET'], e.io, wrsmEngine)).toBe(EXIT_FAILED);
	});

	it('prints only relative paths', async () => {
		const { dir } = await network();
		await mkdir(join(dir, 'Out.pitman'));
		const c = capture();
		await main(['run', dir, '--mode', 'natural'], c.io, wrsmEngine);
		expect(c.text()).not.toContain(dir);
	});

	it.each([
		[[]],
		[['a', 'b']],
		[['d', '--mode', 'future']],
		[['d', '--year', '99']],
		[['d', '--mode', 'presentDay']],
		[['d', '--year', '2000']],
		[['d', '--frobnicate']],
		[['/nonexistent/wrsm-cli-test']]
	])('usage error %j exits 2', async (args) => {
		const c = capture();
		expect(await main(['run', ...args], c.io, wrsmEngine)).toBe(EXIT_USAGE);
		expect(c.err.join('')).toMatch(/^wrsm run: /);
		expect(c.out).toEqual([]);
	});
});
