import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { RUN_MODE_KINDS, type MonthlySeries, type Network, type RunMessage, type RunoffModule } from '@pitman/wrsm';
import type { Engine } from './engine.js';
import { Folder } from './files.js';
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, type Io } from './io.js';

/** The default output folder, inside the network folder, so WRSM2000's own `Out` is never overwritten. */
export const DEFAULT_OUT_DIR = 'Out.pitman';

/** Groundwater model names for the skip message (RU L.022 v1). */
const GW_MODEL_NAMES: Record<number, string> = { 1: 'Hughes', 2: 'Sami' };

/** Format an engine message as one stderr/stdout line. */
export function formatMessage(message: RunMessage): string {
	const where = [
		message.module ? `${message.module.type}${message.module.number}` : '',
		message.route !== undefined ? `route ${message.route}` : '',
		message.at ? `${message.at.year} month ${message.at.month + 1}` : ''
	].filter(Boolean);
	return `${message.level}: ${where.length ? `${where.join(', ')}: ` : ''}${message.text}\n`;
}

/** A Windows path in a file reference reduced to its file name. */
function baseName(reference: string): string {
	return reference.split(/[\\/]/).pop()!.trim();
}

/** The share `percent` of a series. */
function share(series: MonthlySeries, percent: number): MonthlySeries {
	return { ...series, values: series.values.map((v) => (v * percent) / 100) };
}

/**
 * `wrsm run <networkDir> [--mode <kind>] [--year <yyyy>] [--out <dir>]`.
 *
 * Round 2 scope: every classic-groundwater runoff module in the .NET is run
 * on its own over the .NET's years (network routing is Round 3), its outflow
 * split over its outflow routes by percentage, and `<net>RQ<route>.ANS`
 * written for each of those routes. Paths printed are relative to the
 * network folder.
 */
export async function runCommand(argv: readonly string[], io: Io, engine: Engine): Promise<number> {
	let parsed;
	try {
		parsed = parseArgs({
			args: [...argv],
			options: { mode: { type: 'string' }, year: { type: 'string' }, out: { type: 'string' } },
			allowPositionals: true,
			strict: true
		});
	} catch (error) {
		io.err(`wrsm run: ${(error as Error).message}\n`);
		return EXIT_USAGE;
	}
	const { positionals, values } = parsed;
	if (positionals.length !== 1) {
		io.err('wrsm run: expected exactly one <networkDir>\n');
		return EXIT_USAGE;
	}
	const networkDir = positionals[0]!;
	const mode = values.mode ?? 'historical';
	if (!(RUN_MODE_KINDS as readonly string[]).includes(mode)) {
		io.err(`wrsm run: unknown --mode '${mode}' (expected ${RUN_MODE_KINDS.join(', ')})\n`);
		return EXIT_USAGE;
	}
	if (values.year !== undefined && !/^\d{4}$/.test(values.year)) {
		io.err(`wrsm run: --year must be a four-digit year, not '${values.year}'\n`);
		return EXIT_USAGE;
	}
	// Decision D1: only presentDay takes a year.
	if (mode === 'presentDay' && values.year === undefined) {
		io.err('wrsm run: --mode presentDay needs --year <yyyy>\n');
		return EXIT_USAGE;
	}
	if (mode !== 'presentDay' && values.year !== undefined) {
		io.err('wrsm run: --year applies only to --mode presentDay\n');
		return EXIT_USAGE;
	}

	let folder: Folder;
	try {
		folder = await Folder.open(networkDir);
	} catch {
		io.err(`wrsm run: cannot read the network folder '${networkDir}'\n`);
		return EXIT_USAGE;
	}

	if (mode !== 'historical') {
		io.err(`warning: --mode ${mode} is Round 3; running historical (development as the files say)\n`);
	}

	const netFiles = folder.withExtension('.NET');
	if (netFiles.length !== 1) {
		io.err(
			netFiles.length === 0
				? 'error: no .NET file in the network folder\n'
				: `error: more than one .NET file in the network folder (${netFiles.join(', ')})\n`
		);
		return EXIT_FAILED;
	}
	const netFile = netFiles[0]!;
	let network: Network;
	try {
		network = engine.readNetwork(await readFile(join(networkDir, netFile), 'utf8'), netFile);
	} catch (error) {
		io.err(`error: ${(error as Error).message}\n`);
		return EXIT_FAILED;
	}

	const outDir = values.out ?? join(networkDir, DEFAULT_OUT_DIR);
	await mkdir(outDir, { recursive: true });
	const shown = (path: string) => relative(networkDir, path) || '.';

	let failed = false;
	let written = 0;
	const fail = (text: string) => {
		failed = true;
		io.err(`error: ${text}\n`);
	};
	const report = (message: RunMessage) => (message.level === 'info' ? io.out : io.err)(formatMessage(message));

	for (const [index, entry] of network.modules.entries()) {
		if (entry.type !== 'RU') continue;
		const position = index + 1;
		const label = `RU${entry.number}`;
		if (!entry.solve) {
			io.out(`info: ${label}: marked N (not solved) in ${netFile}, skipped\n`);
			continue;
		}
		const wanted = `${network.code}RU${entry.number}.DAT`;
		const moduleFile = folder.file(wanted);
		if (!moduleFile) {
			fail(`${label}: module file ${wanted} not found`);
			continue;
		}

		let module: RunoffModule;
		try {
			module = engine.readRunoff(await readFile(join(networkDir, moduleFile), 'utf8'), moduleFile);
		} catch (error) {
			fail((error as Error).message);
			continue;
		}
		const gwModel = module.groundwaterModel ?? 0;
		if (gwModel !== 0) {
			io.out(`info: ${label}: ${GW_MODEL_NAMES[gwModel]} groundwater is not implemented yet (Round 2 runs classic Pitman only), skipped\n`);
			continue;
		}
		if (module.inflowRoute) {
			io.err(`warning: ${label}: upstream inflow on route ${module.inflowRoute} ignored (network routing is Round 3)\n`);
		}
		if (module.upstreamGroundwaterModule) {
			io.err(`warning: ${label}: groundwater from RU${module.upstreamGroundwaterModule} ignored (network routing is Round 3)\n`);
		}

		const rainfallName = baseName(module.rainfallFile);
		const rainfallFile = folder.file(rainfallName);
		if (!rainfallFile) {
			fail(`${label}: rainfall file ${rainfallName} not found`);
			continue;
		}
		let outflow: MonthlySeries;
		try {
			const rainfall = engine.readRainfall(await readFile(join(networkDir, rainfallFile), 'utf8'), rainfallFile);
			const result = engine.runRunoffModule(module, rainfall, { startYear: network.startYear, endYear: network.endYear });
			result.messages.forEach(report);
			if (result.messages.some((m) => m.level === 'error')) {
				failed = true;
				continue;
			}
			outflow = result.outflow;
		} catch (error) {
			fail(`${label}: ${(error as Error).message}`);
			continue;
		}

		const totalPercent = module.outflows.reduce((sum, o) => sum + o.percent, 0);
		if (Math.abs(totalPercent - 100) > 1e-6) {
			io.err(`warning: ${label}: outflow percentages sum to ${totalPercent}, not 100\n`);
		}
		for (const outflowRoute of module.outflows) {
			const route = network.routes.find((r) => r.number === outflowRoute.route);
			if (!route || route.upstreamPosition !== position) {
				io.err(`warning: ${label}: outflow route ${outflowRoute.route} does not start at this module in ${netFile}\n`);
			}
			const name = `${network.code}RQ${outflowRoute.route}.ANS`;
			const answer = engine.answerFromSeries('RQ', outflowRoute.route, share(outflow, outflowRoute.percent));
			await writeFile(join(outDir, name), engine.writeAnswer(answer));
			written++;
		}
	}

	io.out(`wrote ${written} answer file${written === 1 ? '' : 's'} to ${shown(outDir)}\n`);
	return failed ? EXIT_FAILED : EXIT_OK;
}
