import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readNetwork } from '../io/network.js';
import { readRunoff } from '../io/runoff.js';
import type { RunoffModule } from '../types.js';
import { smoothedGushTargets } from './forest.js';
import { DEFAULT_SFR_OPTIONS, runSfrGroup, sfrConstants, sfrJacobian, sfrUpdate, type ChildTargetModel, type SfrParameters, type SfrSimulator } from './sfr.js';

// Local-only checks against the SFR child blocks of the WRSM2000.ERR run logs
// under WRSM_REFERENCE_DIR (docs/formats.md §14). Reports counts and
// percentages only, never values or names.
const dir = process.env.WRSM_REFERENCE_DIR;

interface ChildBlock {
	readonly child: number;
	readonly vmar?: number;
	readonly gush?: { readonly tprm: number; readonly tprl: number };
	/** "PMean", the MAP the run used. */
	readonly pmean?: number;
}

interface Folder {
	readonly path: string;
	readonly blocks: readonly ChildBlock[];
	readonly modules: ReadonlyMap<number, RunoffModule>;
	readonly code: string;
	readonly startYear: number;
	readonly endYear: number;
}

function folders(root: string): Folder[] {
	const out: Folder[] = [];
	const walk = (d: string): void => {
		const names = readdirSync(d);
		const err = names.find((n) => n.toUpperCase() === 'WRSM2000.ERR');
		const netName = names.find((n) => /\.NET$/i.test(n));
		if (err && netName) {
			const text = readFileSync(join(d, err), 'latin1').replace(/\r\n?/g, '\n');
			const blocks = text
				.split('==== CHILD')
				.slice(1)
				.map((b): ChildBlock => {
					const num = (re: RegExp) => {
						const m = re.exec(b);
						return m ? Number(m[1]) : undefined;
					};
					const tprm = num(/^After SMGush, TPRM:\s*(-?[\d.]+)/m);
					const tprl = num(/^After SMGush, TPRL:\s*(-?[\d.]+)/m);
					const vmar = num(/^Naturalised MAR \(VMAR\)\s*=\s*(-?[\d.]+)/m);
					const pmean = num(/^PMean\s*=\s*(-?[\d.]+)/m);
					return {
						child: Number(b.trim().split(/\s/)[0]),
						...(vmar !== undefined && { vmar }),
						...(pmean !== undefined && { pmean }),
						...(tprm !== undefined && tprl !== undefined && { gush: { tprm, tprl } })
					};
				});
			if (blocks.length > 0) {
				const network = readNetwork(readFileSync(join(d, netName), 'latin1'), netName);
				const code = netName.replace(/\.NET$/i, '');
				const modules = new Map<number, RunoffModule>();
				for (const n of names) {
					// Modules are found by file name, <code>RU<n>.DAT (TT 689 §2.3.1), as WRSM2000 finds them.
					const match = new RegExp(`^${code}RU(\\d{1,4})\\.DAT$`, 'i').exec(n);
					if (!match) continue;
					try {
						const m = readRunoff(readFileSync(join(d, n), 'latin1'), n);
						modules.set(Number(match[1]), m);
					} catch {
						// Unreadable files are the runoff reader's own reference test's business.
					}
				}
				out.push({ path: d, blocks, modules, code, startYear: network.startYear, endYear: network.endYear });
			}
		}
		for (const n of names) {
			const p = join(d, n);
			if (statSync(p).isDirectory()) walk(p);
		}
	};
	walk(root);
	return out;
}

const parentOf = (f: Folder, child: number) => [...f.modules.values()].find((m) => m.sfrChildren?.includes(child));


/** The parent's `ncr.MTS` (net catchment runoff), month values by year. */
function netRunoff(f: Folder, parent: number): Map<number, number[]> | undefined {
	const name = readdirSync(f.path).find((n) => n.toLowerCase() === `${f.code.toLowerCase()}ru${parent}ncr.mts`);
	if (!name) return undefined;
	const rows = new Map<number, number[]>();
	for (const line of readFileSync(join(f.path, name), 'latin1').split(/\r\n?|\n/)) {
		if (!/^ {4}[ 0-9]{3}[0-9]/.test(line)) continue;
		rows.set(
			Number(line.slice(4, 8)),
			Array.from({ length: 12 }, (_, k) => Number(line.slice(8 + 8 * k, 16 + 8 * k)))
		);
	}
	return rows;
}

const pct = (n: number, d: number) => (d === 0 ? '–' : `${((100 * n) / d).toFixed(0)} %`);

describe.skipIf(!dir)('SFR children in the WRSM2000.ERR logs under WRSM_REFERENCE_DIR', () => {
	const all = dir ? folders(dir) : [];

	it('Smoothed Gush targets match the logs’ "After SMGush" TPRM/TPRL (TT 690 eq. 11.1, Table 11.1)', () => {
		let blocks = 0;
		let matched = 0;
		let orphaned = 0;
		const misses: string[] = [];
		for (const f of all) {
			for (const b of f.blocks) {
				if (!b.gush) continue;
				const child = f.modules.get(b.child);
				const parent = parentOf(f, b.child);
				if (!child?.afforestation.species || !parent) {
					orphaned++; // the child has since been freed (or removed) in the current files
					continue;
				}
				blocks++;
				// The MAP the logged run used ("PMean"): the files may have changed since the log was written.
				const t = smoothedGushTargets(child.afforestation.species, b.pmean ?? parent.mapMm);
				// The log prints 4 decimals.
				if (Math.abs(t.marPercent - b.gush.tprm) <= 6e-5 + 1e-9 && Math.abs(t.lowFlowPercent - b.gush.tprl) <= 6e-5 + 1e-9) matched++;
				else misses.push(`MAR ${(t.marPercent - b.gush.tprm).toFixed(4)}, low ${(t.lowFlowPercent - b.gush.tprl).toFixed(4)}`);
			}
		}
		console.log(
			`Smoothed Gush: ${matched} of ${blocks} log blocks match to the printed 4 decimals (${pct(matched, blocks)}); ${orphaned} block(s) whose child is no longer a child${misses.length ? `; misses: ${misses.join('; ')}` : ''}`
		);
		expect(blocks).toBeGreaterThan(0);
		expect(matched).toBe(blocks);
	});

	it('Virgin MAR ≈ the parent’s net runoff depth × the child’s active area', () => {
		// The replay simulator returns the parent's ncr.MTS depth (its own runoff over its full
		// L.002 area, afforestation.md §4.2) for any module, so this checks the VMAR definition
		// and the area bookkeeping of runSfrGroup, not the runoff model. Sami depths do depend on
		// the area (OUT ∝ 1/√AREA, R6-F16), which this replay ignores. The .MTS and the .ERR may
		// come from different runs (docs/formats.md §14), so this is a report with a loose floor.
		const noTargets: ChildTargetModel = () => ({ targets: null, label: 'none', messages: [] });
		const errors: number[] = [];
		let zeroBoth = 0;
		let skipped = 0;
		for (const f of all) {
			for (const b of f.blocks) {
				const parent = parentOf(f, b.child);
				const child = f.modules.get(b.child);
				const mts = parent && netRunoff(f, parent.number);
				if (!parent || !child || !mts || b.vmar === undefined) {
					skipped++;
					continue;
				}
				const values: number[] = [];
				for (let y = f.startYear; y <= f.endYear; y++) values.push(...(mts.get(y) ?? new Array<number>(12).fill(Number.NaN)));
				if (values.some((v) => !Number.isFinite(v))) {
					skipped++;
					continue;
				}
				const simulate: SfrSimulator = (m) => ({
					outflow: { startYear: f.startYear, values: values.map((v) => (v / parent.areaKm2) * m.areaKm2), unit: 'Mm3' },
					messages: []
				});
				const r = runSfrGroup({
					parent,
					children: [child],
					mode: { kind: 'historical' },
					startYear: f.startYear,
					endYear: f.endYear,
					simulate,
					targets: { forest: noTargets, alien: noTargets }
				});
				const ours = r.virginMarMm3[child.number] ?? 0;
				if (b.vmar === 0) {
					if (ours === 0) zeroBoth++;
					else errors.push(Number.POSITIVE_INFINITY);
				} else errors.push(Math.abs((100 * (ours - b.vmar)) / b.vmar));
			}
		}
		const n = errors.length;
		const within = (x: number) => errors.filter((e) => e <= x).length;
		const sorted = [...errors].sort((a, b) => a - b);
		const median = n ? sorted[Math.floor(n / 2)]! : 0;
		console.log(
			`Virgin MAR: ${n} child blocks compared (+${zeroBoth} with zero in both, ${skipped} skipped): within 1 % ${within(1)} (${pct(within(1), n)}), within 5 % ${within(5)} (${pct(within(5), n)}), within 10 % ${within(10)} (${pct(within(10), n)}); median |error| ${median.toFixed(1)} %`
		);
		expect(n).toBeGreaterThan(0);
		expect(within(10)).toBeGreaterThanOrEqual(n / 2);
	});

	it('the logged constants and parameter updates replay (R6-F10, R6-F7, R6-F8, R6-F19)', () => {
		// No runoff model: each logged ERRM/ERRL goes in, the next logged PIA … HGSLA must come out.
		let constants = 0;
		let constantsMatched = 0;
		let steps = 0;
		let matched = 0;
		for (const f of all) {
			const text = readFileSync(join(f.path, readdirSync(f.path).find((n) => n.toUpperCase() === 'WRSM2000.ERR')!), 'latin1').replace(/\r/g, ''); // bare CRs split an ITERATION line; drop them
			for (const b of text.split('==== CHILD').slice(1)) {
				const v = (re: RegExp) => Number(re.exec(b)?.[1] ?? Number.NaN);
				const pmean = v(/^PMean = ([\d.]+)/m);
				if (!(pmean > 0)) continue;
				let p: SfrParameters = { PI: v(/^Original PI = ([\d.]+)/m), FF: v(/^Original FF = ([\d.]+)/m), SL: v(/^Original SL = ([\d.]+)/m), ST: v(/^Original ST = ([\d.]+)/m), HGSL: v(/^Original HGSL = ([\d.]+)/m) };
				const c = sfrConstants(pmean, p.ST);
				const logged = ['A', 'B', 'C', 'X', 'Y', 'Z'] as const;
				if (!/^Constant A = /m.test(b)) continue; // a zero-target child prints no constants
				constants++;
				if (logged.every((k) => Math.abs(c[k] - v(new RegExp(`^Constant ${k} = (-?[\\d.]+)`, 'm'))) <= 1e-4 + 1e-9)) constantsMatched++; // one unit in the printed 4th decimal
				const J = sfrJacobian(c, DEFAULT_SFR_OPTIONS.piPerFf);
				const lines = b.split('\n');
				let errM = v(/^TPRM = ([\d.]+)/m);
				let errL = v(/^TPRL = ([\d.]+)/m);
				let update = 0;
				for (let i = 0; i < lines.length; i++) {
					if (!lines[i]!.startsWith('PIA = ')) continue;
					const g = (name: string) => Number(lines.slice(i, i + 6).find((l) => l.startsWith(`${name} = `))!.split('=')[1]);
					const next: SfrParameters = { PI: g('PIA'), FF: g('FFA'), SL: g('SLA'), ST: g('STA'), HGSL: g('HGSLA') };
					const ours = sfrUpdate(p, errM, errL, update, J, DEFAULT_SFR_OPTIONS);
					steps++;
					if ((['PI', 'FF', 'SL', 'ST', 'HGSL'] as const).every((k) => Math.abs(ours[k] - next[k]) <= 5e-3)) matched++;
					p = next;
					update++;
					const it = lines.slice(i).find((l) => l.startsWith('ITERATION :'));
					const em = it && /ERRM: (-?[\d.]+)/.exec(it);
					const el = it && /ERRL: (-?[\d.]+)/.exec(it);
					if (!em || !el) break;
					errM = Number(em[1]);
					errL = Number(el[1]);
				}
			}
		}
		console.log(`SFR constants: ${constantsMatched} of ${constants} logged sets within 0.0001 (${pct(constantsMatched, constants)}); updates: ${matched} of ${steps} replayed within 0.005 (${pct(matched, steps)})`);
		expect(constants).toBeGreaterThan(0);
		expect(constantsMatched).toBe(constants);
		expect(matched).toBeGreaterThanOrEqual(0.9 * steps);
	});
});
