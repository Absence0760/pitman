import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readRunoff } from '../io/runoff.js';
import { DEFAULT_ALIEN_OPTIONS, TALL_SHRUB_C_REFERENCE_FIT, alienReductionTargets } from './alien.js';

// Every SFR child that WRSM2000.ERR reports as "CSIR ALIEN Vegetation":
// our TPRM / TPRL (alienReductionTargets) against the run log's. Pure
// check of TT 690 eqs. 12.3–12.9 on the child's L.011–L.015, no hydrology.
// Reports counts and % only, never values, paths or names.
const dir = process.env.WRSM_REFERENCE_DIR;

interface Child {
	readonly runDir: string;
	readonly network: string;
	readonly number: number;
	sfr?: string;
	tprm?: number;
	tprl?: number;
}

function runLogs(root: string): string[] {
	const out: string[] = [];
	const walk = (d: string): void => {
		for (const name of readdirSync(d)) {
			const path = join(d, name);
			if (statSync(path).isDirectory()) walk(path);
			else if (/^WRSM2000\.ERR$/i.test(name)) out.push(path);
		}
	};
	walk(root);
	return out.sort();
}

/** Child blocks of one run log (docs/formats.md §14; lines end CRLF or bare CR). */
function children(path: string): Child[] {
	const lines = readFileSync(path, 'latin1').split(/\r\n|\r|\n/);
	let network = '';
	const out: Child[] = [];
	let child: Child | null = null;
	for (const line of lines) {
		const net = /Network:\s*(\S+)/.exec(line);
		if (net && !network) network = net[1]!;
		const start = /^==== CHILD (\d+)/.exec(line);
		if (start) {
			child = { runDir: dirname(path), network, number: Number(start[1]) };
			out.push(child);
			continue;
		}
		if (!child) continue;
		const sfr = /^SFR is (.*)$/.exec(line);
		if (sfr) child.sfr = sfr[1]!.trim();
		const m = /\(TPRM\) = (-?\d+(?:\.\d+)?)/.exec(line);
		if (m && child.tprm === undefined) child.tprm = Number(m[1]);
		const l = /\(TPRL\) = (-?\d+(?:\.\d+)?)/.exec(line);
		if (l && child.tprl === undefined) child.tprl = Number(l[1]);
	}
	return out;
}

const pct = (x: number) => `${x.toFixed(2)} %`;

describe.skipIf(!dir)('CSIR alien vegetation targets against WRSM2000.ERR', () => {
	it('TPRM within 4 % (manual eq. 12.5) and 1 % (fitted shrub constant, R6-V6); TPRL bounded by the curves (R6-V7)', () => {
		const all = runLogs(dir as string).flatMap(children).filter((c) => /CSIR ALIEN/i.test(c.sfr ?? ''));
		expect(all.length).toBeGreaterThan(0);

		const relManual: number[] = [];
		const relFit: number[] = [];
		let exactManual = 0;
		let exactFit = 0;
		let tprlAboveCurve = 0;
		let tprlBelowTprm = 0;
		let tprlEqualsTprm = 0;
		const unreadable: number[] = [];
		const tprlPts: number[] = [];
		for (const c of all) {
			const file = readdirSync(c.runDir).find((n) => n.toUpperCase() === `${c.network}RU${c.number}.DAT`.toUpperCase());
			if (!file || c.tprm === undefined || c.tprl === undefined) {
				unreadable.push(c.number);
				continue;
			}
			if (!(c.tprm > 0)) {
				unreadable.push(c.number); // a logged TPRM of 0 (no area) can't give a relative error
				continue;
			}
			const module = readRunoff(readFileSync(join(c.runDir, file), 'latin1'), file);
			const alien = module.alienVegetation!;
			const manual = alienReductionTargets(alien, DEFAULT_ALIEN_OPTIONS);
			const fit = alienReductionTargets(alien, { ...DEFAULT_ALIEN_OPTIONS, tallShrubBiomassC: TALL_SHRUB_C_REFERENCE_FIT });
			relManual.push((100 * Math.abs(manual.tprm - c.tprm)) / c.tprm);
			relFit.push((100 * Math.abs(fit.tprm - c.tprm)) / c.tprm);
			if (Math.abs(manual.tprm - c.tprm) < 0.0005) exactManual++;
			if (Math.abs(fit.tprm - c.tprm) < 0.0005) exactFit++;
			if (c.tprl > fit.tprl + 0.0005) tprlAboveCurve++;
			if (c.tprl < c.tprm - 0.0005) tprlBelowTprm++;
			if (Math.abs(c.tprl - c.tprm) < 0.0005) tprlEqualsTprm++;
			tprlPts.push(Math.abs(fit.tprl - c.tprl));
		}
		const n = relManual.length;
		const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
		console.info(
			[
				`CSIR alien children: ${all.length} in the run logs, ${n} compared, ${unreadable.length} without a readable RU file, targets or a TPRM above 0`,
				`TPRM, manual c: exact to 4 dp ${exactManual}/${n}, mean |error| ${pct(mean(relManual))}, max ${pct(Math.max(...relManual))}`,
				`TPRM, fitted c: exact to 4 dp ${exactFit}/${n}, mean |error| ${pct(mean(relFit))}, max ${pct(Math.max(...relFit))}`,
				`TPRL: WRSM2000 equal to TPRM in ${tprlEqualsTprm}/${n}, below TPRM in ${tprlBelowTprm}/${n}, above our curve in ${tprlAboveCurve}/${n}; mean |error| ${mean(tprlPts).toFixed(2)} points`
			].join('\n')
		);
		expect(unreadable).toEqual([]);
		expect(Math.max(...relManual)).toBeLessThan(4);
		expect(Math.max(...relFit)).toBeLessThan(1);
		expect(tprlBelowTprm).toBe(0);
		expect(tprlAboveCurve).toBe(0);
	});
});
