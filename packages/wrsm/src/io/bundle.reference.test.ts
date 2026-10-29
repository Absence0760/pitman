import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readBundle, writeBundle } from './bundle.js';

// Every network folder under WRSM_REFERENCE_DIR (each folder holding a
// .NET) read with readBundle and written back with writeBundle must give
// every file of the folder back byte for byte, for each .NET in it. Skips
// only when the variable is unset. Prints counts only, never names or
// contents (issue #3 rule 2).

const dir = process.env.WRSM_REFERENCE_DIR;

function walk(root: string): string[] {
	return readdirSync(root).flatMap((name) => {
		const path = join(root, name);
		// statSync follows symlinks.
		return statSync(path).isDirectory() ? walk(path) : [path];
	});
}

/** A folder's files as readBundle takes them: relative path → Latin-1 text. */
function folderFiles(folder: string): Record<string, string> {
	return Object.fromEntries(walk(folder).map((p) => [relative(folder, p).split('\\').join('/'), readFileSync(p, 'latin1')]));
}

describe.skipIf(!dir)('reference network folders round-trip through readBundle/writeBundle', () => {
	const folders = dir
		? [...new Set(walk(dir).filter((p) => /\.NET$/i.test(p)).map((p) => p.slice(0, p.length - (p.split('/').pop() ?? '').length - 1)))]
		: [];

	it('every folder, every network, every file', () => {
		let networks = 0;
		let files = 0;
		let identical = 0;
		let writerIdentical = 0;
		let writerCompared = 0;
		let warnings = 0;
		const failures: string[] = [];
		folders.forEach((folder, f) => {
			const input = folderFiles(folder);
			const nets = Object.keys(input).filter((p) => /\.NET$/i.test(p));
			nets.forEach((net, n) => {
				networks++;
				const tag = `folder ${f + 1} network ${n + 1}`;
				const result = readBundle(input, { network: net });
				if (!result.ok) {
					// Masked: the message may quote file content.
					for (const e of result.errors) failures.push(`${tag}: ${e.field ?? ''} ${e.message.replace(/'[^']*'/g, "'…'")}`);
					return;
				}
				warnings += result.warnings.length;
				const out = writeBundle(result.bundle);
				const keys = new Set([...Object.keys(input), ...Object.keys(out)]);
				for (const k of keys) {
					files++;
					if (input[k] === out[k]) identical++;
					else failures.push(`${tag}: a file ${input[k] === undefined ? 'was added' : out[k] === undefined ? 'was lost' : 'differs'}`);
				}
				// The writers alone, for the files a reader read (documented hand-made exceptions expected).
				const canonical = writeBundle(result.bundle, { reuseUnchanged: false });
				for (const k of Object.keys(result.bundle.files.sources)) {
					writerCompared++;
					if (canonical[k] === input[k]) writerIdentical++;
				}
			});
		});
		console.log(
			`bundle: ${folders.length} folders, ${networks} networks, ${identical}/${files} files byte-identical; ` +
				`writers alone ${writerIdentical}/${writerCompared}; warnings ${warnings}; failures ${failures.length}`
		);
		for (const f of failures.slice(0, 50)) console.log(`  ${f}`);
		expect(networks).toBeGreaterThan(0);
		expect(failures).toEqual([]);
	});
});
