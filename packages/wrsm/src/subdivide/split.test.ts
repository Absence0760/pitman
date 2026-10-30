import { describe, expect, it } from 'vitest';

import { readBundle, sameData, writeBundle, type LoadedBundle } from '../io/bundle.js';
import { placeModules } from '../network/modules.js';
import { validateNetwork } from '../network/validate.js';
import { run } from '../run.js';
import type { AreaGeometry } from '../extend/contract.js';
import type { IrrigationModule, IrrigationWqtLayout, Module, NetworkBundle, ReservoirModule, RunoffModule } from '../types.js';
import { calibrateMap, planNaturalMar, unsplitNaturalMar } from './calibrate.js';
import type { ApplySplit, ApplySplitOptions, CalibrationResult, PiecePlan, PreviewSplit, SplitPlan } from './contract.js';
import { exampleBundle, examplePlan, hand, piece, samiBlock } from './fixtures.js';
import { SubdivisionError } from './pieces.js';
import { applySplit, mergePieces, previewSplit } from './split.js';

// The functions implement the contract's types exactly: a mismatch fails the typecheck.
export const contract: { apply: ApplySplit; preview: PreviewSplit } = { apply: applySplit, preview: previewSplit };

const ru = (b: NetworkBundle, n: number) => b.modules.find((m): m is RunoffModule => m.kind === 'RU' && m.number === n)!;
const rv = (b: NetworkBundle, n: number) => b.modules.find((m): m is ReservoirModule => m.kind === 'RV' && m.number === n)!;
const rr = (b: NetworkBundle, n: number) => b.modules.find((m): m is IrrigationModule => m.kind === 'RR' && m.number === n)!;
const ALL_AREA = { afforestation: 'area', alien: 'area', dams: 'area' } as const;

/** The route's ends as `RU3`-style names (`.NET` positions are positions). */
function ends(b: NetworkBundle, route: number): [string, string] {
	const r = b.network.routes.find((x) => x.number === route)!;
	const name = (p: number) => (p === 0 ? '0' : `${b.network.modules[p - 1]!.type}${b.network.modules[p - 1]!.number}`);
	return [name(r.upstreamPosition), name(r.downstreamPosition)];
}

/** A calibration that takes the given MAPs as its answer, for tests about the rewiring: the factor from the first piece, the MAR what those MAPs give. */
function acceptMaps(bundle: NetworkBundle, plan: SplitPlan, maps: readonly number[]): CalibrationResult {
	const siblings = bundle.sidecar?.subdivisions?.[plan.quaternary]?.pieces.filter((p) => p.number !== plan.module.number) ?? [];
	const grid = [...plan.pieces.map((p) => p.gridMapMm), ...siblings.map((p) => p.gridMapMm)];
	const s = maps[0]! / grid[0]!;
	const finalMarMm3 = maps.length === grid.length ? planNaturalMar(bundle, plan, maps) : 10;
	const iteration = { n: 0, s, maps: grid.map((g) => g * s), marMm3: finalMarMm3, errorPct: 0, step: 'start' as const };
	return { status: 'converged', message: null, iterations: [iteration], best: iteration, finalMapsMm: maps, finalMarMm3, period: { startYear: 1990, endYear: 2009 } };
}

function options(bundle: NetworkBundle, plan: SplitPlan, maps: readonly number[]): ApplySplitOptions {
	const calibration = acceptMaps(bundle, plan, maps);
	return { calibration, target: hand(calibration.finalMarMm3!), crossCheck: { marMm3: 10, source: 'unsplit module, natural run' } };
}

const applyMaps = <B extends NetworkBundle>(bundle: B, plan: SplitPlan, maps: readonly number[]): B => applySplit(bundle, plan, options(bundle, plan, maps));

/** The real calibration against the unsplit module's own natural MAR. */
function selfCalibrated(bundle: NetworkBundle, plan: SplitPlan): ApplySplitOptions {
	const { marMm3 } = unsplitNaturalMar(bundle, plan.module);
	const target = hand(marMm3);
	return { calibration: calibrateMap(bundle, plan, target), target, crossCheck: target };
}

/** Invariant 5 on any bundle. */
function expectSoundNetwork(b: NetworkBundle): void {
	expect(validateNetwork(b).filter((m) => m.level === 'error')).toEqual([]);
	for (const m of b.modules) if (m.kind === 'RU') expect(Math.abs(m.outflows.reduce((s, o) => s + o.percent, 0) - 100)).toBeLessThanOrEqual(0.05 * m.outflows.length);
	const numbers = b.network.routes.map((r) => r.number);
	expect(new Set(numbers).size).toBe(numbers.length);
	const keys = b.network.modules.map((e) => `${e.type}${e.number}`);
	expect(new Set(keys).size).toBe(keys.length);
	expect(placeModules(b).every((p) => p.module !== undefined)).toBe(true);
	expect(b.modules).toHaveLength(keys.length);
}

/** Every field the module holds reads back the same (the writer adds blocks a test module left out, as it does upgrading a file). */
function expectWritten(module: Module, read: Module): void {
	for (const [key, value] of Object.entries(module)) {
		if (value !== undefined) expect(sameData((read as unknown as Record<string, unknown>)[key], value), `${module.kind} ${module.number} ${key}`).toBe(true);
	}
}

function roundTrip(b: NetworkBundle): LoadedBundle {
	const result = readBundle(writeBundle(b));
	if (!result.ok) throw new Error(result.errors.map((e) => `${e.file}: ${e.message}`).join('\n'));
	return result.bundle;
}

describe('the worked example', () => {
	const bundle = exampleBundle();
	const plan = examplePlan();
	const applied = applyMaps(bundle, plan, [765, 569]);

	it('makes T module RU 16, before RU 3, with the MAPs and areas of the spec', () => {
		const t = ru(applied, 16);
		expect(t.areaKm2).toBe(120);
		expect(t.mapMm).toBe(765);
		expect(ru(applied, 3).areaKm2).toBe(280);
		expect(ru(applied, 3).mapMm).toBe(569);
		const list = applied.network.modules.map((e) => `${e.type}${e.number}`);
		expect(list.indexOf('RU16')).toBeLessThan(list.indexOf('RU3'));
		expect(list.indexOf('RV9')).toBeLessThan(list.indexOf('RU3'));
		expect(list.indexOf('RU16')).toBe(list.indexOf('RU3') - 2);
	});

	it('gives T a copy of the farm dams, RV 9, and routes 65, 66 and 67', () => {
		const t = ru(applied, 16);
		expect(t.outflows).toEqual([
			{ route: 65, percent: 40 },
			{ route: 66, percent: 60 }
		]);
		expect(ends(applied, 65)).toEqual(['RU16', 'RV9']);
		expect(ends(applied, 66)).toEqual(['RU16', 'CR4']);
		expect(ends(applied, 67)).toEqual(['RV9', 'CR4']);
		const v = rv(applied, 9);
		expect(v.spillRoute).toBe(67);
		expect(v.inflows).toEqual([{ route: 65, definedFlowFile: null }]);
		expect(v.outflows).toEqual([{ route: 67, definedFlowFile: null }]);
		expect(v.capacity[0]!.fullSupplyVolumeMm3).toBe(2);
		expect(v.capacity[0]!.fullSupplyAreaKm2).toBe(0.4);
		expect(v.mapMm).toBe(rv(bundle, 2).mapMm);
		expect(v.panMm).toEqual(rv(bundle, 2).panMm);
	});

	it('leaves RU 3 its routes 10 and 11 and RV 2 the other four dams', () => {
		expect(ru(applied, 3).outflows).toEqual(ru(bundle, 3).outflows);
		expect(ends(applied, 10)).toEqual(['RU3', 'RV2']);
		expect(ends(applied, 11)).toEqual(['RU3', 'CR4']);
		expect(ends(applied, 12)).toEqual(['RV2', 'CR4']);
		expect(rv(applied, 2).capacity[0]!.fullSupplyVolumeMm3).toBe(4);
		expect(rv(applied, 2).capacity[0]!.fullSupplyAreaKm2).toBe(0.8);
		const cr = applied.modules.find((m) => m.kind === 'CR')!;
		expect(cr.kind === 'CR' && cr.inflows.map((c) => c.route)).toEqual([11, 12, 64, 66, 67]);
	});

	it('shares the 12.0 km² of afforestation by location: 3.0 in T, 9.0 in R, every year', () => {
		expect(ru(applied, 16).afforestation.areaKm2.map((r) => r.value)).toEqual([3, 3]);
		expect(ru(applied, 3).afforestation.areaKm2.map((r) => r.value)).toEqual([9, 9]);
	});

	it('writes the sidecar entry in the shape the spec gives', () => {
		const entry = applied.sidecar!.subdivisions!['Z01A']!;
		expect(entry.method).toBe('subdivide-1');
		expect(entry.module).toEqual({ type: 'RU', number: 3, areaKm2: 400, mapMm: 640 });
		expect(entry.splits).toEqual(plan.splits);
		expect(entry.pieces).toEqual([
			{ role: 'tributary', number: 16, polygonKm2: 121.1, areaKm2: 120, gridMapMm: 820, mapMm: 765, mapSource: 'grid' },
			{ role: 'outlet', number: 3, polygonKm2: 282.6, areaKm2: 280, gridMapMm: 610, mapMm: 569, mapSource: 'grid' }
		]);
		expect(entry.grid).toEqual(plan.grid);
		expect(entry.calibration.target).toEqual(hand(entry.calibration.finalMarMm3));
		expect(entry.calibration.status).toBe('converged');
		expect(entry.calibration.period).toEqual([1990, 2009]);
		expect(entry.shares).toEqual({ afforestation: 'location', alien: 'area', dams: 'location' });
		expect(entry.farmDamPercent).toBe('original');
	});

	it('does not change the bundle it was given', () => {
		const before = JSON.stringify(bundle);
		applyMaps(bundle, plan, [765, 569]);
		expect(JSON.stringify(bundle)).toBe(before);
	});

	it('records the natural MAR of the MAPs as saved, through a repeat split too', () => {
		const recorded = (b: NetworkBundle) => b.sidecar!.subdivisions!['Z01A']!.calibration.finalMarMm3;
		expect(recorded(applied)).toBeCloseTo(unsplitNaturalMar(applied, { type: 'RU', number: 3 }).marMm3, 9);
		const located = { locationShares: { afforestation: 0.5, damCapacity: 0.5 } };
		const again = examplePlan({ pieces: [piece('zone', 80, 900, located), piece('rest', 200, 560, located)], layout: 'sideBySide', splits: [{ kind: 'zone-drawn' }] });
		const two = applyMaps(applied, again, [810, 504, 738]);
		expect(recorded(two)).not.toBeCloseTo(recorded(applied), 3);
		expect(recorded(two)).toBeCloseTo(unsplitNaturalMar(two, { type: 'RU', number: 16 }).marMm3, 9);
		expect(recorded(roundTrip(two))).toBeCloseTo(unsplitNaturalMar(roundTrip(two), { type: 'RU', number: 3 }).marMm3, 9);
		// With the real loop the rounded MAPs give a different MAR from the iteration they round.
		const small = examplePlan({ pieces: [piece('tributary', 121.1, 820.4), piece('remainder', 282.6, 610.4)], shares: { afforestation: 'area', alien: 'area', dams: 'area' } });
		const opts = selfCalibrated(bundle, small);
		const real = applySplit(bundle, small, opts);
		expect(recorded(real)).not.toBe(opts.calibration.best!.marMm3);
		expect(recorded(real)).toBeCloseTo(unsplitNaturalMar(real, { type: 'RU', number: 3 }).marMm3, 9);
	});

	it('moves a located dam of the sidecar to the piece it lies in', () => {
		const north: AreaGeometry = { type: 'Polygon', coordinates: [[[20, -33.9], [20.2, -33.9], [20.2, -33.8], [20, -33.8], [20, -33.9]]] };
		const south: AreaGeometry = { type: 'Polygon', coordinates: [[[20, -34], [20.2, -34], [20.2, -33.9], [20, -33.9], [20, -34]]] };
		const dam = (id: string, lat: number) => ({ id, lon: 20.1, lat, module: { type: 'RU', number: 3 } as const, capacityMm3: 1, source: { kind: 'manual' as const } });
		const dammed: NetworkBundle = { ...bundle, sidecar: { schema: 'pitman-sidecar', schemaVersion: 1, dams: [dam('a', -33.85), dam('b', -33.95), dam('c', -40)] } };
		const located = examplePlan({ pieces: plan.pieces.map((p, i) => ({ ...p, geometry: i === 0 ? north : south })) });
		const numbers = applyMaps(dammed, located, [765, 569]).sidecar!.dams!.map((d) => d.module!.number);
		expect(numbers).toEqual([16, 3, 3]); // a dam in neither polygon stays where it was
	});

	it('previews the same numbers, in plain language, without a calibration', () => {
		const preview = previewSplit(bundle, plan);
		expect(preview.pieces).toEqual([
			{ role: 'tributary', module: { type: 'RU', number: 16 }, areaKm2: 120, outlet: false },
			{ role: 'remainder', module: { type: 'RU', number: 3 }, areaKm2: 280, outlet: true }
		]);
		expect(preview.changes.join('\n')).toMatch(/RU 16/);
		expect(preview.changes.join('\n')).toMatch(/Route 65: RU 16 → RV 9 \(40 %\)/);
		expect(preview.messages).toContain('Afforestation is shared by location.');
	});
});

describe('invariants', () => {
	const bundle = exampleBundle({ irrigation: true, initialStorageMm3: 3.001 });

	it('5: the network stays sound, including through writeBundle and readBundle', () => {
		const plan = examplePlan();
		const applied = applyMaps(bundle, plan, [765, 569]);
		expectSoundNetwork(applied);
		const back = roundTrip(applied);
		expectSoundNetwork(back);
		expect(back.network.modules).toEqual(applied.network.modules);
		expect(back.network.routes).toEqual(applied.network.routes);
		// Every RU, RV and CR reads back as it was written. An RR of the old layout is upgraded on write (R2-5).
		for (const m of applied.modules) {
			const read = back.modules.find((x) => x.kind === m.kind && x.number === m.number);
			expect(read).toBeDefined();
			if (m.kind !== 'RR') expectWritten(m, read!);
		}
		expect(ru(back, 16).areaKm2).toBe(120);
		expect(ru(back, 16).mapMm).toBe(765);
		expect(rv(back, 9).capacity).toEqual(rv(applied, 9).capacity);
	});

	it('copies a negative initial storage, the 50 % sentinel, to every reservoir', () => {
		const b = exampleBundle({ initialStorageMm3: -1 });
		const split = applyMaps(b, examplePlan(), [765, 569]);
		expect(rv(split, 2).initialStorageMm3).toBe(-1);
		expect(rv(split, 9).initialStorageMm3).toBe(-1);
	});

	it('gives initial storage only to pieces with dams, and none above capacity (R5-E4)', () => {
		const b = exampleBundle({ initialStorageMm3: 6 });
		const shared = examplePlan({ pieces: [piece('tributary', 100, 800, { locationShares: { damCapacity: 0, afforestation: 0.5 } }), piece('remainder', 300, 600, { locationShares: { damCapacity: 1, afforestation: 0.5 } })] });
		expect(rv(applyMaps(b, shared, [800, 600]), 2).initialStorageMm3).toBe(6);
		const withDams = (capacity: number, area: number, initialStorageMm3: number) => ({
			...b,
			modules: b.modules.map((m) => (m.kind === 'RV' && m.number === 2 ? { ...m, capacity: m.capacity.map((c) => ({ ...c, fullSupplyVolumeMm3: capacity, fullSupplyAreaKm2: area })), initialStorageMm3 } : m))
		});
		const three = examplePlan({ pieces: [piece('tributary', 100, 800), piece('tributary', 100, 800), piece('remainder', 200, 600)], shares: ALL_AREA });
		const split = applyMaps(withDams(0.05, 1.2, 0.05), three, [800, 800, 600]);
		const reservoirs = [2, 9, 10].map((n) => rv(split, n));
		expect(reservoirs.map((v) => v.initialStorageMm3)).toEqual(reservoirs.map((v) => Math.min(v.capacity[0]!.fullSupplyVolumeMm3, v.initialStorageMm3!)));
		expect(reservoirs.some((v) => v.capacity[0]!.fullSupplyVolumeMm3 === 0.01)).toBe(true); // the cap has work to do
		// A share above zero that rounds to no capacity: T has no reservoir, so all the water stays in R's.
		const twenty = examplePlan({ pieces: [piece('tributary', 80, 800), piece('remainder', 320, 600)], shares: ALL_AREA });
		const small = applyMaps(withDams(0.02, 0.01, 0.02), twenty, [800, 600]);
		expect(rv(small, 9)).toBeUndefined();
		expect(rv(small, 2).initialStorageMm3).toBe(0.02);
		// No piece has any capacity: the storage stays on the reservoir there is.
		expect(rv(applyMaps(withDams(0, 0, 0.5), twenty, [800, 600]), 2).initialStorageMm3).toBe(0.5);
	});

	it('saves a Sami split so it runs the same after writeBundle and readBundle', () => {
		const base = exampleBundle();
		const m = ru(base, 3);
		const sami = { ...samiBlock({ ...m.pitman, GW: 0, GL: 0 }), abstractions: [], abstractionMode: 0 as const };
		const b: NetworkBundle = { ...base, modules: base.modules.map((x) => (x === m ? { ...m, groundwaterModel: 2 as const, sami } : x)) };
		const plan = examplePlan({ pieces: [piece('tributary', 121.1, 820), piece('remainder', 282.6, 610)], shares: ALL_AREA });
		const opts = selfCalibrated(b, plan);
		expect(opts.calibration.status).toBe('converged');
		const split = applySplit(b, plan, opts);
		const back = roundTrip(split);
		expectWritten(ru(split, 16), ru(back, 16));
		const natural = { kind: 'natural' } as const;
		expect(run(back, natural).routeFlows[5]!.values).toEqual(run(split, natural).routeFlows[5]!.values);
		// What was calibrated is what was saved.
		expect(unsplitNaturalMar(back, { type: 'RU', number: 3 }).marMm3).toBeCloseTo(opts.calibration.finalMarMm3!, 9);
	});

	it('the sidecar round-trips byte for byte through its writer and reader', () => {
		const applied = applyMaps(bundle, examplePlan(), [765, 569]);
		const back = roundTrip(applied);
		expect(sameData(back.sidecar, applied.sidecar)).toBe(true);
		const again = writeBundle(back);
		expect(again['pitman.json']).toBe(writeBundle(applied)['pitman.json']);
	});

	it('saves a split of a network loaded from files under the names WRSM2000 will look for', () => {
		const loaded = roundTrip(bundle);
		const applied = applyMaps(loaded, examplePlan(), [765, 569]);
		const files = writeBundle(applied);
		expect(Object.keys(files)).toEqual(expect.arrayContaining(['Z1RU16.DAT', 'Z1RV9.DAT', 'Z1RR8.DAT', 'pitman.json']));
		const back = readBundle(files);
		expect(back.ok).toBe(true);
		if (back.ok) expectSoundNetwork(back.bundle);
	});

	it('3: every split table keeps its total, year by year', () => {
		const plan = examplePlan({ pieces: [piece('tributary', 1, 700), piece('tributary', 2, 800), piece('remainder', 4, 600)], shares: ALL_AREA });
		const sami = samiBlock(ru(bundle, 3).pitman);
		const start: NetworkBundle = {
			...bundle,
			modules: bundle.modules.map((m) =>
				m.kind === 'RU' && m.number === 3
					? {
							...m,
							afforestation: { ...m.afforestation, areaKm2: [{ year: 1990, value: 12.1 }, { year: 2000, value: 17.3 }, { year: 2009, value: 0.5 }] },
							alienVegetation: { algorithm: 1 as const, riparianArea: 0, areaKm2: [{ year: 1990, value: 7.7 }], composition: { tallTrees: { percent: 100, ageYears: 5 }, mediumTrees: { percent: 0, ageYears: 5 }, tallShrubs: { percent: 0, ageYears: 5 } }, optimalPercent: 50 },
							sami
						}
					: m
			)
		};
		const applied = applyMaps(start, plan, [700, 800, 600]);
		const pieces = [16, 17, 3].map((n) => ru(applied, n));
		const original = ru(start, 3);
		const tenths = (x: number) => Math.round(x * 10);
		original.afforestation.areaKm2.forEach((row, k) => expect(pieces.reduce((s, p) => s + tenths(p.afforestation.areaKm2[k]!.value), 0)).toBe(tenths(row.value)));
		original.alienVegetation!.areaKm2.forEach((row, k) => expect(pieces.reduce((s, p) => s + tenths(p.alienVegetation!.areaKm2[k]!.value), 0)).toBe(tenths(row.value)));
		// Paved is a fraction of the catchment, so the area it stands for is kept with the fraction unchanged (R5-E2).
		original.paved!.fraction.forEach((row, k) => expect(pieces.reduce((s, p) => s + p.areaKm2 * p.paved!.fraction[k]!.value, 0)).toBeCloseTo(original.areaKm2 * row.value, 9));
		sami.abstractions.forEach((row, k) => expect(pieces.reduce((s, p) => s + Math.round(p.sami!.abstractions[k]!.value * 1000), 0)).toBe(Math.round(row.value * 1000)));
		expect(pieces.reduce((s, p) => s + Math.round(p.sami!.gwEvaporationArea * 100), 0)).toBe(1200);

		const dams = [rv(applied, 2), rv(applied, 9), rv(applied, 10)];
		rv(start, 2).capacity.forEach((row, k) => {
			expect(dams.reduce((s, v) => s + Math.round(v.capacity[k]!.fullSupplyVolumeMm3 * 100), 0)).toBe(Math.round(row.fullSupplyVolumeMm3 * 100));
			expect(dams.reduce((s, v) => s + Math.round(v.capacity[k]!.fullSupplyAreaKm2 * 100), 0)).toBe(Math.round(row.fullSupplyAreaKm2 * 100));
		});
		expect(dams.reduce((s, v) => s + Math.round(v.initialStorageMm3! * 1000), 0)).toBe(3001);

		const blocks = [rr(applied, 7), rr(applied, 8), rr(applied, 9)];
		rr(start, 7).areaKm2.forEach((row, k) => expect(blocks.reduce((s, b) => s + Math.round(b.areaKm2[k]!.value * 100), 0)).toBe(Math.round(row.value * 100)));
	});

	it('3: RRMA and the allocation table keep their totals, and IRRSW names the piece', () => {
		const b = exampleBundle({ irrigation: 'wqt' });
		const plan = examplePlan({ pieces: [piece('tributary', 100, 700), piece('tributary', 100, 800), piece('remainder', 200, 600)], shares: ALL_AREA });
		const split = applyMaps(b, plan, [700, 800, 600]);
		const blocks = [rr(split, 8), rr(split, 9), rr(split, 7)].map((m) => m as IrrigationWqtLayout);
		expect(blocks.reduce((s, m) => s + Math.round(m.maxAllocationMm3PerYear * 100), 0)).toBe(333);
		for (const k of [0, 1]) expect(blocks.reduce((s, m) => s + Math.round(m.allocation.values[k]!.value * 1000), 0)).toBe(1001);
		expect(blocks.map((m) => m.runoffModule)).toEqual([16, 17, 3]);
		expect(blocks[0]!.maxAllocationMm3PerYear).toBeLessThan(1);
		expect(blocks[0]!.allocation.values[0]!.value).toBeLessThan(0.3);
		const back = roundTrip(split);
		for (const m of blocks) expectWritten(m, rr(back, m.number));
		expectSoundNetwork(back);
	});

	it('3: a piece too small to get a block takes no part of its allocation', () => {
		const b = exampleBundle({ irrigation: 'wqt' });
		const tiny = { ...b, modules: b.modules.map((m) => (m.kind === 'RR' ? { ...m, areaKm2: m.areaKm2.map((row) => ({ ...row, value: 0.02 })) } : m)) };
		const plan = examplePlan({ pieces: [piece('tributary', 10, 700), piece('remainder', 390, 600)], shares: ALL_AREA });
		const split = applyMaps(tiny, plan, [700, 600]);
		expect(split.modules.filter((m) => m.kind === 'RR')).toHaveLength(1);
		const block = rr(split, 7) as IrrigationWqtLayout;
		expect(block.maxAllocationMm3PerYear).toBe(3.33);
		expect(block.allocation.values.map((row) => row.value)).toEqual([1.001, 1.001]);
	});

	it('4: every piece reads the original .RAN and zone', () => {
		const applied = applyMaps(bundle, examplePlan(), [765, 569]);
		expect(ru(applied, 16).rainfallFile).toBe(ru(bundle, 3).rainfallFile);
		expect(ru(applied, 3).rainfallFile).toBe(ru(bundle, 3).rainfallFile);
		expect(Object.keys(applied.rainfall)).toEqual(Object.keys(bundle.rainfall));
	});

	it('copies every intensive field unchanged', () => {
		const applied = applyMaps(bundle, examplePlan(), [765, 569]);
		const a = ru(applied, 16);
		const b = ru(bundle, 3);
		for (const key of ['pitman', 'sPanMm', 'panFactors', 'fileVersion', 'groundwaterModel', 'aPanFactors', 'naturalised', 'paved'] as const) expect(a[key]).toEqual(b[key]);
		expect(a.afforestation.species).toEqual(b.afforestation.species);
		expect(a.afforestation.optimalPercent).toEqual(b.afforestation.optimalPercent);
		expect(a.afforestation.algorithm).toBe(b.afforestation.algorithm);
	});

	describe('6: equivalence', () => {
		const sameMaps = (b: NetworkBundle, p: readonly number[], extra: Partial<SplitPlan> = {}) => {
			const map = ru(b, 3).mapMm;
			return examplePlan({ pieces: p.map((a, i) => piece(i === p.length - 1 ? 'remainder' : 'tributary', a, map)), shares: ALL_AREA, ...extra });
		};
		const natural = { kind: 'natural' } as const;
		const sumOutflow = (b: NetworkBundle, numbers: readonly number[]) => {
			const r = run(b, natural);
			const months = r.runoff![numbers[0]!]!.netRunoff!.values.length;
			return Array.from({ length: months }, (_, i) => numbers.reduce((s, n) => s + r.runoff![n]!.netRunoff!.values[i]!, 0));
		};
		const expectSame = (a: readonly number[], b: readonly number[], tolerance: number) => {
			expect(a).toHaveLength(b.length);
			a.forEach((v, i) => expect(Math.abs(v - b[i]!)).toBeLessThanOrEqual(tolerance));
		};

		it('with every MAP the module MAP, summed natural runoff matches month by month, classic groundwater', () => {
			const b = exampleBundle();
			const plan = sameMaps(b, [120, 280]);
			const split = applySplit(b, plan, selfCalibrated(b, plan));
			expect(split.sidecar!.subdivisions!['Z01A']!.calibration.factor).toBe(1);
			expect(ru(split, 3).mapMm).toBe(640);
			expectSame(sumOutflow(split, [16, 3]), sumOutflow(b, [3]), 1e-12);
		});

		it('holds for eight pieces at the network outlet route, not just the runoff', () => {
			const b = exampleBundle();
			const plan = sameMaps(b, [10, 20, 30, 40, 50, 60, 70, 120], { layout: 'sideBySide', pieces: [10, 20, 30, 40, 50, 60, 70, 120].map((a, i) => piece(i === 7 ? 'rest' : 'zone', a, 640)) });
			const split = applySplit(b, plan, selfCalibrated(b, plan));
			expectSoundNetwork(split);
			expect(run(split, natural).routeFlows[5]!.values.length).toBe(run(b, natural).routeFlows[5]!.values.length);
			expectSame(run(split, natural).routeFlows[5]!.values, run(b, natural).routeFlows[5]!.values, 1e-9);
		});

		it('holds for a Sami module, the area-dependent terms scaled (R5-E1)', () => {
			const base = exampleBundle();
			const m = ru(base, 3);
			const sami = { ...samiBlock({ ...m.pitman, GW: 0, GL: 0 }), abstractions: [], abstractionMode: 0 as const };
			const b: NetworkBundle = { ...base, modules: base.modules.map((x) => (x === m ? { ...m, groundwaterModel: 2 as const, sami } : x)) };
			// 144 and 256 of 400: √(A_i/A) is 0.6 and 0.8, so HGRAD and EVAREA are exact at the file's precision and only floating point is left.
			const plan = sameMaps(b, [144, 256]);
			const split = applySplit(b, plan, selfCalibrated(b, plan));
			expect(ru(split, 16).sami!.maxHydraulicGradient).toBeCloseTo(0.0006, 12);
			expect(ru(split, 3).sami!.maxHydraulicGradient).toBeCloseTo(0.0008, 12);
			expect(ru(split, 16).sami!.gwEvaporationArea).toBeCloseTo(4.32, 12);
			expectSame(sumOutflow(split, [16, 3]), sumOutflow(b, [3]), 1e-9);
		});

		it('for a Sami module at any split, the residue is HGRAD and EVAREA at the file precision', () => {
			const base = exampleBundle();
			const m = ru(base, 3);
			const residue = (gwEvaporationArea: number) => {
				const sami = { ...samiBlock({ ...m.pitman, GW: 0, GL: 0 }), abstractions: [], abstractionMode: 0 as const, gwEvaporationArea };
				const b: NetworkBundle = { ...base, modules: base.modules.map((x) => (x === m ? { ...m, groundwaterModel: 2 as const, sami } : x)) };
				const plan = sameMaps(b, [120, 280]);
				const split = applySplit(b, plan, selfCalibrated(b, plan));
				const whole = sumOutflow(b, [3]);
				return Math.max(...sumOutflow(split, [16, 3]).map((v, i) => Math.abs(v - whole[i]!)));
			};
			// 8 km² splits exactly (2.4 and 5.6), leaving HGRAD alone; 0.05 km² rounds to 0.02 and 0.03.
			expect(residue(8)).toBeLessThan(5e-8);
			expect(residue(0.05)).toBeGreaterThan(residue(8));
			expect(residue(0.05)).toBeLessThan(1e-6);
		});

		it('holds for an SFR parent, whose children go with it', () => {
			const b = withChild(exampleBundle());
			const plan = sameMaps(b, [120, 280]);
			const split = applySplit(b, plan, selfCalibrated(b, plan));
			expectSame(sumOutflow(split, [16, 3]), sumOutflow(b, [3]), 1e-12);
		});
	});

	it('8: merging the pieces gives back the original fields', () => {
		const b = withChild(exampleBundle());
		const m = ru(b, 3);
		const sami = samiBlock(m.pitman);
		const start: NetworkBundle = { ...b, modules: b.modules.map((x) => (x === m ? { ...m, sami: { ...sami, abstractions: [{ year: 1990, value: 0.7 }] } } : x)) };
		const plan = examplePlan({ pieces: [piece('tributary', 13, 800), piece('tributary', 7, 900), piece('remainder', 40, 600)], shares: ALL_AREA });
		const split = applyMaps(start, plan, [800, 900, 600]);
		const { module, children } = mergePieces(split, 'Z01A');
		expect(module).toEqual(ru(start, 3));
		expect(children).toHaveLength(1);
		expect(children[0]).toEqual(ru(start, 11));
	});

	it('8: merging refuses a quaternary with no sub-division', () => {
		expect(() => mergePieces(bundle, 'Z99Z')).toThrow(SubdivisionError);
	});
});

/** RU 3 as an SFR parent of RU 11 (afforestation) on a route to the zero sink. */
function withChild(b: NetworkBundle): NetworkBundle {
	const m = ru(b, 3);
	const child: RunoffModule = {
		...m,
		number: 11,
		name: 'Plantation child',
		areaKm2: 12.1,
		mapMm: 800,
		afforestation: { ...m.afforestation, algorithm: 2, areaKm2: [{ year: 1990, value: 12.1 }] },
		paved: { fraction: [] },
		outflows: [{ route: 30, percent: 100 }],
		inflowRoute: 0
	};
	const positionOf3 = b.network.modules.findIndex((e) => e.type === 'RU' && e.number === 3);
	const list = [...b.network.modules];
	list.splice(positionOf3 + 1, 0, { number: 11, type: 'RU', solve: true });
	const shift = (p: number) => (p > positionOf3 + 1 ? p + 1 : p);
	return {
		...b,
		network: {
			...b.network,
			modules: list,
			routes: [...b.network.routes.map((r) => ({ ...r, upstreamPosition: shift(r.upstreamPosition), downstreamPosition: shift(r.downstreamPosition) })), { number: 30, upstreamPosition: positionOf3 + 2, downstreamPosition: 0, cost: 0 }]
		},
		modules: b.modules.flatMap((x): Module[] => (x === m ? [{ ...m, afforestation: { ...m.afforestation, areaKm2: [] }, sfrChildren: [11] }, child] : [x]))
	};
}

describe('SFR parents and children', () => {
	const b = withChild(exampleBundle());

	it('gives each piece its own child by share, with the MAP ratio kept and the table total kept', () => {
		const plan = examplePlan({ pieces: [piece('tributary', 100, 800), piece('remainder', 300, 600)], shares: ALL_AREA });
		const split = applyMaps(b, plan, [800, 600]);
		expectSoundNetwork(split);
		expect(ru(split, 16).sfrChildren).toEqual([17]);
		expect(ru(split, 3).sfrChildren).toEqual([11]);
		const [a, c] = [ru(split, 17), ru(split, 11)];
		expect(a.areaKm2 + c.areaKm2).toBeCloseTo(12.1, 9);
		expect(a.areaKm2).toBe(3);
		expect(c.areaKm2).toBe(9.1);
		expect(a.afforestation.areaKm2[0]!.value + c.afforestation.areaKm2[0]!.value).toBeCloseTo(12.1, 9);
		expect(a.mapMm).toBe(Math.round((800 * 800) / 640));
		expect(c.mapMm).toBe(Math.round((600 * 800) / 640));
		expect(ends(split, a.outflows[0]!.route)).toEqual(['RU17', '0']);
		expect(split.sidecar!.subdivisions!['Z01A']!.children).toEqual([{ number: 11, areaKm2: 12.1, mapMm: 800, pieces: [17, 11] }]);
	});

	it('does not create a child whose share rounds to no area', () => {
		const small: NetworkBundle = { ...b, modules: b.modules.map((m) => (m.kind === 'RU' && m.number === 11 ? { ...m, areaKm2: 0.2, afforestation: { ...m.afforestation, areaKm2: [{ year: 1990, value: 0.2 }] } } : m)) };
		const plan = examplePlan({ pieces: [piece('tributary', 10, 800), piece('remainder', 390, 600)], shares: ALL_AREA });
		const split = applyMaps(small, plan, [800, 600]);
		expect(ru(split, 16).sfrChildren).toEqual([]);
		expect(ru(split, 3).sfrChildren).toEqual([11]);
		expect(ru(split, 11).areaKm2).toBe(0.2);
		expectSoundNetwork(split);
	});

	it('assigns a located child whole to one piece, the original going with its routes', () => {
		const plan = examplePlan({
			pieces: [piece('tributary', 100, 800, { locationShares: { afforestation: 1 } }), piece('remainder', 300, 600, { locationShares: { afforestation: 0 } })],
			shares: { afforestation: 'location', alien: 'area', dams: 'area' }
		});
		const split = applyMaps(b, plan, [800, 600]);
		expect(ru(split, 3).sfrChildren).toEqual([]);
		expect(ru(split, 16).sfrChildren).toEqual([17]);
		expect(ru(split, 11)).toBeUndefined();
		expect(split.network.routes.some((r) => r.number === 30)).toBe(false);
		expect(ru(split, 17).areaKm2).toBe(12.1);
		expectSoundNetwork(split);
		const { children } = mergePieces(split, 'Z01A');
		expect(children[0]).toEqual({ ...ru(b, 11), outflows: ru(split, 17).outflows, name: ru(split, 17).name });
	});

	it('adds a new child\'s route to the module it ends at', () => {
		const m = ru(b, 11);
		const cr = b.modules.find((x) => x.kind === 'CR')!;
		const crPosition = b.network.modules.findIndex((e) => e.type === 'CR') + 1;
		const toChannel: NetworkBundle = {
			...b,
			network: { ...b.network, routes: b.network.routes.map((r) => (r.number === 30 ? { ...r, downstreamPosition: crPosition } : r)) },
			modules: b.modules.map((x) => (x === cr && cr.kind === 'CR' ? { ...cr, inflows: [...cr.inflows, { route: 30, definedFlowFile: null }] } : x))
		};
		expect(ru(toChannel, 11)).toEqual(m);
		const split = applyMaps(toChannel, examplePlan({ pieces: [piece('tributary', 100, 800), piece('remainder', 300, 600)], shares: ALL_AREA }), [800, 600]);
		const route = ru(split, 17).outflows[0]!.route;
		expect(ends(split, route)).toEqual(['RU17', 'CR4']);
		expectSoundNetwork(split);
	});

	it('refuses to split a child on its own', () => {
		const plan = examplePlan({ module: { type: 'RU', number: 11 } });
		expect(previewSplit(b, plan).messages[0]).toMatch(/SFR child of RU 3/);
	});
});

describe('layouts', () => {
	const bundle = exampleBundle();

	it('side by side: the outlet is the larger piece, ties to the rest', () => {
		const zone = (z: number, r: number, extra: Partial<SplitPlan> = {}) => examplePlan({ layout: 'sideBySide', pieces: [piece('zone', z, 800), piece('rest', r, 600)], shares: ALL_AREA, ...extra });
		expect(previewSplit(bundle, zone(100, 300)).pieces.map((p) => p.outlet)).toEqual([false, true]);
		expect(previewSplit(bundle, zone(300, 100)).pieces.map((p) => p.outlet)).toEqual([true, false]);
		expect(previewSplit(bundle, zone(200, 200)).pieces.map((p) => p.outlet)).toEqual([false, true]);
	});

	it('side by side: a piece with no dams sends 100 % past them', () => {
		const plan = examplePlan({ layout: 'sideBySide', pieces: [piece('zone', 100, 800, { locationShares: { damCapacity: 0, afforestation: 0 } }), piece('rest', 300, 600, { locationShares: { damCapacity: 1, afforestation: 1 } })] });
		const split = applyMaps(bundle, plan, [800, 600]);
		expect(ru(split, 16).outflows).toEqual([{ route: 65, percent: 100 }]);
		expect(ends(split, 65)).toEqual(['RU16', 'CR4']);
		expect(split.modules.filter((m) => m.kind === 'RV')).toHaveLength(2); // no new reservoir
		expect(rv(split, 2).capacity).toEqual(rv(bundle, 2).capacity);
		expectSoundNetwork(split);
	});

	it('series, no dams in T: one route T → X at 100 %', () => {
		const plan = examplePlan({ pieces: [piece('tributary', 100, 800, { locationShares: { damCapacity: 0, afforestation: 0.5 } }), piece('remainder', 300, 600, { locationShares: { damCapacity: 1, afforestation: 0.5 } })] });
		const split = applyMaps(bundle, plan, [800, 600]);
		expect(ru(split, 16).outflows).toEqual([{ route: 65, percent: 100 }]);
		expect(ends(split, 65)).toEqual(['RU16', 'CR4']);
	});

	it('keeps every dam out of nothing: all the dams in T leaves RV 2 with no capacity, said out loud', () => {
		const plan = examplePlan({ pieces: [piece('tributary', 100, 800, { locationShares: { damCapacity: 1, afforestation: 0.5 } }), piece('remainder', 300, 600, { locationShares: { damCapacity: 0, afforestation: 0.5 } })] });
		expect(previewSplit(bundle, plan).messages.join(' ')).toMatch(/No dams are left in RU 3/);
		const split = applyMaps(bundle, plan, [800, 600]);
		expect(rv(split, 2).capacity[0]!.fullSupplyVolumeMm3).toBe(0);
		expectSoundNetwork(split);
		expect(() => run(split, { kind: 'historical' })).not.toThrow();
	});

	it('a route whose RU has no bypass (p = 100) is still the pattern', () => {
		const b = noBypass(bundle);
		const split = applyMaps(b, examplePlan(), [765, 569]);
		expect(ru(split, 16).outflows).toEqual([{ route: 65, percent: 100 }]);
		expect(ends(split, 65)).toEqual(['RU16', 'RV9']);
		expect(ends(split, 66)).toEqual(['RV9', 'CR4']);
		expectSoundNetwork(split);
	});

	it('series with no farm-dam pattern: one route to where the largest outflow ends, listed for the user', () => {
		const b = noDams(bundle);
		const plan = examplePlan({ shares: { afforestation: 'location', alien: 'area', dams: 'area' } });
		const preview = previewSplit(b, plan);
		expect(preview.changes.join(' ')).toMatch(/doesn't match the farm-dam pattern.*Please confirm/);
		const split = applyMaps(b, plan, [765, 569]);
		expect(ru(split, 16).outflows).toEqual([{ route: 65, percent: 100 }]);
		expect(ends(split, 65)).toEqual(['RU16', 'CR4']);
		expectSoundNetwork(split);
	});

	it('side by side with no pattern: the same destinations at the same percentages', () => {
		const b = twoDestinations(bundle);
		const plan = examplePlan({ layout: 'sideBySide', pieces: [piece('zone', 100, 800), piece('rest', 300, 600)], shares: ALL_AREA });
		const split = applyMaps(b, plan, [800, 600]);
		expect(ru(split, 16).outflows.map((o) => o.percent)).toEqual([40, 60]);
		expect(ends(split, 71)).toEqual(['RU16', 'CR4']);
		expect(ends(split, 72)).toEqual(['RU16', '0']);
		expectSoundNetwork(split);
	});

	it('sends the inflow route of M to the outlet piece', () => {
		const b = rtin(bundle);
		const plan = examplePlan();
		const split = applyMaps(b, plan, [765, 569]);
		expect(ru(split, 3).inflowRoute).toBe(70);
		expect(ru(split, 16).inflowRoute).toBe(0);
		expect(ends(split, 70)).toEqual(['RU14', 'RU3']);
		expectSoundNetwork(split);
	});

	it('when M feeds another RU module, the piece joins through the outlet (B1, R5-E5), and natural flow is unchanged', () => {
		const b = feedsRunoff(bundle);
		const plan = examplePlan({ pieces: [piece('tributary', 120, 640), piece('remainder', 280, 640)], shares: ALL_AREA });
		const preview = previewSplit(b, plan);
		expect(preview.changes.join(' ')).toMatch(/flows into RU 3\. Please confirm/);
		const split = applySplit(b, plan, selfCalibrated(b, plan));
		expect(ru(split, 3).inflowRoute).toBe(72);
		expect(ends(split, 72)).toEqual(['RU16', 'RU3']);
		expectSoundNetwork(split);
		const natural = { kind: 'natural' } as const;
		run(split, natural).routeFlows[71]!.values.forEach((v, i) => expect(Math.abs(v - run(b, natural).routeFlows[71]!.values[i]!)).toBeLessThanOrEqual(1e-9));
	});

	it('chains several pieces into the outlet when each must join by an inflow route', () => {
		const b = feedsRunoff(bundle);
		const plan = examplePlan({ pieces: [piece('tributary', 100, 640), piece('tributary', 100, 640), piece('remainder', 200, 640)], shares: ALL_AREA });
		const split = applyMaps(b, plan, [640, 640, 640]);
		expect(ru(split, 16).outflows).toEqual([{ route: 72, percent: 100 }]);
		expect(ends(split, 72)).toEqual(['RU16', 'RU17']);
		expect(ends(split, 73)).toEqual(['RU17', 'RU3']);
		expectSoundNetwork(split);
	});

	it('merges a join back: the original had no inflow route (invariant 8)', () => {
		const b = feedsRunoff(bundle);
		const plan = examplePlan({ pieces: [piece('tributary', 100, 640), piece('tributary', 100, 640), piece('remainder', 200, 640)], shares: ALL_AREA });
		const split = applyMaps(b, plan, [640, 640, 640]);
		expect(ru(split, 3).inflowRoute).toBe(73);
		expect(mergePieces(split, 'Z01A').module).toEqual(ru(b, 3));
	});

	it('keeps a real inflow route when merging', () => {
		const b = rtin(bundle);
		const split = applyMaps(b, examplePlan(), [765, 569]);
		expect(mergePieces(split, 'Z01A').module.inflowRoute).toBe(70);
	});

	it('refuses a join through a file version with no inflow route', () => {
		const b = feedsRunoff(bundle);
		const old = { ...b, modules: b.modules.map((m) => (m.kind === 'RU' && m.number === 3 ? { ...m, fileVersion: 2 as const } : m)) };
		expect(previewSplit(old, examplePlan({ shares: ALL_AREA })).messages[0]).toMatch(/file version 2 has no inflow route/);
	});

	it('refuses when a piece has nowhere to join', () => {
		const b = rtin(feedsRunoff(bundle));
		const plan = examplePlan({ shares: ALL_AREA });
		expect(previewSplit(b, plan).messages[0]).toMatch(/can't be connected/);
	});
});

describe('irrigation', () => {
	const bundle = exampleBundle({ irrigation: true });

	it('gives a piece with irrigation its own RR, drawing from its own dams, its return flow where the original went', () => {
		const split = applyMaps(bundle, examplePlan(), [765, 569]);
		const copy = rr(split, 8);
		expect(copy.areaKm2.map((r) => r.value)).toEqual([1.5, 1.5]);
		expect(rr(split, 7).areaKm2.map((r) => r.value)).toEqual([3.51, 3.51]);
		const [from, to] = ends(split, copy.abstractionRoute);
		expect([from, to]).toEqual(['RV9', 'RR8']);
		expect(ends(split, copy.returnFlowRoute)).toEqual(['RR8', 'CR4']);
		expect(rv(split, 9).outflows.map((o) => o.route)).toContain(copy.abstractionRoute);
		const list = split.network.modules.map((e) => `${e.type}${e.number}`);
		expect(list.indexOf('RR8')).toBeLessThan(list.indexOf('RV9'));
		expectSoundNetwork(split);
		expect(split.sidecar!.subdivisions!['Z01A']!.shares.irrigation).toBe('area');
	});

	it('goes by located irrigation when every piece gives it, and a piece with none gets no RR', () => {
		const plan = examplePlan({
			pieces: [piece('tributary', 100, 800, { locationShares: { damCapacity: 0.5, afforestation: 0.5, irrigation: 0 } }), piece('remainder', 300, 600, { locationShares: { damCapacity: 0.5, afforestation: 0.5, irrigation: 1 } })]
		});
		const split = applyMaps(bundle, plan, [800, 600]);
		expect(split.modules.filter((m) => m.kind === 'RR')).toHaveLength(1);
		expect(rr(split, 7).areaKm2).toEqual(rr(bundle, 7).areaKm2);
		expect(split.sidecar!.subdivisions!['Z01A']!.shares.irrigation).toBe('location');
	});

	it('moves the block with its routes when all of it lies in another piece', () => {
		const plan = examplePlan({
			pieces: [piece('tributary', 100, 800, { locationShares: { damCapacity: 0.5, afforestation: 0.5, irrigation: 1 } }), piece('remainder', 300, 600, { locationShares: { damCapacity: 0.5, afforestation: 0.5, irrigation: 0 } })]
		});
		const split = applyMaps(bundle, plan, [800, 600]);
		expect(rr(split, 7)).toBeUndefined();
		expect(split.network.routes.some((r) => r.number === 20 || r.number === 21)).toBe(false);
		expect(rv(split, 2).outflows.map((o) => o.route)).toEqual([12]);
		expectSoundNetwork(split);
	});

	it('draws from the original dams when the piece has none of its own', () => {
		const plan = examplePlan({
			pieces: [piece('tributary', 100, 800, { locationShares: { damCapacity: 0, afforestation: 0.5, irrigation: 0.5 } }), piece('remainder', 300, 600, { locationShares: { damCapacity: 1, afforestation: 0.5, irrigation: 0.5 } })]
		});
		const split = applyMaps(bundle, plan, [800, 600]);
		expect(ends(split, rr(split, 8).abstractionRoute)).toEqual(['RV2', 'RR8']);
		expectSoundNetwork(split);
	});

	it('never splits a main-stem reservoir or a channel reach', () => {
		const split = applyMaps(bundle, examplePlan(), [765, 569]);
		expect(split.modules.filter((m) => m.kind === 'CR')).toHaveLength(1);
		expect(rv(split, 8)).toEqual(rv(bundle, 8));
	});
});

describe('repeated splits', () => {
	const bundle = exampleBundle();

	const first = () => {
		const plan = examplePlan({ pieces: [piece('tributary', 120, 800), piece('remainder', 280, 600)], shares: ALL_AREA });
		return applySplit(bundle, plan, selfCalibrated(bundle, plan));
	};
	const again = (module: number, pieces: readonly PiecePlan[]) =>
		examplePlan({ module: { type: 'RU', number: module }, pieces, layout: 'sideBySide', splits: [{ kind: 'zone-drawn' }], shares: ALL_AREA });

	it('splits a piece again, calibrating every piece with one factor', () => {
		const one = first();
		const plan = again(3, [piece('zone', 80, 900), piece('rest', 200, 560)]);
		const { marMm3 } = unsplitNaturalMar(one, { type: 'RU', number: 3 });
		const target = hand(marMm3);
		const calibration = calibrateMap(one, plan, target);
		expect(calibration.status).toBe('converged');
		expect(calibration.finalMapsMm).toHaveLength(3);
		const two = applySplit(one, plan, { calibration, target, crossCheck: target });
		expectSoundNetwork(two);
		const entry = two.sidecar!.subdivisions!['Z01A']!;
		expect(entry.module.number).toBe(3);
		expect(entry.module.mapMm).toBe(640);
		expect(entry.splits).toHaveLength(2);
		expect(entry.pieces.map((p) => p.number)).toEqual([16, 17, 3]);
		expect(entry.pieces.map((p) => p.role)).toEqual(['tributary', 'zone', 'outlet']);
		expect(entry.pieces.map((p) => p.gridMapMm)).toEqual([800, 900, 560]);
		expect(ru(two, 16).mapMm).toBe(calibration.finalMapsMm[2]);
		const areas = [16, 17, 3].map((n) => ru(two, n).areaKm2);
		expect(areas.reduce((a, b) => a + b, 0)).toBeCloseTo(400, 9);
		const best = calibration.best!;
		expect(best.maps[0]! / best.maps[2]!).toBeCloseTo(900 / 800, 12);
	});

	it('keeps the outlet number on the module the first split left, and a piece keeps its role when split', () => {
		const one = first();
		const plan = again(16, [piece('zone', 40, 900), piece('rest', 80, 700)]);
		const two = applyMaps(one, plan, [900, 700, 600]);
		const entry = two.sidecar!.subdivisions!['Z01A']!;
		expect(entry.pieces.map((p) => p.number)).toEqual([17, 16, 3]);
		expect(entry.pieces.map((p) => p.role)).toEqual(['zone', 'tributary', 'outlet']);
		expectSoundNetwork(two);
	});

	it('rescales the other pieces and their children, in the network and the sidecar, and tracks a child split twice', () => {
		const b = withChild(exampleBundle());
		const plan = examplePlan({ pieces: [piece('tributary', 120, 800), piece('remainder', 280, 600)], shares: ALL_AREA });
		const one = applyMaps(b, plan, [800, 600]);
		expect(ru(one, 16).sfrChildren).toEqual([17]);
		const before = ru(one, 17).mapMm;
		const second = again(3, [piece('zone', 80, 900), piece('rest', 200, 560)]);
		const two = applyMaps(one, second, [810, 504, 720]);
		const entry = two.sidecar!.subdivisions!['Z01A']!;
		expect(ru(two, 16).mapMm).toBe(720);
		expect(entry.pieces.find((p) => p.number === 16)!.mapMm).toBe(720);
		expect(ru(two, 17).mapMm).toBe(Math.round((before * 720) / 800));
		expect(entry.children).toEqual([{ number: 11, areaKm2: 12.1, mapMm: 800, pieces: [17, 19, 11] }]);
		expectSoundNetwork(two);
		const { module, children } = mergePieces(two, 'Z01A');
		expect(module).toEqual(ru(b, 3));
		expect(children[0]).toEqual(ru(b, 11));
	});

	it('merges back to the original through two splits', () => {
		const one = first();
		const two = applyMaps(one, again(3, [piece('zone', 80, 900), piece('rest', 200, 560)]), [900, 560, 800]);
		expect(mergePieces(two, 'Z01A').module).toEqual({ ...ru(bundle, 3) });
	});

	describe('irrigation a piece owns on another piece\'s dams', () => {
		const b = exampleBundle({ irrigation: true });
		const locatedShares = { afforestation: 'location', alien: 'area', dams: 'location' } as const;
		const firstPlan = examplePlan({
			pieces: [piece('tributary', 120, 800, { locationShares: { damCapacity: 0, afforestation: 0.5, irrigation: 0.5 } }), piece('remainder', 280, 600, { locationShares: { damCapacity: 1, afforestation: 0.5, irrigation: 0.5 } })]
		});
		const one = applyMaps(b, firstPlan, [800, 600]);
		const owned = rr(one, 8);
		const zones = (module: number, a: number, c: number, irrigation?: readonly [number, number]) =>
			examplePlan({
				module: { type: 'RU', number: module },
				pieces: [piece('zone', a, 900, { locationShares: { damCapacity: 0.5, afforestation: 0.5, ...(irrigation ? { irrigation: irrigation[0] } : {}) } }), piece('rest', c, 560, { locationShares: { damCapacity: 0.5, afforestation: 0.5, ...(irrigation ? { irrigation: irrigation[1] } : {}) } })],
				layout: 'sideBySide',
				splits: [{ kind: 'zone-drawn' }],
				shares: locatedShares
			});

		it('stays whole when its dams are split again', () => {
			expect(ends(one, owned.abstractionRoute)).toEqual(['RV2', 'RR8']);
			const two = applyMaps(one, zones(3, 100, 180), [900, 560, 800]);
			expect(rr(two, 8).areaKm2).toEqual(owned.areaKm2);
			expect(two.sidecar!.subdivisions!['Z01A']!.irrigation).toEqual([
				{ number: 8, piece: 16 },
				{ number: 9, piece: 17 }
			]);
			expect(rr(two, 7).areaKm2[0]!.value + rr(two, 9).areaKm2[0]!.value + rr(two, 8).areaKm2[0]!.value).toBeCloseTo(5.01, 9);
			expectSoundNetwork(two);
		});

		it('splits with its piece, though that piece has no dams to match the pattern', () => {
			const two = applyMaps(one, zones(16, 40, 80), [900, 560, 600]);
			expect(rr(two, 9).areaKm2[0]!.value + rr(two, 8).areaKm2[0]!.value).toBeCloseTo(owned.areaKm2[0]!.value, 9);
			expect(rr(two, 9).areaKm2[0]!.value).toBeGreaterThan(0);
			expect(ends(two, rr(two, 9).abstractionRoute)).toEqual(['RV2', 'RR9']);
			expect(two.sidecar!.subdivisions!['Z01A']!.irrigation).toEqual([
				{ number: 8, piece: 16 },
				{ number: 9, piece: 17 }
			]);
			expectSoundNetwork(two);
		});

		it('leaves the sidecar when the block moves wholly to another piece', () => {
			const two = applyMaps(one, zones(16, 40, 80, [1, 0]), [900, 560, 600]);
			expect(rr(two, 8)).toBeUndefined();
			expect(two.sidecar!.subdivisions!['Z01A']!.irrigation).toEqual([{ number: 9, piece: 17 }]);
			expect(rv(two, 2).outflows.map((o) => o.route)).toContain(rr(two, 9).abstractionRoute);
			expectSoundNetwork(two);
		});
	});

	it('records each later split\'s shares and refuses a second grid or a mixed dam basis', () => {
		const one = first();
		const plan = again(3, [piece('zone', 80, 900), piece('rest', 200, 560)]);
		expect(previewSplit(one, { ...plan, grid: { ...plan.grid, dataset: 'another grid' } }).messages[0]).toMatch(/synthetic grid at 0\.001°.*one grid/);
		expect(previewSplit(one, { ...plan, grid: { ...plan.grid, cellDeg: 0.01 } }).messages[0]).toMatch(/at 0\.001°.*one grid/);
		expect(previewSplit(one, { ...plan, shares: { ...ALL_AREA, dams: 'location' } }).messages[0]).toMatch(/either every dam is located/);
		const located = { ...plan, pieces: plan.pieces.map((p) => ({ ...p, locationShares: { afforestation: 0.5 } })), shares: { ...ALL_AREA, afforestation: 'location' as const } };
		const entry = applyMaps(one, located, [900, 560, 800]).sidecar!.subdivisions!['Z01A']!;
		expect(entry.shares.afforestation).toBe('area');
		expect(entry.laterShares).toEqual([located.shares]);
	});

	it('takes no dam basis to mix when the quaternary has no dams', () => {
		const dry = noDams(bundle);
		const plan = examplePlan({ pieces: [piece('tributary', 120, 800), piece('remainder', 280, 600)], shares: ALL_AREA });
		const one = applyMaps(dry, plan, [800, 600]);
		const second = { ...again(3, [piece('zone', 80, 900), piece('rest', 200, 560)]), shares: { ...ALL_AREA, dams: 'location' as const } };
		expect(previewSplit(one, second).pieces).toHaveLength(2);
	});

	it('refuses a piece of one quaternary split under another, which would dodge one factor and the cap', () => {
		const one = first();
		const stray = { ...again(16, [piece('zone', 40, 900), piece('rest', 80, 700)]), quaternary: 'Z01B' };
		expect(previewSplit(one, stray).messages[0]).toMatch(/RU 16 belongs to Z01A/);
		expect(calibrateMap(one, stray, hand(10)).status).toBe('refused');
		expect(previewSplit(one, { ...stray, module: { type: 'RU', number: 3 } }).messages[0]).toMatch(/RU 3 belongs to Z01A/);
		expect(() => applySplit(one, stray, options(one, stray, [900, 700]))).toThrow(/belongs to Z01A/);
	});

	it('refuses a ninth piece, and a second module in one quaternary', () => {
		const plan = examplePlan({ pieces: Array.from({ length: 9 }, (_, i) => piece(i === 8 ? 'remainder' : 'tributary', 10, 600)), shares: ALL_AREA });
		expect(previewSplit(bundle, plan).messages[0]).toMatch(/at most 8/);
		const seven = examplePlan({ pieces: Array.from({ length: 8 }, (_, i) => piece(i === 7 ? 'remainder' : 'tributary', 10, 600)), shares: ALL_AREA });
		const eight = applyMaps(bundle, seven, Array.from({ length: 8 }, () => 600));
		expect(previewSplit(eight, again(3, [piece('zone', 5, 600), piece('rest', 5, 600)])).messages[0]).toMatch(/9 pieces .*at most 8/);
		expect(previewSplit(first(), again(15, [piece('zone', 5, 600), piece('rest', 5, 600)])).messages[0]).toMatch(/not one of its pieces/);
	});
});

describe('applySplit refuses', () => {
	const bundle = exampleBundle();
	const plan = examplePlan();
	const notConverged: CalibrationResult = { ...acceptMaps(bundle, plan, [765, 569]), status: 'not_converged', message: 'no factor found' };

	it('a calibration that did not converge, unless the user accepted it, and records that it was', () => {
		expect(() => applySplit(bundle, plan, { ...options(bundle, plan, [765, 569]), calibration: notConverged })).toThrow(/did not converge/);
		const taken = applySplit(bundle, plan, { ...options(bundle, plan, [765, 569]), calibration: notConverged, acceptNotConverged: true });
		const { calibration } = taken.sidecar!.subdivisions!['Z01A']!;
		expect(calibration.status).toBe('not_converged');
		expect(calibration.acceptedNotConverged).toBe(true);
	});

	it('a refused calibration, whatever the flag', () => {
		const refused: CalibrationResult = { status: 'refused', message: 'the natural run gives no runoff, so no factor can be found', iterations: [], best: null, finalMapsMm: [], finalMarMm3: null, period: { startYear: 1990, endYear: 2009 } };
		expect(() => applySplit(bundle, plan, { ...options(bundle, plan, [1, 1]), calibration: refused, acceptNotConverged: true })).toThrow(/no runoff/);
	});

	it('a calibration for another target or another plan', () => {
		expect(() => applySplit(bundle, plan, { ...options(bundle, plan, [765, 569]), target: hand(99) })).toThrow(/another target/);
		expect(() => applySplit(bundle, plan, { ...options(bundle, plan, [765, 569]), calibration: notConverged, acceptNotConverged: true, target: hand(99) })).toThrow(/another target/);
		expect(() => applySplit(bundle, plan, options(bundle, plan, [765]))).toThrow(/calibrate this plan again/);
		const mismatched = acceptMaps(bundle, plan, [765, 569]);
		expect(() => applySplit(bundle, plan, { ...options(bundle, plan, [765, 569]), calibration: { ...mismatched, finalMapsMm: [800, 569] } })).toThrow(/don't match/);
	});

	it('a converged result whose rounded MAPs are past 2 %', () => {
		const good = acceptMaps(bundle, plan, [765, 569]);
		const saved = good.finalMarMm3!;
		const target = hand(saved * 1.05);
		const best = { ...good.best!, marMm3: target.marMm3 };
		expect(() => applySplit(bundle, plan, { ...options(bundle, plan, [765, 569]), target, calibration: { ...good, best } })).toThrow(/as saved/);
	});

	it('a split that would break the network', () => {
		const b = definedInflowFirst(exampleBundle());
		expect(validateNetwork(b).filter((m) => m.level === 'error')).toEqual([]);
		const plan = examplePlan({ shares: { afforestation: 'location', alien: 'area', dams: 'area' } });
		expect(() => applyMaps(b, plan, [765, 569])).toThrow(/would break the network: sequence error/);
	});

	it('a calibration made before the boundary moved', () => {
		const moved = examplePlan({ pieces: [piece('tributary', 200, 820, plan.pieces[0]!.locationShares ? { locationShares: plan.pieces[0]!.locationShares } : {}), piece('remainder', 200, 610, plan.pieces[1]!.locationShares ? { locationShares: plan.pieces[1]!.locationShares } : {})] });
		expect(() => applySplit(bundle, moved, options(bundle, plan, [765, 569]))).toThrow(/another plan/);
	});

	it('a location share the plan does not give, or shares that do not add to 1', () => {
		const missing = examplePlan({ pieces: [piece('tributary', 100, 800), piece('remainder', 300, 600)] });
		expect(previewSplit(bundle, missing).messages[0]).toMatch(/by location/);
		const wrong = examplePlan({ pieces: [piece('tributary', 100, 800, { locationShares: { afforestation: 0.5, damCapacity: 0.5 } }), piece('remainder', 300, 600, { locationShares: { afforestation: 0.6, damCapacity: 0.5 } })] });
		expect(previewSplit(bundle, wrong).messages[0]).toMatch(/add up to 1\.1/);
	});
});

describe('previewSplit', () => {
	it('warns when dams round to no surface area', () => {
		const b = exampleBundle();
		const tiny = { ...b, modules: b.modules.map((m) => (m.kind === 'RV' && m.number === 2 ? { ...m, capacity: m.capacity.map((c) => ({ ...c, fullSupplyVolumeMm3: 4, fullSupplyAreaKm2: 0.01 })) } : m)) };
		const plan = examplePlan({ pieces: [piece('tributary', 100, 800), piece('remainder', 300, 600)], shares: ALL_AREA });
		expect(previewSplit(tiny, plan).messages.join(' ')).toMatch(/round to no surface area/);
	});

	it('warns when a gauge sits on a route that leaves the module', () => {
		const bundle = exampleBundle();
		const gauged = { ...bundle, network: { ...bundle.network, gauges: [{ route: 11, label: 'G1', observedFile: 'G1.OBS' }] } };
		expect(previewSplit(gauged, examplePlan()).messages.join(' ')).toMatch(/gauge on route 11/);
	});

	it('does not warn about a gauge when every piece joins through the inflow route, which then carries all the water', () => {
		const b = feedsRunoff(exampleBundle());
		const gauged = { ...b, network: { ...b.network, gauges: [{ route: 11, label: 'G1', observedFile: 'G1.OBS' }] } };
		const { messages } = previewSplit(gauged, examplePlan({ shares: ALL_AREA }));
		expect(messages.join(' ')).not.toMatch(/gauge on route 11 leaves/);
	});

	it('carries the area warning and any new route-limit warning', () => {
		const bundle = exampleBundle();
		const plan = examplePlan({ pieces: Array.from({ length: 8 }, (_, i) => piece(i === 7 ? 'rest' : 'zone', 58, 700)), layout: 'sideBySide', shares: ALL_AREA });
		const { messages } = previewSplit(bundle, plan);
		expect(messages.join(' ')).toMatch(/differs from its boundary by 14 %/);
		expect(messages.join(' ')).toMatch(/Table 2\.1 allows 10/);
	});
});

function noBypass(b: NetworkBundle): NetworkBundle {
	const m = ru(b, 3);
	return editNetwork(b, {
		modules: (x) => (x === m ? { ...m, outflows: [{ route: 10, percent: 100 }] } : x.kind === 'CR' ? { ...x, inflows: x.inflows.filter((c) => c.route !== 11) } : x),
		routes: (r) => r.number !== 11
	});
}

function noDams(b: NetworkBundle): NetworkBundle {
	const m = ru(b, 3);
	const rv2 = rv(b, 2);
	const positions = (x: NetworkBundle) => x.network.modules.findIndex((e) => e.type === 'RV' && e.number === 2) + 1;
	const pos = positions(b);
	const shift = (p: number) => (p > pos ? p - 1 : p);
	return {
		...b,
		network: {
			...b.network,
			modules: b.network.modules.filter((e) => !(e.type === 'RV' && e.number === 2)),
			routes: b.network.routes.filter((r) => r.number !== 10 && r.number !== 12).map((r) => ({ ...r, upstreamPosition: shift(r.upstreamPosition), downstreamPosition: shift(r.downstreamPosition) }))
		},
		modules: b.modules.filter((x) => x !== rv2).map((x) => (x === m ? { ...m, outflows: [{ route: 11, percent: 100 }] } : x.kind === 'CR' ? { ...x, inflows: x.inflows.filter((c) => c.route !== 12) } : x))
	};
}

/** RU 3 sends 40 % out of the network and 60 % to CR 4, no reservoir. */
function twoDestinations(b: NetworkBundle): NetworkBundle {
	const c = noDams(b);
	const m = ru(c, 3);
	const pos = c.network.modules.findIndex((e) => e.type === 'RU' && e.number === 3) + 1;
	return {
		...c,
		network: { ...c.network, routes: [...c.network.routes, { number: 70, upstreamPosition: pos, downstreamPosition: 0, cost: 0 }] },
		modules: c.modules.map((x) => (x === m ? { ...m, outflows: [{ route: 11, percent: 40 }, { route: 70, percent: 60 }] } : x))
	};
}

/** Route 11 into CR 4 reads a defined-flow file, so CR 4 may stand before RU 3: nothing else may be routed in. */
function definedInflowFirst(b: NetworkBundle): NetworkBundle {
	const c = noDams(b);
	const file = 'Z1RQ11.ABS';
	const order = ['RU15', 'RV8', 'CR4', 'RU3'];
	const was = c.network.modules.map((e) => `${e.type}${e.number}`);
	const moved = (p: number) => (p === 0 ? 0 : order.indexOf(was[p - 1]!) + 1);
	return {
		...c,
		network: {
			...c.network,
			modules: order.map((k) => c.network.modules[was.indexOf(k)]!),
			routes: c.network.routes.map((r) => ({ ...r, upstreamPosition: moved(r.upstreamPosition), downstreamPosition: moved(r.downstreamPosition) }))
		},
		modules: c.modules.map((m) => (m.kind === 'CR' ? { ...m, inflows: m.inflows.map((i) => (i.route === 11 ? { ...i, definedFlowFile: file } : i)) } : m)),
		flowFiles: { [file]: { fileName: file, rows: [], hasTotals: false, hasAverage: false } }
	};
}

function editNetwork(b: NetworkBundle, edit: { modules: (m: Module) => Module; routes: (r: NetworkBundle['network']['routes'][number]) => boolean }): NetworkBundle {
	return { ...b, network: { ...b.network, routes: b.network.routes.filter(edit.routes) }, modules: b.modules.map(edit.modules) };
}

/** An upstream RU 14 flows into RU 3 by route 70 (its RTIN). */
function rtin(b: NetworkBundle): NetworkBundle {
	const m = ru(b, 3);
	const up: RunoffModule = { ...ru(b, 15), number: 14, name: 'Above', outflows: [{ route: 70, percent: 100 }] };
	const shift = (p: number) => (p === 0 ? 0 : p + 1);
	const pos3 = b.network.modules.findIndex((e) => e.type === 'RU' && e.number === 3) + 2;
	return {
		...b,
		network: {
			...b.network,
			modules: [{ number: 14, type: 'RU', solve: true }, ...b.network.modules],
			routes: [...b.network.routes.map((r) => ({ ...r, upstreamPosition: shift(r.upstreamPosition), downstreamPosition: shift(r.downstreamPosition) })), { number: 70, upstreamPosition: 1, downstreamPosition: pos3, cost: 0 }]
		},
		modules: [up, ...b.modules.map((x) => (x === m ? { ...m, inflowRoute: 70 } : x))]
	};
}

/** RU 3's whole flow goes by route 11 into RU 13's RTIN; RU 13 goes on by route 71 to CR 4. */
function feedsRunoff(b: NetworkBundle): NetworkBundle {
	const c = noDams(b);
	const m = ru(c, 3);
	const cr = c.modules.find((x) => x.kind === 'CR')!;
	const list = [...c.network.modules];
	const pos = list.findIndex((e) => e.type === 'RU' && e.number === 3) + 1; // 1-based position of RU 3
	list.splice(pos, 0, { number: 13, type: 'RU', solve: true });
	const shift = (p: number) => (p > pos ? p + 1 : p);
	const crPos = list.findIndex((e) => e.type === 'CR') + 1;
	const down: RunoffModule = { ...ru(c, 15), number: 13, name: 'Below', outflows: [{ route: 71, percent: 100 }], inflowRoute: 11 };
	return {
		...c,
		network: {
			...c.network,
			modules: list,
			routes: [
				...c.network.routes.map((r) => (r.number === 11 ? { ...r, upstreamPosition: pos, downstreamPosition: pos + 1 } : { ...r, upstreamPosition: shift(r.upstreamPosition), downstreamPosition: shift(r.downstreamPosition) })),
				{ number: 71, upstreamPosition: pos + 1, downstreamPosition: crPos, cost: 0 }
			]
		},
		modules: c.modules.flatMap((x): Module[] => (x === m ? [m, down] : x === cr && cr.kind === 'CR' ? [{ ...cr, inflows: [...cr.inflows.filter((i) => i.route !== 11), { route: 71, definedFlowFile: null }] }] : [x]))
	};
}
