import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { RUN_MODE_KINDS, type MonthlySeries, type RunMessage, type RunMode, type RunResult } from '@pitman/wrsm';
import type { Engine } from './engine.js';
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, type Io } from './io.js';

/** The default output folder, inside the network folder, so WRSM2000's own `Out` is never overwritten. */
export const DEFAULT_OUT_DIR = 'Out.pitman';

/** Format an engine message as one stderr/stdout line. */
export function formatMessage(message: RunMessage): string {
	const where = [
		message.module ? `${message.module.type}${message.module.number}` : '',
		message.route !== undefined ? `route ${message.route}` : '',
		message.at ? `${message.at.year} month ${message.at.month + 1}` : ''
	].filter(Boolean);
	return `${message.level}: ${where.length ? `${where.join(', ')}: ` : ''}${message.text}\n`;
}

/** Every file under `dir`, path (with `/`) → text decoded byte for byte (Latin-1, decision R3-6), skipping `skip` folders. */
async function readFolder(dir: string, skip: ReadonlySet<string>): Promise<Record<string, string>> {
	const files: Record<string, string> = {};
	for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
		if (!entry.isFile()) continue;
		const path = relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/');
		if (skip.has(path.split('/')[0]!.toUpperCase())) continue;
		files[path] = await readFile(join(dir, path), 'latin1');
	}
	return files;
}

/**
 * `wrsm run <networkDir> [--mode <kind>] [--year <yyyy>] [--out <dir>] [--net <file.NET>]`.
 *
 * Reads the whole network folder (`readBundle`), runs it in the chosen mode
 * (`run`: network routing with reservoirs and channel reaches, decision D1
 * modes), and writes `<net>RQ<route>.ANS` for every route and
 * `<net>RV<n>.ANS` for every reservoir's end-of-month storage. Paths
 * printed are relative to the network folder.
 */
export async function runCommand(argv: readonly string[], io: Io, engine: Engine): Promise<number> {
	let parsed;
	try {
		parsed = parseArgs({
			args: [...argv],
			options: { mode: { type: 'string' }, year: { type: 'string' }, out: { type: 'string' }, net: { type: 'string' } },
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

	const outDir = values.out ?? join(networkDir, DEFAULT_OUT_DIR);
	const shown = (path: string) => relative(networkDir, path) || '.';
	let files: Record<string, string>;
	try {
		// Pitman's own output folder is never input (when it sits inside the network folder).
		const own = relative(networkDir, outDir).split(sep)[0]!;
		files = await readFolder(networkDir, new Set(own && !own.startsWith('..') ? [own.toUpperCase()] : []));
	} catch {
		io.err(`wrsm run: cannot read the network folder '${networkDir}'\n`);
		return EXIT_USAGE;
	}

	const read = engine.readBundle(files, values.net === undefined ? {} : { network: values.net });
	for (const issue of [...read.errors, ...read.warnings]) {
		const where = [issue.file, issue.line, issue.column].filter((x) => x !== undefined).join(':');
		io.err(`${issue.level}: ${where}: ${issue.field ? `${issue.field}: ` : ''}${issue.message}\n`);
	}
	if (!read.ok) {
		if (read.networks.length > 1 && values.net === undefined) {
			io.err(`error: more than one .NET file in the network folder (${read.networks.join(', ')}); choose one with --net <file>\n`);
		}
		return EXIT_FAILED;
	}
	const bundle = read.bundle;

	const runMode: RunMode = mode === 'presentDay' ? { kind: 'presentDay', year: Number(values.year) } : { kind: mode as 'natural' | 'historical' };
	let result: RunResult;
	try {
		result = engine.run(bundle, runMode);
	} catch (error) {
		const messages = (error as { messages?: readonly RunMessage[] }).messages;
		if (messages && messages.length > 0) messages.forEach((m) => (m.level === 'info' ? io.out : io.err)(formatMessage(m)));
		else io.err(`error: ${(error as Error).message}\n`);
		return EXIT_FAILED;
	}
	result.messages.forEach((m) => (m.level === 'info' ? io.out : io.err)(formatMessage(m)));

	await mkdir(outDir, { recursive: true });
	const code = bundle.network.code;
	let written = 0;
	const write = async (kind: 'RQ' | 'RV', number: number, series: MonthlySeries) => {
		await writeFile(join(outDir, `${code}${kind}${number}.ANS`), engine.writeAnswer(engine.answerFromSeries(kind, number, series)), 'latin1');
		written++;
	};
	for (const [route, series] of Object.entries(result.routeFlows)) await write('RQ', Number(route), series);
	for (const [reservoir, series] of Object.entries(result.reservoirStorage)) await write('RV', Number(reservoir), series);

	io.out(`wrote ${written} answer file${written === 1 ? '' : 's'} to ${shown(outDir)}\n`);
	return result.messages.some((m) => m.level === 'error') ? EXIT_FAILED : EXIT_OK;
}
