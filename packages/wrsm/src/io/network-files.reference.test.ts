import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AnswerFile } from '../types.js';
import { answerFromSeries, readAnswer, writeAnswer } from './answer.js';
import { readDemand, writeDemand } from './demand.js';
import { readNetwork, writeNetwork } from './network.js';
import { readObserved, writeObserved } from './observed.js';
import { readRainfall, writeRainfall } from './rainfall.js';

// Round 2 exit test for the network-level files: every .NET, .RAN, .obs and
// .ANS under WRSM_REFERENCE_DIR, every file a .NET gauge names, and every
// defined-flow or demand file a module names, read and written back
// byte-identical. It skips only when the variable is unset. It prints counts
// and the relative paths of failures, never file contents.

const dir = process.env.WRSM_REFERENCE_DIR;

function walk(root: string): string[] {
	return readdirSync(root).flatMap((name) => {
		const path = join(root, name);
		return statSync(path).isDirectory() ? walk(path) : [path];
	});
}

// Extensions a module route line has been seen naming a flow file with
// (docs/formats.md §3.2), plus the other series the read accepts.
const FLOW_EXTENSIONS = ['ABS', 'PRN', 'IRR', 'DEF', 'URB', 'IND', 'OBS', 'ANS', 'NAT', 'DEM'];

const ext = (path: string) => (path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toUpperCase() : '');
// Latin-1, so every byte survives the round trip (docs/formats.md §1.1).
const read = (path: string) => readFileSync(path, 'latin1');

interface Tally {
	files: number;
	identical: number;
	/** Also identical when written without the kept source text (canonical layout only). */
	canonical: number;
	failures: string[];
}

const tally = (): Tally => ({ files: 0, identical: 0, canonical: 0, failures: [] });

function check(t: Tally, path: string, roundTrip: (text: string) => { written: string; canonical?: string }): void {
	t.files++;
	const text = read(path);
	try {
		const { written, canonical } = roundTrip(text);
		if (written === text) t.identical++;
		else t.failures.push(`${relative(dir as string, path)}: differs after write`);
		if (canonical === undefined || canonical === text) t.canonical++;
	} catch (error) {
		t.failures.push(`${relative(dir as string, path)}: ${(error as Error).message.replace(dir as string, '')}`);
	}
}

describe.skipIf(!dir)('network files round-trip against WRSM_REFERENCE_DIR', () => {
	const files = dir ? walk(dir) : [];
	// Case-insensitive name lookup per folder (WRSM2000 runs on Windows, §1.3).
	const byFolder = new Map<string, Map<string, string>>();
	for (const path of files) {
		const folder = dirname(path);
		if (!byFolder.has(folder)) byFolder.set(folder, new Map());
		byFolder.get(folder)?.set(basename(path).toUpperCase(), path);
	}
	const resolve = (folder: string, name: string) =>
		byFolder.get(folder)?.get(name.slice(Math.max(name.lastIndexOf('\\'), name.lastIndexOf('/')) + 1).toUpperCase());
	const report: Record<string, unknown> = {};

	it('reads and rewrites every .NET', () => {
		const t = tally();
		for (const path of files.filter((p) => ext(p) === 'NET')) {
			check(t, path, (text) => ({ written: writeNetwork(readNetwork(text, basename(path))) }));
		}
		report.net = t;
		expect(t.failures).toEqual([]);
		expect(t.files).toBeGreaterThan(0);
	});

	it('reads and rewrites every .RAN', () => {
		const t = tally();
		for (const path of files.filter((p) => ext(p) === 'RAN')) {
			check(t, path, (text) => {
				const series = readRainfall(text, basename(path));
				const { source: _source, ...bare } = series;
				return { written: writeRainfall(series), canonical: writeRainfall(bare) };
			});
		}
		report.ran = t;
		expect(t.failures).toEqual([]);
	});

	it('reads and rewrites every .obs and every file a gauge names', () => {
		const targets = new Set(files.filter((p) => ext(p) === 'OBS'));
		let missing = 0;
		for (const path of files.filter((p) => ext(p) === 'NET')) {
			for (const gauge of readNetwork(read(path), basename(path)).gauges) {
				const found = resolve(dirname(path), gauge.observedFile);
				if (found === undefined) missing++;
				else targets.add(found);
			}
		}
		const t = tally();
		for (const path of targets) {
			check(t, path, (text) => {
				const flow = readObserved(text, basename(path));
				const { source: _source, ...bare } = flow;
				return { written: writeObserved(flow), canonical: writeObserved(bare) };
			});
		}
		report.observed = { ...t, gaugeFilesMissing: missing };
		expect(t.failures).toEqual([]);
	});

	it('reads and rewrites every defined-flow or demand file a module names', () => {
		const targets = new Set<string>();
		let missing = 0;
		for (const path of files.filter((p) => ext(p) === 'DAT')) {
			for (const m of read(path).matchAll(/'([^']*)'/g)) {
				const name = (m[1] ?? '').trim();
				// Quoted module names may hold a dot too, so only these count as files.
				if (!FLOW_EXTENSIONS.includes(ext(name))) continue;
				const found = resolve(dirname(path), name);
				if (found === undefined) missing++;
				else targets.add(found);
			}
		}
		const t = tally();
		for (const path of targets) {
			check(t, path, (text) => {
				const series = readDemand(text, basename(path));
				const { source: _source, ...bare } = series;
				return { written: writeDemand(series), canonical: writeDemand(bare) };
			});
		}
		report.demand = { ...t, referencedFilesMissing: missing };
		expect(t.failures).toEqual([]);
		expect(t.files).toBeGreaterThan(0);
	});

	it('reads and rewrites every .ANS, and measures how far answerFromSeries gets from printed values', () => {
		const t = tally();
		// answerFromSeries fed the printed months cannot see the unrounded
		// values WRSM2000 summed, so its annual/mean/AVERAGE columns are
		// expected to differ in some rows; these counts measure by how much.
		const fromPrinted = { rows: 0, annualDiffers: 0, meanDiffers: 0, averageFiles: 0, averageDiffers: 0 };
		const ansText = (file: AnswerFile) => writeAnswer(file).split('\r\n');
		for (const path of files.filter((p) => ext(p) === 'ANS')) {
			check(t, path, (text) => {
				const file = readAnswer(text, basename(path));
				const first = file.rows[0];
				if (first !== undefined) {
					const rebuilt = answerFromSeries(file.kind, file.number, {
						startYear: first.year,
						values: file.rows.flatMap((r) => r.months),
						unit: 'Mm3PerMonth'
					});
					const original = text.split('\r\n');
					const again = ansText(rebuilt);
					file.rows.forEach((_, i) => {
						fromPrinted.rows++;
						if (original[i]?.slice(104, 114) !== again[i]?.slice(104, 114)) fromPrinted.annualDiffers++;
						if (original[i]?.slice(114, 124) !== again[i]?.slice(114, 124)) fromPrinted.meanDiffers++;
					});
					fromPrinted.averageFiles++;
					if (original[file.rows.length + 1] !== again[file.rows.length + 1]) fromPrinted.averageDiffers++;
				}
				return { written: writeAnswer(file) };
			});
		}
		report.ans = { ...t, fromPrinted };
		expect(t.failures).toEqual([]);
		expect(t.files).toBeGreaterThan(0);
		console.log(JSON.stringify(report, null, 1));
	});
});
