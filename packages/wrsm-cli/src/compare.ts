import { readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
	EXPECTED_TO_MATCH,
	MAR_PCT_DIFF_MAX,
	NSE_MIN,
	compareAnswers,
	meetsThresholds,
	type ExpectedRoute,
	type SeriesComparison,
	type AnswerFile,
	type YearMonth
} from '@pitman/wrsm';
import type { Engine } from './engine.js';
import { Folder } from './files.js';
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, type Io } from './io.js';

const MONTHS = ['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'];

/** One compared pair (or a file that could not be compared). */
interface Row {
	/** e.g. `RQ12`; the file name when the file could not be read. */
	readonly label: string;
	readonly kind?: 'RQ' | 'RV';
	readonly number?: number;
	readonly comparison?: SeriesComparison | null;
	/** Why there is no comparison. */
	readonly problem?: string;
}

/** A month as "HY1990 Jan": hydrological year label and calendar month. */
function formatMonth(at: YearMonth | null): string {
	return at ? `HY${at.year} ${MONTHS[at.month]}` : '-';
}

const fixed = (value: number | null, digits: number) => (value === null ? 'n/a' : value.toFixed(digits));

const HEADER = ['route', 'MAR sim', 'MAR ref', '% diff', 'NSE', 'max |diff|', 'first diverging', 'expected'];
const WIDTHS = [8, 10, 10, 8, 8, 11, 16, 8];

function line(cells: readonly string[]): string {
	return `${cells.map((c, i) => (i === 0 ? c.padEnd(WIDTHS[i]!) : c.padStart(WIDTHS[i]!))).join(' ').trimEnd()}\n`;
}

/**
 * `wrsm compare <networkDir> <outDir> [--reference <dir>]`.
 *
 * Pairs the simulated `.ANS` files in `outDir` with the reference ones by
 * file name (ignoring case) and prints one row per simulated file. The
 * reference defaults to `<networkDir>/Out` if present, else `<networkDir>`.
 * Exits 1 when a route listed in `expectations` for this network (by folder
 * name) misses the thresholds or has no pair, else 0. Prints file names
 * only, never contents or full paths.
 */
export async function compareCommand(
	argv: readonly string[],
	io: Io,
	engine: Engine,
	expectations: readonly ExpectedRoute[] = EXPECTED_TO_MATCH
): Promise<number> {
	let parsed;
	try {
		parsed = parseArgs({
			args: [...argv],
			options: { reference: { type: 'string' } },
			allowPositionals: true,
			strict: true
		});
	} catch (error) {
		io.err(`wrsm compare: ${(error as Error).message}\n`);
		return EXIT_USAGE;
	}
	const { positionals, values } = parsed;
	if (positionals.length !== 2) {
		io.err('wrsm compare: expected <networkDir> <outDir>\n');
		return EXIT_USAGE;
	}
	const [networkDir, outDir] = positionals as [string, string];

	let network: Folder;
	let simulated: Folder;
	let reference: Folder;
	try {
		network = await Folder.open(networkDir);
		simulated = await Folder.open(outDir);
		const out = network.dir('Out');
		reference = await Folder.open(values.reference ?? (out ? join(networkDir, out) : networkDir));
	} catch {
		io.err('wrsm compare: cannot read the network, output or reference folder\n');
		return EXIT_USAGE;
	}

	const read = async (folder: Folder, name: string): Promise<AnswerFile> =>
		engine.readAnswer(await readFile(join(folder.path, name), 'utf8'), name);

	const rows: Row[] = [];
	const simNames = simulated.withExtension('.ANS');
	for (const name of simNames) {
		const refName = reference.file(name);
		let sim: AnswerFile;
		try {
			sim = await read(simulated, name);
		} catch (error) {
			rows.push({ label: name, problem: (error as Error).message });
			continue;
		}
		const label = `${sim.kind}${sim.number}`;
		if (!refName) {
			rows.push({ label, kind: sim.kind, number: sim.number, problem: 'no reference file' });
			continue;
		}
		try {
			const comparison = compareAnswers(sim, await read(reference, refName));
			rows.push({ label, kind: sim.kind, number: sim.number, comparison, problem: comparison ? undefined : 'no common year' });
		} catch (error) {
			rows.push({ label, kind: sim.kind, number: sim.number, problem: (error as Error).message });
		}
	}

	rows.sort((a, b) => (a.kind ?? '~').localeCompare(b.kind ?? '~') || (a.number ?? 0) - (b.number ?? 0) || a.label.localeCompare(b.label));

	const folderName = basename(resolve(networkDir)).toUpperCase();
	const expected = new Set(expectations.filter((e) => e.network.toUpperCase() === folderName).map((e) => e.route));
	const isExpected = (row: Row) => row.kind === 'RQ' && row.number !== undefined && expected.has(row.number);

	io.out(line(HEADER));
	let failures = 0;
	for (const row of rows) {
		let mark = '';
		if (isExpected(row)) {
			const ok = meetsThresholds(row.comparison ?? null);
			if (!ok) failures++;
			mark = ok ? 'ok' : 'FAIL';
		}
		const c = row.comparison;
		if (c) {
			io.out(
				line([
					row.label,
					c.marSimulated.toFixed(3),
					c.marReference.toFixed(3),
					fixed(c.marPctDiff, 2),
					fixed(c.nse, 4),
					c.maxAbsDiff.toFixed(3),
					formatMonth(c.firstDivergingMonth),
					mark
				])
			);
		} else {
			io.out(`${row.label.padEnd(WIDTHS[0]!)} ${row.problem}${mark ? ` (${mark})` : ''}\n`);
		}
	}

	// An expected route with no simulated file at all fails too.
	const seen = new Set(rows.filter(isExpected).map((r) => r.number));
	for (const route of [...expected].filter((r) => !seen.has(r)).sort((a, b) => a - b)) {
		failures++;
		io.out(`${`RQ${route}`.padEnd(WIDTHS[0]!)} no simulated file (FAIL)\n`);
	}

	const unpaired = reference.withExtension('.ANS').filter((name) => !simulated.file(name)).length;
	io.out(
		`${rows.length} simulated file${rows.length === 1 ? '' : 's'}; ${unpaired} reference file${unpaired === 1 ? '' : 's'} without a simulated one; ` +
			`${expected.size} expected to match (|MAR diff| <= ${MAR_PCT_DIFF_MAX} %, NSE >= ${NSE_MIN}), ${failures} failed\n`
	);
	return failures > 0 ? EXIT_FAILED : EXIT_OK;
}
