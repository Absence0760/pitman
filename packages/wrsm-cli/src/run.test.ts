import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AnswerFile } from '@pitman/wrsm';
import { fakeEngine } from './fake-engine.js';
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, main } from './main.js';
import { capture, writeSyntheticNetwork } from './testing.test-support.js';

const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function network(edit?: Parameters<typeof writeSyntheticNetwork>[0]) {
	const result = await writeSyntheticNetwork(edit);
	dirs.push(result.dir);
	return result;
}

const readAnswer = async (path: string) => JSON.parse(await readFile(path, 'utf8')) as AnswerFile;

describe('wrsm run', () => {
	it('runs each runoff module and writes one .ANS per outflow route into Out.pitman', async () => {
		const { dir, synthetic } = await network();
		const c = capture();
		expect(await main(['run', dir], c.io, fakeEngine)).toBe(EXIT_OK);
		expect((await readdir(join(dir, 'Out.pitman'))).sort()).toEqual(['SYRQ1.ANS', 'SYRQ2.ANS', 'SYRQ3.ANS']);

		const ru1 = synthetic.runoff[0]!;
		const rain = synthetic.rainfall.find((r) => r.fileName.toUpperCase() === ru1.rainfallFile.toUpperCase())!.series;
		const rq1 = await readAnswer(join(dir, 'Out.pitman', 'SYRQ1.ANS'));
		expect(rq1.kind).toBe('RQ');
		expect(rq1.rows.map((r) => r.year)).toEqual([1990, 1991, 1992, 1993]);
		expect(rq1.rows[0]!.months[3]).toBeCloseTo((rain.rows[0]!.months[3] / 100) * ru1.mapMm * ru1.areaKm2 * 1e-4, 12);

		// RU2 takes route 1 as its upstream inflow: ignored, with a warning.
		expect(c.err.join('')).toBe('warning: RU2: upstream inflow on route 1 ignored (network routing is Round 3)\n');
		expect(c.out.join('')).toBe('wrote 3 answer files to Out.pitman\n');
	});

	it('splits a module outflow over its routes by percentage', async () => {
		const { dir } = await network((n) => {
			n.runoff[0] = { ...n.runoff[0]!, outflows: [{ route: 1, percent: 60 }, { route: 9, percent: 40 }] };
			n.network = { ...n.network, routes: [...n.network.routes, { number: 9, upstreamPosition: 1, downstreamPosition: 0, cost: 0 }] };
		});
		expect(await main(['run', dir], capture().io, fakeEngine)).toBe(EXIT_OK);
		const rq1 = await readAnswer(join(dir, 'Out.pitman', 'SYRQ1.ANS'));
		const rq9 = await readAnswer(join(dir, 'Out.pitman', 'SYRQ9.ANS'));
		rq1.rows.forEach((row, i) =>
			row.months.forEach((v, m) => expect(v / 0.6).toBeCloseTo(rq9.rows[i]!.months[m]! / 0.4, 12))
		);
	});

	it('warns about an outflow route the .NET does not start at the module', async () => {
		const { dir } = await network((n) => {
			n.runoff[0] = { ...n.runoff[0]!, outflows: [{ route: 3, percent: 100 }] };
		});
		const c = capture();
		await main(['run', dir], c.io, fakeEngine);
		expect(c.err.join('')).toContain('warning: RU1: outflow route 3 does not start at this module in SY.NET\n');
	});

	it('skips Hughes and Sami modules and modules marked N', async () => {
		const { dir } = await network((n) => {
			n.runoff[0] = { ...n.runoff[0]!, groundwaterModel: 1 };
			n.runoff[2] = { ...n.runoff[2]!, groundwaterModel: 2 };
			n.network = { ...n.network, modules: n.network.modules.map((m) => (m.number === 2 ? { ...m, solve: false } : m)) };
		});
		const c = capture();
		expect(await main(['run', dir], c.io, fakeEngine)).toBe(EXIT_OK);
		expect(c.out.join('')).toBe(
			'info: RU1: Hughes groundwater is not implemented yet (Round 2 runs classic Pitman only), skipped\n' +
				'info: RU2: marked N (not solved) in SY.NET, skipped\n' +
				'info: RU3: Sami groundwater is not implemented yet (Round 2 runs classic Pitman only), skipped\n' +
				'wrote 0 answer files to Out.pitman\n'
		);
	});

	it('accepts other modes with a Round 3 warning and runs historical', async () => {
		const { dir } = await network();
		const c = capture();
		expect(await main(['run', dir, '--mode', 'presentDay', '--year', '2000'], c.io, fakeEngine)).toBe(EXIT_OK);
		expect(c.err[0]).toBe('warning: --mode presentDay is Round 3; running historical (development as the files say)\n');
		const n = capture();
		expect(await main(['run', dir, '--mode', 'natural'], n.io, fakeEngine)).toBe(EXIT_OK);
		expect(n.err[0]).toContain('--mode natural is Round 3');
	});

	it('writes to --out', async () => {
		const { dir } = await network();
		const out = join(dir, 'elsewhere', 'deep');
		const c = capture();
		expect(await main(['run', dir, '--out', out], c.io, fakeEngine)).toBe(EXIT_OK);
		expect(await readdir(out)).toHaveLength(3);
		expect(c.out.at(-1)).toBe(`wrote 3 answer files to ${join('elsewhere', 'deep')}\n`);
	});

	it('fails (exit 1) on a missing rainfall file but still writes the other routes', async () => {
		const { dir } = await network((n) => {
			n.runoff[2] = { ...n.runoff[2]!, rainfallFile: 'NOPE.RAN' };
		});
		const c = capture();
		expect(await main(['run', dir], c.io, fakeEngine)).toBe(EXIT_FAILED);
		expect(c.err.join('')).toContain('error: RU3: rainfall file NOPE.RAN not found\n');
		expect(await readdir(join(dir, 'Out.pitman'))).toHaveLength(2);
	});

	it('fails on a missing module file, a reader error, an engine error', async () => {
		const missing = await network((n) => {
			n.network = { ...n.network, modules: [...n.network.modules, { number: 8, type: 'RU', solve: true }] };
		});
		const c1 = capture();
		expect(await main(['run', missing.dir], c1.io, fakeEngine)).toBe(EXIT_FAILED);
		expect(c1.err.join('')).toContain('error: RU8: module file SYRU8.DAT not found\n');

		const short = await network((n) => {
			n.network = { ...n.network, endYear: n.network.endYear + 1 };
		});
		const c2 = capture();
		expect(await main(['run', short.dir], c2.io, fakeEngine)).toBe(EXIT_FAILED);
		expect(c2.err.join('')).toContain('error: RU1: no rainfall for 1994\n');

		const broken = await network();
		const throwing = { ...fakeEngine, readRunoff: (_: string, f: string) => { throw new Error(`${f}:2:5: expected a number`); } };
		const c3 = capture();
		expect(await main(['run', broken.dir], c3.io, throwing)).toBe(EXIT_FAILED);
		expect(c3.err.join('')).toContain('error: SYRU1.DAT:2:5: expected a number\n');
		expect(c3.err.join('')).toContain('error: syru3.dat:2:5: expected a number\n');
	});

	it('reports engine messages and fails on an error message', async () => {
		const { dir } = await network();
		const engine = {
			...fakeEngine,
			runRunoffModule: (...args: Parameters<typeof fakeEngine.runRunoffModule>) => ({
				...fakeEngine.runRunoffModule(...args),
				messages: [{ level: 'error' as const, module: { type: 'RU' as const, number: args[0].number }, at: { year: 1990, month: 2 }, text: 'negative storage' }]
			})
		};
		const c = capture();
		expect(await main(['run', dir], c.io, engine)).toBe(EXIT_FAILED);
		expect(c.err.join('')).toContain('error: RU1, 1990 month 3: negative storage\n');
	});

	it('fails without exactly one .NET file', async () => {
		const empty = await network();
		await rm(join(empty.dir, 'SY.NET'));
		const c = capture();
		expect(await main(['run', empty.dir], c.io, fakeEngine)).toBe(EXIT_FAILED);
		expect(c.err.join('')).toBe('error: no .NET file in the network folder\n');
	});

	it('picks one of several .NET files with --net', async () => {
		const { dir } = await network();
		await writeFile(join(dir, 'SX.NET'), await readFile(join(dir, 'SY.NET'), 'utf8'));
		const c = capture();
		expect(await main(['run', dir], c.io, fakeEngine)).toBe(EXIT_FAILED);
		expect(c.err.join('')).toContain('choose one with --net <file>');
		const d = capture();
		expect(await main(['run', dir, '--net', 'sy.net'], d.io, fakeEngine)).toBe(EXIT_OK);
		const e = capture();
		expect(await main(['run', dir, '--net', 'NONE.NET'], e.io, fakeEngine)).toBe(EXIT_FAILED);
		expect(e.err.join('')).toContain("no network file 'NONE.NET'");
	});

	it('prints only relative paths', async () => {
		const { dir } = await network();
		await mkdir(join(dir, 'Out.pitman'));
		const c = capture();
		await main(['run', dir, '--mode', 'natural'], c.io, fakeEngine);
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
		expect(await main(['run', ...args], c.io, fakeEngine)).toBe(EXIT_USAGE);
		expect(c.err.join('')).toMatch(/^wrsm run: /);
		expect(c.out).toEqual([]);
	});
});
