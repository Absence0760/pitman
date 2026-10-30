import { describe, expect, it } from 'vitest';

import { run } from '../run.js';
import { seededRandom } from '../synthetic/index.js';
import type { NetworkBundle, RainfallExtension } from '../types.js';
import { MAP_LIMITS_MM, MAX_EVALUATIONS, calibrateMap, roundedResult, solveFactor, unsplitNaturalMar } from './calibrate.js';
import type { CalibrateMap, UnsplitNaturalMar } from './contract.js';
import { exampleBundle, examplePlan, hand, piece } from './fixtures.js';
import { applySplit } from './split.js';

// The worked example's toy convex response (subdivide.md § Worked example).
const AREAS = [120, 280] as const;
const q = (p: number) => 0.0004 * Math.max(0, p - 250) ** 2;
const toy = (maps: readonly number[]) => maps.reduce((s, m, i) => s + (AREAS[i]! * q(m)) / 1000, 0);

const contract: { c: CalibrateMap; u: UnsplitNaturalMar } = { c: calibrateMap, u: unsplitNaturalMar };

describe('solveFactor, the worked example', () => {
	const search = solveFactor([820, 610], 24, toy);

	it('reproduces the table', () => {
		expect(search.status).toBe('converged');
		expect(search.iterations.map((i) => i.step)).toEqual(['start', 'ratio', 'secant', 'secant']);
		const table = [
			[1, 30.11, 25.46, 820, 610],
			[0.7971, 14.068, -41.38, 654, 486],
			[0.9227, 23.282, -2.99, 757, 563],
			[0.9325, 24.098, 0.41, 765, 569]
		] as const;
		table.forEach(([s, mar, error, t, r], k) => {
			const it = search.iterations[k]!;
			expect(it.n).toBe(k);
			expect(it.s).toBeCloseTo(s, 4);
			expect(it.marMm3).toBeCloseTo(mar, 3);
			expect(it.errorPct).toBeCloseTo(error, 2);
			expect(Math.round(it.maps[0]!)).toBe(t);
			expect(Math.round(it.maps[1]!)).toBe(r);
		});
		expect(search.best).toBe(search.iterations[3]);
	});

	it('keeps the grid ratio at every iteration (invariant 2)', () => {
		for (const it of search.iterations) expect(Math.abs(it.maps[0]! / it.maps[1]! - 820 / 610)).toBeLessThan(1e-12);
	});
});

describe('solveFactor, guards', () => {
	const linear = (k: number) => (maps: readonly number[]) => k * maps.reduce((a, b) => a + b, 0);

	it('stops at once within 2 % of the target, at s = 1', () => {
		const s = solveFactor([500], 10.1, linear(0.02));
		expect(s.status).toBe('converged');
		expect(s.iterations).toHaveLength(1);
		expect(s.best!.s).toBe(1);
		expect(s.best!.step).toBe('start');
	});

	it('refuses a run with no runoff, with the spec sentence', () => {
		const s = solveFactor([500], 10, () => 0);
		expect(s.status).toBe('refused');
		expect(s.message).toBe('the natural run gives no runoff, so no factor can be found');
		expect(s.best).toBeNull();
	});

	it('refuses a target or a MAP that is not above zero', () => {
		expect(solveFactor([500], 0, linear(1)).status).toBe('refused');
		expect(solveFactor([0, 500], 1, linear(1)).status).toBe('refused');
		expect(solveFactor([], 1, linear(1)).status).toBe('refused');
	});

	it('clamps to the factor bound, and two clamps at one bound end it as failed', () => {
		const s = solveFactor([500], 100, linear(0.02)); // MAR(1) = 10: would need s = 10
		expect(s.status).toBe('not_converged');
		expect(s.message).toBe('the MAPs would have to change by more than a factor of 2: check the target and the grid');
		expect(s.iterations.map((i) => i.step)).toEqual(['start', 'clamped']);
		expect(s.iterations[1]!.s).toBe(2);
		expect(s.best).toBe(s.iterations[1]);
	});

	it('clamps at the lower bound too', () => {
		const s = solveFactor([500], 1, linear(0.02));
		expect(s.status).toBe('not_converged');
		expect(s.iterations[1]!.s).toBe(0.5);
	});

	it('takes a converging step at a bound as converged', () => {
		const s = solveFactor([500], 20, linear(0.02));
		expect(s.status).toBe('converged');
		expect(s.best!.s).toBeCloseTo(2, 12);
	});

	it('keeps every MAP inside the engine range', () => {
		const high = solveFactor([7000, 100], 1000, (maps) => 0.01 * (maps[0]! + maps[1]!));
		for (const it of high.iterations) expect(Math.max(...it.maps)).toBeLessThanOrEqual(MAP_LIMITS_MM.high + 1e-9);
		expect(high.status).toBe('not_converged');
		expect(high.message).toMatch(/1–12000 mm/);
		const low = solveFactor([1.5, 2000], 0.001, (maps) => 0.01 * (maps[0]! + maps[1]!));
		for (const it of low.iterations) expect(Math.min(...it.maps)).toBeGreaterThanOrEqual(MAP_LIMITS_MM.low - 1e-9);
	});

	it('starts inside the MAP range when the grid is outside it, and refuses when no factor fits', () => {
		const s = solveFactor([13000], 100, (maps) => 0.01 * maps[0]!);
		expect(s.iterations[0]!.step).toBe('clamped');
		expect(s.iterations[0]!.s).toBeCloseTo(12000 / 13000, 12);
		expect(solveFactor([0.1, 13000], 100, (maps) => maps[1]!).status).toBe('refused');
	});

	it('bisects when the secant leaves the bracket', () => {
		// A cliff then a plateau: the ratio step lands on the plateau, and the secant along it points far outside [1, 2].
		const kink = (maps: readonly number[]) => {
			const m = maps[0]!;
			return m < 1200 ? 10 : m < 1400 ? 10 + (m - 1200) / 10 : 30 + (m - 1400) * 0.001;
		};
		const s = solveFactor([1000], 20, kink);
		expect(s.iterations.some((i) => i.step === 'bisect')).toBe(true);
		expect(s.status).toBe('converged');
	});

	it('bisects a flat secant inside a bracket', () => {
		const stepResponse = (maps: readonly number[]) => (maps[0]! < 1000 ? 5 : 20);
		const s = solveFactor([800], 10, stepResponse); // MAR 5, ratio → s = 2 (20), secant …
		expect(s.iterations.length).toBeLessThanOrEqual(MAX_EVALUATIONS);
		expect(s.status).toBe('not_converged');
		expect(s.iterations.some((i) => i.step === 'bisect')).toBe(true);
	});

	it('goes to the bound on a flat secant with no bracket, and fails there', () => {
		const s = solveFactor([500], 10, () => 1); // flat
		expect(s.status).toBe('not_converged');
		expect(s.iterations.length).toBeLessThanOrEqual(3);
	});

	it('hits the cap with the best iteration and every step logged', () => {
		// Runoff jumps across the target with no value within 2 %: only the cap ends it.
		const s = solveFactor([800], 10, (maps) => (maps[0]! < 1001 ? 5 : 15));
		expect(s.status).toBe('not_converged');
		expect(s.iterations).toHaveLength(MAX_EVALUATIONS);
		expect(s.message).toMatch(/12 runs/);
		expect(Math.abs(s.best!.errorPct)).toBe(Math.min(...s.iterations.map((i) => Math.abs(i.errorPct))));
	});

	it('terminates within the cap and is converged only within 2 % (invariant 7)', () => {
		const random = seededRandom(7);
		for (let k = 0; k < 400; k++) {
			const shape = random();
			const scale = 0.0001 + random() * 0.01;
			const power = 1 + random() * 3;
			const jump = random() < 0.3 ? random() * 50 : 0;
			const mapsAtOne = [200 + random() * 2000, 200 + random() * 2000, 200 + random() * 2000];
			const target = random() * 200 + 0.001;
			let calls = 0;
			const mar = (maps: readonly number[]) => {
				calls++;
				const m = maps.reduce((a, b) => a + b, 0) / 3;
				return shape < 0.1 ? 0 : scale * m ** power + (m > 800 ? jump : 0);
			};
			const s = solveFactor(mapsAtOne, target, mar);
			expect(calls).toBeLessThanOrEqual(MAX_EVALUATIONS);
			if (s.status === 'converged') expect(Math.abs(s.best!.marMm3 - target) / target).toBeLessThanOrEqual(0.02);
			for (const it of s.iterations) {
				expect(it.s).toBeGreaterThanOrEqual(0.5);
				expect(it.s).toBeLessThanOrEqual(2);
				expect(Math.abs(it.maps[0]! / it.maps[1]! - mapsAtOne[0]! / mapsAtOne[1]!)).toBeLessThan(1e-12);
			}
		}
	});
});

describe('calibrateMap on the real module', () => {
	const bundle = exampleBundle();
	const plan = examplePlan();

	it('reaches a reachable target within 2 %, with the rounded MAR recomputed', () => {
		const start = calibrateMap(bundle, plan, hand(1));
		const reachable = start.iterations[0]!.marMm3 * 0.8;
		const result = contract.c(bundle, plan, hand(reachable));
		expect(result.status).toBe('converged');
		expect(result.message).toBeNull();
		expect(result.iterations.length).toBeLessThanOrEqual(MAX_EVALUATIONS);
		expect(Math.abs(result.finalMarMm3! - reachable) / reachable).toBeLessThanOrEqual(0.02);
		expect(result.finalMapsMm.every(Number.isInteger)).toBe(true);
		expect(result.finalMapsMm[0]! / result.finalMapsMm[1]!).toBeCloseTo(820 / 610, 2);
	});

	it('compares natural runs: land use and the rest of the network do not move MAR', () => {
		const a = calibrateMap(bundle, plan, hand(1));
		const stripped: NetworkBundle = {
			...bundle,
			modules: bundle.modules.map((m) => (m.kind === 'RU' ? { ...m, afforestation: { ...m.afforestation, areaKm2: [] }, paved: { fraction: [] } } : m))
		};
		const b = calibrateMap(stripped, plan, hand(1));
		expect(a.iterations[0]!.marMm3).toBe(b.iterations[0]!.marMm3);
	});

	it('uses the .RAN years before extension, whatever the run period', () => {
		const series = Object.values(bundle.rainfall)[0]!;
		const original = { startYear: series.rows[0]!.year, endYear: series.rows.at(-1)!.year };
		expect(calibrateMap(bundle, plan, hand(1)).period).toEqual(original);
		const extended: NetworkBundle = {
			...bundle,
			network: { ...bundle.network, startYear: 1995 },
			sidecar: {
				schema: 'pitman-sidecar',
				schemaVersion: 1,
				rainfallExtensions: { [Object.keys(bundle.rainfall)[0]!]: { originalEndYear: 2005 } as RainfallExtension }
			}
		};
		const shorter = calibrateMap(extended, plan, hand(1));
		expect(shorter.period).toEqual({ startYear: 1990, endYear: 2005 });
		expect(shorter.iterations[0]!.marMm3).not.toBe(calibrateMap(bundle, plan, hand(1)).iterations[0]!.marMm3);
	});

	it('refuses, without throwing, what it can not run', () => {
		const hughes: NetworkBundle = { ...bundle, modules: bundle.modules.map((m) => (m.kind === 'RU' && m.number === 3 ? { ...m, groundwaterModel: 1 as const } : m)) };
		const r = calibrateMap(hughes, plan, hand(10));
		expect(r.status).toBe('refused');
		expect(r.message).toMatch(/Hughes/);
		expect(r.best).toBeNull();
		expect(r.finalMarMm3).toBeNull();
		expect(calibrateMap(bundle, examplePlan({ module: { type: 'RU', number: 99 } }), hand(10)).status).toBe('refused');
		expect(calibrateMap(bundle, examplePlan({ module: { type: 'RV', number: 2 } }), hand(10)).status).toBe('refused');
		expect(calibrateMap(bundle, examplePlan({ pieces: [piece('zone', 1, 500)] }), hand(10)).status).toBe('refused');
	});

	it('reports a target out of reach as not converged, with the best factor and its rounded MAPs', () => {
		const r = calibrateMap(bundle, plan, hand(1e6));
		expect(r.status).toBe('not_converged');
		expect(r.message).toMatch(/factor of 2/);
		expect(r.best).not.toBeNull();
		expect(r.finalMapsMm).toEqual(r.best!.maps.map((m) => Math.round(m)));
		expect(r.finalMarMm3).not.toBeNull();
	});

	it('keeps the grid ratio through the real loop (invariant 2)', () => {
		const start = calibrateMap(bundle, plan, hand(1)).iterations[0]!.marMm3;
		for (const it of calibrateMap(bundle, plan, hand(start * 0.6)).iterations) expect(Math.abs(it.maps[0]! / it.maps[1]! - 820 / 610)).toBeLessThan(1e-12);
	});
});

describe('roundedResult', () => {
	const period = { startYear: 1990, endYear: 2009 };
	const steep = (maps: readonly number[]) => maps[0]! ** 4; // a small MAP, so whole mm matters

	it('reports a rounded MAR past 2 %, never as converged (invariant 7)', () => {
		const search = solveFactor([2.4], steep([2.4]), steep);
		expect(search.status).toBe('converged');
		const r = roundedResult(search, steep([2.4]), steep, period);
		expect(r.status).toBe('not_converged');
		expect(r.message).toMatch(/rounding the MAPs to whole mm/);
		expect(r.finalMapsMm).toEqual([2]);
		expect(r.finalMarMm3).toBe(16);
		expect(r.best).toBe(search.best);
	});

	it('leaves a result inside 2 % alone', () => {
		const search = solveFactor([820, 610], 24, toy);
		const r = roundedResult(search, 24, toy, period);
		expect(r.status).toBe('converged');
		expect(r.finalMapsMm).toEqual([765, 569]);
		expect(Math.abs(r.finalMarMm3! - 24) / 24).toBeLessThanOrEqual(0.02);
	});

	it('passes a refusal through with no MAPs', () => {
		const r = roundedResult(solveFactor([500], 10, () => 0), 10, () => 0, period);
		expect(r.status).toBe('refused');
		expect(r.finalMapsMm).toEqual([]);
		expect(r.finalMarMm3).toBeNull();
	});
});

describe('unsplitNaturalMar', () => {
	const bundle = exampleBundle();

	it('is the module natural MAR over the same period, and with one piece at its MAP it matches the calibration start', () => {
		const { marMm3, period } = contract.u(bundle, { type: 'RU', number: 3 });
		expect(marMm3).toBeGreaterThan(0);
		expect(period).toEqual({ startYear: 1990, endYear: 2009 });
		const same = examplePlan({ pieces: [piece('tributary', 120, 640), piece('remainder', 280, 640)] });
		expect(calibrateMap(bundle, same, hand(marMm3)).iterations[0]!.marMm3).toBeCloseTo(marMm3, 9);
	});

	it('answers for the whole quaternary once the module is split', () => {
		const { marMm3 } = unsplitNaturalMar(bundle, { type: 'RU', number: 3 });
		const same = examplePlan({ pieces: [piece('tributary', 120, 640), piece('remainder', 280, 640)], shares: { afforestation: 'area', alien: 'area', dams: 'area' } });
		const target = hand(marMm3);
		const split = applySplit(bundle, same, { calibration: calibrateMap(bundle, same, target), target, crossCheck: target });
		expect(unsplitNaturalMar(split, { type: 'RU', number: 16 }).marMm3).toBeCloseTo(marMm3, 9);
		expect(unsplitNaturalMar(split, { type: 'RU', number: 3 }).marMm3).toBeCloseTo(marMm3, 9);
	});

	it('agrees with the natural mode of the whole run', () => {
		const series = run(bundle, { kind: 'natural' }).runoff![3]!.netRunoff!.values;
		expect(unsplitNaturalMar(bundle, { type: 'RU', number: 3 }).marMm3).toBeCloseTo(series.reduce((a, b) => a + b, 0) / 20, 9);
	});

	it('refuses a sidecar that lists a piece the network does not hold', () => {
		const { marMm3 } = unsplitNaturalMar(bundle, { type: 'RU', number: 3 });
		const same = examplePlan({ pieces: [piece('tributary', 120, 640), piece('remainder', 280, 640)], shares: { afforestation: 'area', alien: 'area', dams: 'area' } });
		const target = hand(marMm3);
		const split = applySplit(bundle, same, { calibration: calibrateMap(bundle, same, target), target, crossCheck: target });
		const broken = { ...split, modules: split.modules.filter((m) => !(m.kind === 'RU' && m.number === 16)) };
		expect(() => unsplitNaturalMar(broken, { type: 'RU', number: 3 })).toThrow(/no such module/);
	});

	it('throws for anything but a runoff module', () => {
		expect(() => unsplitNaturalMar(bundle, { type: 'RV', number: 2 })).toThrow(/not a runoff module/);
	});
});
