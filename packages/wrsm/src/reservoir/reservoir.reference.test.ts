import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readAnswer } from '../io/answer.js';
import { readDemand } from '../io/demand.js';
import { readNetwork } from '../io/network.js';
import { readRainfall } from '../io/rainfall.js';
import { readReservoir } from '../io/reservoir.js';
import type { ModuleRunContext, RouteFlows } from '../network/contract.js';
import type { DemandSeries, MonthlySeries, RainfallSeries } from '../types.js';
import { runReservoir, type ReservoirOptions } from './reservoir.js';

// Local-only check of the reservoir module against WRSM2000's own route
// outputs (docs/theory/reservoir.md §8). WRSM2000 wrote no reservoir storage
// (`RV<n>.ANS`) in the reference set, so the check is on the spill route:
// for every reservoir whose inflow routes and every outflow route have an
// `RQ<route>.ANS`, the reservoir is run on those inflows (historical mode,
// the .NET's period), with each calculated outflow's .ANS as its demand, and
// its spill route compared with WRSM2000's. Skips only when the variable is
// unset. Prints counts and percentages only, never names or values.

const dir = process.env.WRSM_REFERENCE_DIR;

function walk(root: string): string[] {
	return readdirSync(root).flatMap((name) => {
		const path = join(root, name);
		return statSync(path).isDirectory() ? walk(path) : [path];
	});
}

const read = (path: string) => readFileSync(path, 'latin1');

interface Fit {
	/** Spill-route MAR difference, %. */
	readonly mar: number;
	readonly nse: number;
	/** Months whose simulated spill-route flow is within 0.015 million m³ of WRSM2000's printed value (two-decimal print plus rounded inputs). */
	readonly monthsClose: number;
	readonly months: number;
}

interface Case {
	run(options?: Partial<ReservoirOptions>): Fit;
}

function series(file: ReturnType<typeof readAnswer>, startYear: number, endYear: number): MonthlySeries | undefined {
	const byYear = new Map(file.rows.map((r) => [r.year, r.months]));
	const values: number[] = [];
	for (let y = startYear; y <= endYear; y++) {
		const months = byYear.get(y);
		if (!months) return undefined;
		values.push(...months);
	}
	return { startYear, values, unit: 'Mm3' };
}

function collect(root: string): { cases: Case[]; skipped: Record<string, number> } {
	const files = walk(root);
	const byFolderName = new Map<string, string>();
	for (const f of files) byFolderName.set(`${dirname(f)}|${basename(f).toUpperCase()}`, f);
	const cases: Case[] = [];
	const skipped: Record<string, number> = {};
	const skip = (why: string) => (skipped[why] = (skipped[why] ?? 0) + 1);

	for (const netPath of files.filter((f) => /\.NET$/i.test(f))) {
		let net;
		try {
			net = readNetwork(read(netPath), basename(netPath));
		} catch {
			continue;
		}
		const folder = dirname(netPath);
		const under = files.filter((f) => f.startsWith(folder + sep));
		const answers = new Map<number, string>();
		for (const f of under) {
			const m = new RegExp(`^${net.code}RQ(\\d+)\\.ANS$`, 'i').exec(basename(f));
			if (m) answers.set(Number(m[1]), f);
		}
		const inFolder = (name: string) => byFolderName.get(`${folder}|${name.slice(Math.max(name.lastIndexOf('\\'), name.lastIndexOf('/')) + 1).toUpperCase()}`);
		const { startYear, endYear } = net;
		net.modules.forEach((entry) => {
			if (entry.type !== 'RV') return;
			const path = inFolder(`${net.code}RV${entry.number}.DAT`);
			if (!path) return;
			const rv = readReservoir(read(path), basename(path));
			const ans = (route: number) => {
				const f = answers.get(route);
				return f ? series(readAnswer(read(f), basename(f)), startYear, endYear) : undefined;
			};
			const inflows: Record<number, MonthlySeries> = {};
			for (const c of rv.inflows) {
				if (c.definedFlowFile !== null) continue;
				const s = ans(c.route);
				if (!s) return skip('an inflow route has no .ANS');
				inflows[c.route] = s;
			}
			const observedSpill = ans(rv.spillRoute);
			if (!observedSpill) return skip('spill route has no .ANS');
			const demands: Record<number, MonthlySeries> = {};
			for (const o of rv.outflows) {
				if (o.definedFlowFile !== null || o.route === rv.spillRoute) continue;
				const s = ans(o.route);
				if (!s) return skip('a calculated outflow has no .ANS');
				demands[o.route] = s;
			}
			const ctx: ModuleRunContext = {
				mode: { kind: 'historical' },
				startYear,
				endYear,
				rainfall: (name): RainfallSeries | undefined => {
					const f = inFolder(name);
					return f ? readRainfall(read(f), basename(f)) : undefined;
				},
				flowFile: (name): DemandSeries | undefined => {
					const f = inFolder(name);
					return f ? readDemand(read(f), basename(f)) : undefined;
				}
			};
			cases.push({
				run(options) {
					// Errors propagate: a reservoir that can't run fails the check.
					const simulated = runReservoir(rv, inflows as RouteFlows, ctx, { demands, ...(options && { options }) }).result.outflows[rv.spillRoute]!.values;
					const obs = observedSpill.values;
					const sum = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0);
					const mean = sum(obs) / obs.length;
					const sse = sum(obs.map((o, t) => (o - simulated[t]!) ** 2));
					const sst = sum(obs.map((o) => (o - mean) ** 2));
					return {
						mar: sum(obs) > 0 ? (100 * (sum(simulated) - sum(obs))) / sum(obs) : 0,
						nse: sst > 0 ? 1 - sse / sst : sse < 1e-6 ? 1 : 0,
						monthsClose: obs.filter((o, t) => Math.abs(o - simulated[t]!) <= 0.015).length,
						months: obs.length
					};
				}
			});
		});
	}
	return { cases, skipped };
}

describe.skipIf(!dir)('reservoir spill route against WRSM2000 (WRSM_REFERENCE_DIR)', () => {
	const { cases, skipped } = dir ? collect(dir) : { cases: [], skipped: {} };

	function summarise(options?: Partial<ReservoirOptions>) {
		const ok = cases.map((c) => c.run(options));
		const months = ok.reduce((s, r) => s + r.months, 0);
		const close = ok.reduce((s, r) => s + r.monthsClose, 0);
		const absMar = ok.map((r) => Math.abs(r.mar)).sort((a, b) => a - b);
		return {
			reservoirs: cases.length,
			ran: ok.length,
			within1pctMar: ok.filter((r) => Math.abs(r.mar) <= 1).length,
			nse099: ok.filter((r) => r.nse >= 0.99).length,
			nse095: ok.filter((r) => r.nse >= 0.95).length,
			worstAbsMarPct: Number((absMar[absMar.length - 1] ?? 0).toFixed(3)),
			medianAbsMarPct: Number((absMar[Math.floor(absMar.length / 2)] ?? 0).toFixed(4)),
			minNse: Number(Math.min(...ok.map((r) => r.nse)).toFixed(5)),
			pctMonthsWithin0015: Number(((100 * close) / Math.max(1, months)).toFixed(2))
		};
	}

	it('runs every checkable reservoir and reports agreement (counts only)', () => {
		const defaults = summarise();
		const zeroHalf = summarise({ zeroInitialStorage: 'halfFull' });
		const float32 = summarise({ precision: 'float32' });
		console.log('reservoir reference check', JSON.stringify({ skipped, defaults, zeroHalf, float32 }));
		// docs/theory/reservoir.md §8, confirming R3-RV1 (TT 690's literal order) and the §3.3 calculated-draft rule.
		for (const s of [defaults, zeroHalf, float32]) {
			expect(s.reservoirs).toBeGreaterThan(0);
			expect(s.within1pctMar).toBe(s.reservoirs);
			expect(s.minNse).toBeGreaterThanOrEqual(0.99);
			expect(s.pctMonthsWithin0015).toBeGreaterThanOrEqual(99.5);
		}
	});
});
