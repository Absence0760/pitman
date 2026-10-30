import { describe, expect, it } from 'vitest';
import { exampleBundle } from '../subdivide/fixtures.js';
import type { DamRecord, ModuleRef, NetworkBundle, ReservoirModule } from '../types.js';
import { DAM_DEPTH_M, DEFAULT_MATCH_RADIUS_M, MIN_DAM_AREA_KM2, applyDams, damAreaKm2, damsRow, matchDams, overrideDam } from './dams.js';
import type { DamCandidate } from './round7-contract.js';

const options = { matchRadiusM: DEFAULT_MATCH_RADIUS_M, fetchedOn: '2026-10-30' };
/** 0.0005° of latitude is about 55 m. */
const dam = (id: string, source: DamCandidate['source'], lat: number, more: Partial<DamCandidate> = {}): DamCandidate => ({ id, source, lon: 21.3, lat, ...more });
const RV: ModuleRef = { type: 'RV', number: 2 };
const rv = (b: NetworkBundle) => b.modules.find((m): m is ReservoirModule => m.kind === 'RV' && m.number === 2)!;
const record = (id: string, capacityMm3: number, areaKm2?: number): DamRecord => ({ id, lon: 21, lat: -34, capacityMm3, ...(areaKm2 === undefined ? {} : { areaKm2 }), source: { kind: 'capeFarmMapper', date: '2026-10-30' } });

describe('matchDams (D4)', () => {
	it('merges one dam’s sources and applies register > CFM > area × 3 m, keeping the others as alternatives', () => {
		const out = matchDams(
			[dam('s', 'surfaceWater', -33.6004, { areaKm2: 0.05 }), dam('c', 'capeFarmMapper', -33.6002, { capacityMm3: 0.11, name: 'Lower dam' }), dam('r', 'register', -33.6, { capacityMm3: 0.1 })],
			options
		);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ id: 'r', lat: -33.6, capacityMm3: 0.1, areaKm2: 0.05, source: { kind: 'damRegister', note: 'r', date: '2026-10-30' } });
		expect(out[0]!.alternatives).toEqual([
			{ capacityMm3: 0.11, source: { kind: 'capeFarmMapper', note: 'Lower dam', date: '2026-10-30' } },
			{ capacityMm3: expect.closeTo(0.15, 10), source: { kind: 'surfaceWater', note: 's: area × 3 m', date: '2026-10-30' } }
		]);
	});

	it('takes CFM over area × 3 m, and area × 3 m alone when that is all there is', () => {
		const [both] = matchDams([dam('c', 'capeFarmMapper', -33.6, { capacityMm3: 0.2 }), dam('s', 'surfaceWater', -33.6, { areaKm2: 1 })], options);
		expect(both).toMatchObject({ capacityMm3: 0.2, source: { kind: 'capeFarmMapper' } });
		const [alone] = matchDams([dam('s', 'surfaceWater', -33.6, { areaKm2: 0.1 })], options);
		expect(alone!.capacityMm3).toBeCloseTo(0.1 * DAM_DEPTH_M, 12);
		expect(alone!.source.kind).toBe('surfaceWater');
		expect(alone!.alternatives).toBeUndefined();
	});

	it('lets a stated capacity beat an area × 3 m even from a later source, and a CFM area counts as area × 3 m', () => {
		const [out] = matchDams([dam('r', 'register', -33.6), dam('c', 'capeFarmMapper', -33.6, { areaKm2: 0.1 }), dam('s', 'surfaceWater', -33.6, { capacityMm3: 0.2 })], options);
		expect(out).toMatchObject({ id: 'r', capacityMm3: 0.2, source: { kind: 'surfaceWater' } });
		expect(out!.alternatives![0]!.source).toMatchObject({ kind: 'capeFarmMapper', note: 'c: area × 3 m' });
	});

	it('lists a dam under the noise floor at no capacity, saying so', () => {
		const [out] = matchDams([dam('s', 'surfaceWater', -33.6, { areaKm2: MIN_DAM_AREA_KM2 / 2 })], options);
		expect(out).toMatchObject({ capacityMm3: 0, source: { kind: 'surfaceWater' } });
		expect(out!.source.note).toMatch(/no capacity/);
		expect(out!.areaKm2).toBeCloseTo(MIN_DAM_AREA_KM2 / 2, 12);
	});

	it('keeps dams apart beyond the radius, and a source’s own dams apart within it', () => {
		expect(matchDams([dam('a', 'register', -33.6), dam('b', 'surfaceWater', -33.61)], options)).toHaveLength(2);
		expect(matchDams([dam('a', 'register', -33.6), dam('b', 'register', -33.6001)], options)).toHaveLength(2);
	});

	it('gives a candidate between two dams to the nearer, each dam taking one per source', () => {
		const out = matchDams([dam('r1', 'register', -33.6), dam('r2', 'register', -33.6015), dam('c1', 'capeFarmMapper', -33.6004, { capacityMm3: 1 }), dam('c2', 'capeFarmMapper', -33.6011, { capacityMm3: 2 })], { ...options, matchRadiusM: 200 });
		expect(out.map((d) => [d.id, d.capacityMm3])).toEqual([['r1', 1], ['r2', 2]]);
	});

	it('doesn’t chain: distance is to the dam’s first candidate', () => {
		const out = matchDams([dam('a', 'register', -33.6), dam('b', 'capeFarmMapper', -33.6012), dam('c', 'surfaceWater', -33.6024)], options);
		expect(out.map((d) => d.id)).toEqual(['a', 'c']);
	});

	it('doesn’t depend on the order it is given', () => {
		const list = [dam('r', 'register', -33.6, { capacityMm3: 1 }), dam('c', 'capeFarmMapper', -33.6004, { capacityMm3: 2 }), dam('d', 'capeFarmMapper', -33.6006, { capacityMm3: 3 }), dam('s', 'surfaceWater', -33.6002, { areaKm2: 1 })];
		expect(matchDams([...list].reverse(), options)).toEqual(matchDams(list, options));
	});

	it('refuses a bad radius or position', () => {
		expect(() => matchDams([], { ...options, matchRadiusM: Number.NaN })).toThrow(/radius/);
		expect(() => matchDams([dam('a', 'register', Number.NaN)], options)).toThrow(/position/);
	});
});

describe('overrideDam (rule 8)', () => {
	it('puts the typed value in force, the replaced one first among the alternatives', () => {
		const [matched] = matchDams([dam('r', 'register', -33.6, { capacityMm3: 0.1 }), dam('s', 'surfaceWater', -33.6, { areaKm2: 0.05 })], options);
		const out = overrideDam(matched!, 0.25, ' Survey by the owner ', '2026-10-31');
		expect(out).toMatchObject({ capacityMm3: 0.25, source: { kind: 'manual', note: 'Survey by the owner', date: '2026-10-31' } });
		expect(out.alternatives!.map((a) => a.source.kind)).toEqual(['damRegister', 'surfaceWater']);
	});

	it('doesn’t keep a capacity of nothing as an alternative', () => {
		expect(overrideDam(record('a', 0), 1, 'typed', '2026-10-31').alternatives).toBeUndefined();
	});

	it('needs a note and a number', () => {
		expect(() => overrideDam(record('a', 1), 1, '  ', '2026-10-31')).toThrow(/note/);
		expect(() => overrideDam(record('a', 1), -1, 'x', '2026-10-31')).toThrow(/capacity/);
	});
});

describe('applyDams', () => {
	const dams = [record('a', 0.126, 0.04), record('b', 0.3)];

	it('sums the row at the file’s precision, a dam with no area taking capacity ÷ 3 m (R7-C6)', () => {
		expect(damAreaKm2(dams[1]!)).toBeCloseTo(0.1, 12);
		expect(damsRow(dams)).toEqual({ fullSupplyVolumeMm3: 0.43, fullSupplyAreaKm2: 0.14 });
		const b = exampleBundle();
		const next = applyDams(b, RV, 2025, dams);
		expect(rv(next).capacity.at(-1)).toEqual({ year: 2025, fullSupplyVolumeMm3: 0.43, fullSupplyAreaKm2: 0.14 });
		expect(rv(next).capacity.map((r) => r.year)).toEqual([...rv(b).capacity.map((r) => r.year), 2025]);
	});

	it('replaces the row of a year it has, and inserts in order', () => {
		const b = exampleBundle();
		const [first] = rv(b).capacity;
		const same = applyDams(b, RV, first!.year, dams);
		expect(rv(same).capacity).toHaveLength(rv(b).capacity.length);
		expect(rv(same).capacity[0]).toEqual({ year: first!.year, fullSupplyVolumeMm3: 0.43, fullSupplyAreaKm2: 0.14 });
		expect(rv(applyDams(b, RV, first!.year + 1, dams)).capacity[1]!.year).toBe(first!.year + 1);
	});

	it('keeps each dam and its source in the sidecar, under the runoff module that feeds the reservoir', () => {
		const next = applyDams(exampleBundle(), RV, 2025, dams);
		expect(next.sidecar?.dams?.map((d) => [d.id, d.module])).toEqual([['a', { type: 'RU', number: 3 }], ['b', { type: 'RU', number: 3 }]]);
		expect(next.sidecar?.dams?.[0]?.source).toEqual(dams[0]!.source);
	});

	it('replaces the module’s dams on a second apply, and leaves another module’s alone', () => {
		const once = applyDams(exampleBundle(), { type: 'RV', number: 8 }, 2025, [record('other', 1)]);
		const twice = applyDams(applyDams(once, RV, 2025, dams), RV, 2025, [record('a', 0.2)]);
		expect(twice.sidecar?.dams?.map((d) => d.id)).toEqual(['other', 'a']);
	});

	it('refuses what it can’t write', () => {
		const b = exampleBundle();
		expect(() => applyDams(b, { type: 'RV', number: 99 }, 2025, dams)).toThrow(/RV 99/);
		expect(() => applyDams(b, { type: 'RR', number: 7 }, 2025, dams)).toThrow(/RR 7/);
		expect(() => applyDams(b, RV, 2025, [])).toThrow(/no dams/);
		expect(() => applyDams(b, RV, 25.5, dams)).toThrow(/year/);
		expect(() => applyDams(b, RV, 2025, [record('a', Number.NaN)])).toThrow(/capacity/);
	});
});
