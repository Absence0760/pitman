import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readRunoff, writeRunoff } from './runoff.js';
import { WrsmParseError } from './tokens.js';

// Every runoff module file under WRSM_REFERENCE_DIR must read and write back
// byte-identical. Reports counts and relative paths only, never contents.
const dir = process.env.WRSM_REFERENCE_DIR;

/** All `*RU<n>.DAT` files below `root`, any case, following symlinks. */
function runoffFiles(root: string): string[] {
	const out: string[] = [];
	const walk = (d: string): void => {
		for (const name of readdirSync(d)) {
			const path = join(d, name);
			const stat = statSync(path);
			if (stat.isDirectory()) walk(path);
			else if (/RU\d{1,4}\.DAT$/i.test(name)) out.push(path);
		}
	};
	walk(root);
	return out.sort();
}

/** 1-based number of the first line where two texts differ. */
function firstDifference(a: string, b: string): number {
	const x = a.split('\n');
	const y = b.split('\n');
	let k = 0;
	while (k < x.length && x[k] === y[k]) k++;
	return k + 1;
}

describe.skipIf(!dir)('runoff module files in WRSM_REFERENCE_DIR', () => {
	it('read and write back byte-identical', () => {
		const root = dir as string;
		const files = runoffFiles(root);
		const identical: string[] = [];
		// Known kinds of genuine exception, reported by count:
		const overflow: string[] = []; // a field holds Fortran overflow asterisks (§1.2: an error)
		const spacingOnly: string[] = []; // hand-edited spacing; values round-trip exactly
		const failures: string[] = [];

		for (const path of files) {
			const rel = relative(root, path);
			const text = readFileSync(path, 'latin1');
			const name = path.split(/[\\/]/).pop() ?? path;
			let module;
			try {
				module = readRunoff(text, name);
			} catch (e) {
				if (e instanceof WrsmParseError && /found '\*+'/.test(e.detail)) overflow.push(rel);
				else failures.push(`${rel}: read failed at line ${e instanceof WrsmParseError ? e.line : '?'}`);
				continue;
			}
			let out: string;
			try {
				out = writeRunoff(module);
			} catch (e) {
				failures.push(`${rel}: write failed (${e instanceof Error ? e.message.split(':')[0] : 'unknown'})`);
				continue;
			}
			if (out === text) {
				identical.push(rel);
				continue;
			}
			let same = false;
			try {
				same = JSON.stringify(readRunoff(out, name)) === JSON.stringify(module);
			} catch {
				same = false;
			}
			if (same) spacingOnly.push(`${rel}: line ${firstDifference(text, out)}`);
			else failures.push(`${rel}: differs from line ${firstDifference(text, out)}`);
		}

		console.log(
			`runoff files: ${files.length}; byte-identical ${identical.length}; ` +
				`overflow ${overflow.length}; spacing only ${spacingOnly.length}; failed ${failures.length}`
		);
		for (const f of [...overflow.map((p) => `${p}: overflow asterisks`), ...spacingOnly, ...failures]) console.log(`  ${f}`);

		expect(files.length).toBeGreaterThan(0);
		expect(failures).toEqual([]);
		// The reference set has one hand-edited and one overflowed (unreferenced) file.
		expect(spacingOnly.length).toBeLessThanOrEqual(1);
		expect(overflow.length).toBeLessThanOrEqual(1);
	});
});
