import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readBundle } from '../io/bundle.js';
import { applyRunMode } from '../network/modes.js';
import { lookupFile } from '../network/modules.js';
import type { RunoffModule } from '../types.js';
import { runRunoffModule } from './pitman.js';

// Local-only evidence for OQ-23 (initial soil moisture, docs/theory/pitman.md §5):
// WRSM2000's first-month net catchment runoff (<net>RU<n>ncr.MTS, Mm³) of every
// free Sami module under WRSM_REFERENCE_DIR, against runs started from
// S0 = f·ST for a grid of f. In month 1 the output is almost all soil interflow
// draining S0, so it measures S0 directly. Read with the Pitman total as the
// interflow (OQ-S3 (b), unlagged) the fit is sharp at f = ½; with the default
// composition (a) no S0 fits (sami.md OQ-S3 evidence). Months under 0.05 Mm³
// are skipped (rounding). Console output is counts
// only. Skips only when the variable is unset.

const dir = process.env.WRSM_REFERENCE_DIR;
const FRACTIONS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 1];

function walk(root: string): string[] {
	return readdirSync(root).flatMap((name) => {
		const path = join(root, name);
		return statSync(path).isDirectory() ? walk(path) : [path];
	});
}

/** The values of a `.MTS` series in month order (same layout as `.ANS`). */
function series(text: string): number[] {
	const out: number[] = [];
	for (const line of text.split(/\r\n?|\n/)) {
		if (!/^ {4}[ 0-9]{3}[0-9]/.test(line)) continue;
		for (let k = 0; k < 12; k++) out.push(Number(line.slice(8 + 8 * k, 16 + 8 * k)));
	}
	return out;
}

describe.skipIf(!dir)('OQ-23 initial soil moisture against WRSM_REFERENCE_DIR (first-month ncr.MTS)', () => {
	it('the first month fits S0 = ST/2 best', () => {
		const best = new Map<number, number>(FRACTIONS.map((f) => [f, 0]));
		let insensitive = 0;
		const seen = new Set<string>();
		for (const netPath of walk(dir as string).filter((p) => /\.NET$/i.test(p))) {
			const folder = dirname(netPath);
			const names = readdirSync(folder);
			const input = Object.fromEntries(walk(folder).map((p) => [relative(folder, p).split('\\').join('/'), readFileSync(p, 'latin1')]));
			const read = readBundle(input, { network: relative(folder, netPath).split('\\').join('/') });
			if (!read.ok) continue;
			const { network, rainfall } = read.bundle;
			const modules = read.bundle.modules.filter((m): m is RunoffModule => m.kind === 'RU');
			const children = new Set(modules.flatMap((m) => m.sfrChildren ?? []));
			for (const m of modules) {
				// Free Sami modules only: an SFR parent or child runs with its group.
				if (!m.sami || (m.sfrChildren?.length ?? 0) > 0 || children.has(m.number)) continue;
				const file = names.find((n) => n.toLowerCase() === `${network.code.toLowerCase()}ru${m.number}ncr.mts`);
				const key = `${folder}/${file}`;
				if (!file || seen.has(key)) continue;
				seen.add(key);
				const ref = series(readFileSync(join(folder, file), 'latin1'))[0]!;
				const rain = lookupFile(rainfall, m.rainfallFile);
				// .MTS is printed to 0.01 Mm³: below 0.05 the rounding alone is ≥ 10 %, and in the dry
				// modules that small a first month is not soil interflow (it doesn't move with S0).
				if (!rain || !(ref >= 0.05)) continue;
				const mode = { kind: 'historical' } as const;
				const first = FRACTIONS.map((f) => {
					const run = runRunoffModule(applyRunMode(m, mode), rain, {
						startYear: network.startYear,
						endYear: network.endYear,
						mode,
						parent: null,
						pitman: { initialSoilMoisture: f * (m.sami!.pitman ?? m.pitman).ST },
						sami: { finalRunoff: 'totalPlusBaseflow', pitmanParts: 'unlagged' }
					});
					return run.outflow.values[0]!;
				});
				// S0 must move the month by more than the print rounding, or it measures something else.
				if (Math.max(...first) - Math.min(...first) < 0.1 * ref) {
					insensitive++;
					continue;
				}
				const errors = first.map((v) => Math.abs(v - ref));
				const f = FRACTIONS[errors.indexOf(Math.min(...errors))]!;
				best.set(f, best.get(f)! + 1);
			}
		}
		const total = [...best.values()].reduce((a, b) => a + b, 0);
		console.log(`OQ-23: ${total} free Sami modules with a month-1 ncr.MTS that S0 moves by > 10 % (${insensitive} it doesn't); best S0/ST: ${[...best].filter(([, n]) => n > 0).map(([f, n]) => `${f}: ${n}`).join(', ')}`);
		expect(total).toBeGreaterThan(0);
		const mode = [...best].reduce((a, b) => (b[1] > a[1] ? b : a));
		expect(mode[0]).toBe(0.5);
		expect(mode[1]).toBeGreaterThan(total / 2);
	}, 600_000);
});
