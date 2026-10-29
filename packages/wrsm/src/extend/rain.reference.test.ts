import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readRainfall, writeRainfall } from '../io/rainfall.js';
import { applyRainfallExtension, fitRainfallExtension } from './rain.js';
import { syntheticChirpsMonthly } from './synthetic.js';

// Local-only (issue #3 rule 2): extend every .RAN under WRSM_REFERENCE_DIR
// with a synthetic CHIRPS series and check that every original line writes
// back byte for byte, before the appended rows. Skips when the variable is
// unset. Prints counts and relative paths of failures, never file contents.

const dir = process.env.WRSM_REFERENCE_DIR;

function walk(root: string): string[] {
	return readdirSync(root).flatMap((name) => {
		const path = join(root, name);
		return statSync(path).isDirectory() ? walk(path) : [path];
	});
}

describe.skipIf(!dir)('extension against WRSM_REFERENCE_DIR', () => {
	it('keeps every original .RAN row byte-identical when extended', () => {
		const files = walk(dir as string).filter((p) => p.toUpperCase().endsWith('.RAN'));
		const chirps = syntheticChirpsMonthly();
		let extended = 0;
		let refused = 0;
		let nothing = 0;
		let clamped = 0;
		const failures: string[] = [];
		for (const path of files) {
			const text = readFileSync(path, 'latin1');
			try {
				const ran = readRainfall(text, basename(path));
				let fit;
				try {
					fit = fitRainfallExtension(ran, chirps);
				} catch {
					refused++;
					continue;
				}
				if (fit.factors.some((f) => f.computed > 5)) clamped++;
				if (fit.appendable === null) {
					nothing++;
					continue;
				}
				// The synthetic series is a summer pattern, so a winter-rainfall file can
				// compute a factor above 5 (refused): clamp it, the check is about the rows.
				const factors = fit.factors.map((f) => Math.min(f.computed, 5)) as unknown as Parameters<typeof applyRainfallExtension>[3];
				const { series } = applyRainfallExtension(ran, chirps, fit, factors, { file: basename(path), quaternaries: [], accessed: '2026-10-29' });
				const written = writeRainfall(series);
				const source = ran.source?.lines ?? [];
				// Every data line of the original, in order, then the appended rows.
				const out = written.split('\r\n');
				const dataLines = source.filter((l) => l.trim() !== '');
				if (out.slice(0, dataLines.length).join('\n') !== dataLines.join('\n')) failures.push(`${relative(dir as string, path)}: original rows changed`);
				else if (JSON.stringify(readRainfall(written, basename(path)).rows) !== JSON.stringify(series.rows)) failures.push(`${relative(dir as string, path)}: re-read differs`);
				else extended++;
			} catch (error) {
				failures.push(`${relative(dir as string, path)}: ${(error as Error).message.replace(dir as string, '')}`);
			}
		}
		console.log(`extension reference check: ${files.length} .RAN files, ${extended} extended byte-identical, ${refused} refused (no overlap), ${nothing} nothing to append, ${clamped} with a computed factor above 5 (clamped), ${failures.length} failures`);
		expect(failures).toEqual([]);
		expect(extended).toBeGreaterThan(0);
	});
});
