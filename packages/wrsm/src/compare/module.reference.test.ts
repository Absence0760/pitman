import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { SamiOptionsInput, SamiSimulation } from '../groundwater/sami/index.js';
import { readBundle } from '../io/bundle.js';
import { lookupFile } from '../network/modules.js';
import { runRunoffModule, type PitmanOptions } from '../runoff/pitman.js';
import type { MonthlySeries, RunoffModule } from '../types.js';
import { compareSeries } from './compare.js';

// Local-only module-level comparison (issue #3 rules 2 and 3; Round 6 wave 2):
// every free (non-SFR) Sami runoff module under WRSM_REFERENCE_DIR run on its
// own .RAN in historical mode and compared with WRSM2000's net catchment
// runoff for that module, <net>RU<n>ncr.MTS (docs/formats.md § 11.2). No
// routing, no upstream inflow: what is left is the module itself.
//
// "steady" drops the first WRSM_MODULE_WARMUP years (default 5), so a
// first-month / initial-condition difference does not mask the steady part.
// Console output is counts and percentages only. The per-module table goes to
// ../pitman-private/reports/sami-modules.md, outside the repo.
// WRSM_SAMI_VARIANTS=all also runs
// the option readings. Skips only when WRSM_REFERENCE_DIR is unset.

const dir = process.env.WRSM_REFERENCE_DIR;
const allVariants = process.env.WRSM_SAMI_VARIANTS === 'all';
const warmup = Number(process.env.WRSM_MODULE_WARMUP ?? 5);

interface Variant {
	readonly sami?: SamiOptionsInput;
	readonly pitman?: Partial<PitmanOptions>;
}
const VARIANTS: Record<string, Variant> = allVariants
	? {
			default: {},
			'OQ-S3 (a) surface + Sami interflow + baseflow (R6-R0)': { sami: { finalRunoff: 'surfacePlusSami' } },
			'OQ-S3 (b) total + baseflow': { sami: { finalRunoff: 'totalPlusBaseflow' } },
			'OQ-S3 (a) + per-step Muskingum (the R6-R6 baseline)': { sami: { finalRunoff: 'surfacePlusSami' }, pitman: { routing: 'perStep' } },
			'OQ-22 per-step Muskingum (R6-R6)': { pitman: { routing: 'perStep' } },
			'OQ-22 monthly Muskingum': { pitman: { routing: 'monthly' } },
			'OQ-S2 (b) recharge drains S': { sami: { soilFeedback: 'rechargeDrainsS' } },
			'OQ-S3 HEAD (ii) surface': { sami: { headRunoff: 'surface' } },
			'OQ-S4 step-mean S': { sami: { soilMoisture: 'stepMean' } },
			'OQ-S5 recharge from SL': { sami: { soil: { rechargeThreshold: 'SL' } } },
			'OQ-S6 zero-padded REx': { sami: { soil: { rechargeAverageStart: 'zeroPadded' } } },
			'OQ-S8 previous P': { sami: { soil: { percolationStorage: 'previous' } } },
			'OQ-1 midpoint density': { pitman: { sCurveSampling: 'midpointDensity' } },
			'OQ-3 equal interception': { pitman: { interceptionSpread: 'equal' } },
			'OQ-8 spill before Q': { pitman: { stepOrder: 'spillBeforeQ' } },
			'OQ-12 subtractive': { pitman: { evaporationAdjustment: 'subtractive' } },
			'OQ-23 initial S = 0': { pitman: { initialSoilMoisture: 'zero' } },
			'OQ-24 steady lag start': { pitman: { initialLagState: 'steady' } }
		}
	: { default: {} };

function walk(root: string): string[] {
	return readdirSync(root).flatMap((name) => {
		const path = join(root, name);
		return statSync(path).isDirectory() ? walk(path) : [path];
	});
}

/** An `ncr.MTS` as a series (million m³/month); the .ANS layout, two decimals. */
function readNcr(text: string): MonthlySeries {
	const values: number[] = [];
	let startYear: number | undefined;
	for (const line of text.split(/\r\n?|\n/)) {
		if (!/^ {4}[ 0-9]{3}[0-9]/.test(line)) continue;
		startYear ??= Number(line.slice(4, 8));
		for (let k = 0; k < 12; k++) values.push(Number(line.slice(8 + 8 * k, 16 + 8 * k)));
	}
	return { startYear: startYear ?? 0, values, unit: 'Mm3' };
}

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const fmt = (v: number | null | undefined, d = 2) => (v === null || v === undefined ? 'n/a' : v.toFixed(d));
const quantile = (xs: number[], q: number) => {
	if (xs.length === 0) return null;
	const s = [...xs].sort((a, b) => a - b);
	const pos = (s.length - 1) * q;
	const lo = Math.floor(pos);
	return s[lo]! + (s[Math.min(lo + 1, s.length - 1)]! - s[lo]!) * (pos - lo);
};
const dist = (xs: number[], d = 2) => `median ${fmt(quantile(xs, 0.5), d)} (IQR ${fmt(quantile(xs, 0.25), d)} … ${fmt(quantile(xs, 0.75), d)})`;
const drop = (s: MonthlySeries, years: number): MonthlySeries => ({ ...s, startYear: s.startYear + years, values: s.values.slice(12 * years) });

/** Sum a Sami part over the record, mm. */
const sum = (sim: SamiSimulation, f: (m: SamiSimulation['months'][number]) => number) => sim.months.reduce((a, m) => a + f(m), 0);

interface Case {
	readonly label: string;
	readonly module: RunoffModule;
	readonly rainfall: Parameters<typeof runRunoffModule>[1];
	readonly startYear: number;
	readonly endYear: number;
	readonly reference: MonthlySeries;
}

function cases(root: string): Case[] {
	const out: Case[] = [];
	const files = walk(root);
	for (const netPath of files.filter((p) => /\.NET$/i.test(p))) {
		const folder = dirname(netPath);
		const local = walk(folder);
		const input = Object.fromEntries(local.map((p) => [relative(folder, p).split('\\').join('/'), readFileSync(p, 'latin1')]));
		const read = readBundle(input, { network: relative(folder, netPath).split('\\').join('/') });
		if (!read.ok) continue;
		const { bundle } = read;
		const code = bundle.network.code;
		const children = new Set(bundle.modules.flatMap((m) => (m.kind === 'RU' ? (m.sfrChildren ?? []) : [])));
		for (const m of bundle.modules) {
			if (m.kind !== 'RU' || (m.groundwaterModel ?? 0) !== 2 || !m.sami) continue;
			if ((m.sfrChildren?.length ?? 0) > 0 || children.has(m.number)) continue; // free modules only
			const ncr = local.find((p) => p.split(/[\\/]/).pop()!.toLowerCase() === `${code.toLowerCase()}ru${m.number}ncr.mts`);
			if (!ncr) continue;
			const rainfall = lookupFile(bundle.rainfall, m.rainfallFile);
			if (!rainfall) continue;
			out.push({ label: `${relative(root, folder)} RU${m.number}`, module: m, rainfall, startYear: bundle.network.startYear, endYear: bundle.network.endYear, reference: readNcr(readFileSync(ncr, 'latin1')) });
		}
	}
	return out;
}

describe.skipIf(!dir)('module-level comparison against WRSM_REFERENCE_DIR (free Sami RU vs ncr.MTS)', () => {
	it('runs every free Sami module on its own rainfall and compares its net catchment runoff', () => {
		const all = cases(dir as string);
		const report: string[] = ['# Sami module-level comparison (free modules vs ncr.MTS)', '', 'Generated by `src/compare/module.reference.test.ts`; local only (git-ignored).', ''];
		const summary: string[] = ['## Summary', ''];
		for (const [variant, options] of Object.entries(VARIANTS)) {
			const mar: number[] = [];
			const nse: number[] = [];
			const steadyMar: number[] = [];
			const steadyNse: number[] = [];
			let failed = 0;
			const rows: string[] = [];
			for (const c of all) {
				let result: ReturnType<typeof runRunoffModule>;
				try {
					result = runRunoffModule(c.module, c.rainfall, { startYear: c.startYear, endYear: c.endYear, mode: { kind: 'historical' }, parent: null, ...options });
				} catch {
					failed++;
					continue;
				}
				const whole = compareSeries(result.outflow, c.reference);
				const steady = compareSeries(drop(result.outflow, warmup), drop(c.reference, warmup));
				if (!whole || !steady) continue;
				if (whole.marPctDiff != null) mar.push(whole.marPctDiff);
				if (whole.nse != null) nse.push(whole.nse);
				if (steady.marPctDiff != null) steadyMar.push(steady.marPctDiff);
				if (steady.nse != null) steadyNse.push(steady.nse);
				const s = result.sami!;
				const years = s.months.length / 12;
				const per = (f: (m: SamiSimulation['months'][number]) => number) => fmt(sum(s, f) / years, 1);
				const refMm = (whole.marReference * 1000) / c.module.areaKm2;
				rows.push(
					`| ${c.label} | ${fmt(c.module.areaKm2, 0)} | ${fmt(refMm, 1)} | ${fmt(whole.marPctDiff)} | ${fmt(whole.nse, 3)} | ${fmt(steady.marPctDiff)} | ${fmt(steady.nse, 3)} | ${per((m) => m.pitmanTotal)} | ${per((m) => m.surface)} | ${per((m) => m.interflow)} | ${per((m) => m.aquifer.baseflow)} | ${per((m) => m.aquifer.transmissionLoss)} | ${fmt(s.soil.reBar * 12, 1)} | ${c.module.sami!.pitman.TL} |`
				);
			}
			const within = steadyMar.filter((v, i) => Math.abs(v) <= 2 && (steadyNse[i] ?? 0) >= 0.97).length;
			const line =
				`[${variant}] ${mar.length} free Sami modules (${failed} failed); whole record: MAR % ${dist(mar)} (${mar.filter((v) => v > 0).length} high, ${mar.filter((v) => v < 0).length} low), NSE ${dist(nse, 3)}; ` +
				`steady (after ${warmup} y): MAR % ${dist(steadyMar)}, NSE ${dist(steadyNse, 3)}; |MAR| ≤ 2 %: ${steadyMar.filter((v) => Math.abs(v) <= 2).length}, NSE ≥ 0.97: ${steadyNse.filter((v) => v >= 0.97).length}, both: ${within}`;
			console.log(line);
			summary.push(`- ${line}`);
			report.push(`## ${variant}`, '', '| module | km² | ref MAR mm | MAR % | NSE | steady MAR % | steady NSE | Pitman total mm/a | surface | interflow | baseflow | TL | RE mm/a | TL lag |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|', ...rows, '');
		}
		// The report names reference folders and carries per-module figures, so it
		// goes to the private folder beside the main checkout (../pitman-private,
		// or WRSM_PRIVATE_DIR), never into the repo (CLAUDE.md project rule 2).
		const gitDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: repoRoot, encoding: 'utf8' }).trim();
		const mainCheckout = dirname(gitDir);
		const reportDir = join(resolve(process.env.WRSM_PRIVATE_DIR ?? join(mainCheckout, '..', 'pitman-private')), 'reports');
		for (const root of [repoRoot, mainCheckout]) {
			const rel = relative(root, reportDir);
			if (!rel.startsWith('..') && !isAbsolute(rel)) throw new Error(`refusing to write a reference report inside the repo: ${reportDir}`);
		}
		mkdirSync(reportDir, { recursive: true });
		writeFileSync(join(reportDir, 'sami-modules.md'), [...report.slice(0, 4), ...summary, '', ...report.slice(4)].join('\n'));
		expect(all.length).toBeGreaterThan(0);
	}, 600_000);
});
