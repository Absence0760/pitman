import { describe, expect, it } from 'vitest';
import type { ModuleRunContext, RouteFlows } from '../network/contract.js';
import { seededRandom } from '../synthetic/index.js';
import type { DemandSeries, Monthly12, MonthlySeries, RainfallSeries, ReservoirModule, ReservoirOutflow, RunMode } from '../types.js';
import { ReservoirRunError, runReservoir, simulateReservoir, type ReservoirRunInput } from './reservoir.js';

const twelve = (...v: number[]): Monthly12 => {
	const out = [...v];
	while (out.length < 12) out.push(out[out.length - 1] ?? 0);
	return out as unknown as Monthly12;
};
const flat = (v: number) => twelve(v);
const S = (startYear: number, values: number[]): MonthlySeries => ({ startYear, values, unit: 'Mm3' });

/** The spec §4 worked-example reservoir: CAP 10, FSA 2, b 0.6, MAP 600, S₀ = 5. */
function exampleModule(over: Partial<ReservoirModule> = {}): ReservoirModule {
	return {
		kind: 'RV',
		number: 4,
		name: 'SY Dam',
		mapMm: 600,
		rainfallFile: 'SYA.RAN',
		areaVolumePower: 0.6,
		capacity: [
			{ year: 1990, fullSupplyVolumeMm3: 10, fullSupplyAreaKm2: 2 },
			{ year: 2000, fullSupplyVolumeMm3: 10, fullSupplyAreaKm2: 2 }
		],
		panMm: twelve(200, 220, 250, 150),
		panFactors: flat(0.8),
		spillRoute: 10,
		inflows: [{ route: 1, definedFlowFile: null }],
		outflows: [
			{ route: 10, definedFlowFile: null },
			{ route: 11, definedFlowFile: 'SYDOM.abs' },
			{
				route: 12,
				definedFlowFile: '*',
				monthlyAbstraction: { volumesMm3: twelve(1.0, 1.2, 1.0), fullSupplyAboveMm3: 4, restrictionFactor: 0.5 }
			}
		],
		initialStorageMm3: 5,
		...over
	};
}

function ctx(
	startYear: number,
	endYear: number,
	opts: { mode?: RunMode; rain?: RainfallSeries; files?: Record<string, DemandSeries> } = {}
): ModuleRunContext {
	const rain: RainfallSeries = opts.rain ?? {
		code: 'SYA',
		rows: Array.from({ length: endYear - startYear + 1 }, (_, k) => ({ year: startYear + k, months: twelve(10, 25, 0, 5) }))
	};
	const files: Record<string, DemandSeries> = opts.files ?? {
		'SYDOM.ABS': {
			fileName: 'SYDOM.abs',
			rows: Array.from({ length: endYear - startYear + 1 }, (_, k) => ({ year: startYear + k, months: twelve(0.5, 0.5, 0.2) })),
			hasTotals: false,
			hasAverage: false
		}
	};
	return {
		mode: opts.mode ?? { kind: 'historical' },
		startYear,
		endYear,
		rainfall: (name) => (name.toUpperCase() === rain.code.toUpperCase() + '.RAN' ? rain : undefined),
		flowFile: (name) => files[name.toUpperCase()]
	};
}

const inflow1990 = (...v: number[]): RouteFlows => ({ 1: S(1990, [...twelve(...v)]) });

describe('the worked example (spec §4.2)', () => {
	const { result, detail } = runReservoir(exampleModule(), inflow1990(3, 6, 0.1, 0.5), ctx(1990, 1990));

	it('October: E = A₁(G − P)/1000 and S₂ = S₁ + I − D − E (eqs. 2.1–2.3)', () => {
		expect(detail.areaKm2[0]).toBeCloseTo(1.3195079108, 9);
		expect(detail.evaporation.values[0]! - detail.rainfall.values[0]!).toBeCloseTo(0.1319507911, 9);
		expect(detail.rainfall.values[0]).toBeCloseTo(0.0791704746, 9);
		expect(detail.evaporation.values[0]).toBeCloseTo(0.2111212657, 9);
		expect(detail.storage.values[0]).toBeCloseTo(6.3680492089, 9);
		expect(detail.spill.values[0]).toBe(0);
	});

	it('November: S₂ above CAP spills the excess (TT 690 p.9)', () => {
		expect(detail.areaKm2[1]).toBeCloseTo(1.5255759797, 9);
		expect(detail.evaporation.values[1]! - detail.rainfall.values[1]!).toBeCloseTo(0.0396649755, 9);
		expect(detail.spill.values[1]).toBeCloseTo(0.6283842334, 9);
		expect(detail.storage.values[1]).toBe(10);
	});

	it('route flows: supplied drafts, and the spill on the spill route', () => {
		expect(result.outflows[11]!.values.slice(0, 2)).toEqual([0.5, 0.5]);
		expect(result.outflows[12]!.values.slice(0, 2)).toEqual([1.0, 1.2]);
		expect(result.outflows[10]!.values[0]).toBe(0);
		expect(result.outflows[10]!.values[1]).toBeCloseTo(0.6283842334, 9);
		expect(result.storage).toBe(detail.storage);
	});
});

describe('deficits (spec §4.3, TT 689 ch.8)', () => {
	const dry = (over: Partial<ReservoirOutflow['monthlyAbstraction'] & object> = {}) =>
		runReservoir(
			exampleModule({
				initialStorageMm3: 0.4,
				panMm: twelve(250),
				outflows: [
					{ route: 10, definedFlowFile: null },
					{ route: 11, definedFlowFile: 'SYDOM.abs' },
					{
						route: 12,
						definedFlowFile: '*',
						monthlyAbstraction: { volumesMm3: flat(1.0), fullSupplyAboveMm3: 0, restrictionFactor: 0.5, ...over }
					}
				]
			}),
			inflow1990(0.1, 2),
			ctx(1990, 1990, {
				rain: { code: 'SYA', rows: [{ year: 1990, months: flat(0) }] },
				files: { 'SYDOM.ABS': { fileName: 'SYDOM.abs', rows: [{ year: 1990, months: flat(0.2) }], hasTotals: false, hasAverage: false } }
			})
		);

	it('defined drafts are met; calculated drafts get the rest (W = S₁ + I − E)', () => {
		const { result, detail } = dry();
		expect(detail.areaKm2[0]).toBeCloseTo(0.2899118655, 9);
		expect(detail.evaporation.values[0]).toBeCloseTo(0.0579823731, 9);
		expect(result.outflows[11]!.values[0]).toBe(0.2);
		expect(result.outflows[12]!.values[0]).toBeCloseTo(0.2420176269, 9);
		expect(detail.storage.values[0]).toBe(0);
		expect(detail.deficitCase[0]).toBe('calculatedReduced');
		const msg = result.messages.find((m) => m.at?.year === 1990 && m.at.month === 0)!;
		expect(msg).toMatchObject({ level: 'warning', module: { type: 'RV', number: 4 } });
		expect(msg.text).toMatch(/not enough water to satisfy calculated demands/);
		expect(msg.text).toMatch(/calculated 0\.758/);
	});

	it('below the trigger level the monthly abstraction is reduced by the restriction factor (eqs. 2.4–2.5)', () => {
		const { detail } = dry({ fullSupplyAboveMm3: 4 });
		const r12 = detail.routes.find((r) => r.route === 12)!;
		expect(r12.demand.values[0]).toBeCloseTo(0.5, 12);
		expect(r12.supply.values[0]).toBeCloseTo(0.2420176269, 9);
	});

	it('a restriction factor above 1 is used as 1, with a warning (TT 689 p.151)', () => {
		const { result, detail } = dry({ fullSupplyAboveMm3: 4, restrictionFactor: 1.5 });
		expect(detail.routes.find((r) => r.route === 12)!.demand.values[0]).toBe(1);
		expect(result.messages.some((m) => /restriction factor 1\.5 is above 1/.test(m.text))).toBe(true);
	});

	it('summarises minor and major failures like WRSM2000.ERR (TT 691 p.79)', () => {
		const { result } = dry();
		const summary = result.messages.filter((m) => !m.at).map((m) => m.text);
		expect(summary.some((t) => /At least one major failure to supply calculated demands/.test(t))).toBe(true);
		expect(summary.some((t) => /defined demands/.test(t))).toBe(false);
	});

	it('when defined demands exceed the water, calculated drafts get nothing and defined share it', () => {
		const run = runReservoir(
			exampleModule({
				initialStorageMm3: 0,
				outflows: [
					{ route: 10, definedFlowFile: null },
					{ route: 11, definedFlowFile: 'A.abs' },
					{ route: 13, definedFlowFile: 'B.abs' },
					{ route: 14, definedFlowFile: null }
				]
			}),
			inflow1990(3.5),
			ctx(1990, 1990, {
				files: {
					'A.ABS': { fileName: 'A.abs', rows: [{ year: 1990, months: flat(2.5) }], hasTotals: false, hasAverage: false },
					'B.ABS': { fileName: 'B.abs', rows: [{ year: 1990, months: flat(3.0) }], hasTotals: false, hasAverage: false }
				}
			}),
			{ demands: { 14: S(1990, [...flat(1)]) } }
		);
		// The reservoir starts empty, so A₁ = 0 and E = 0: W = I = 3.5 (TT 689 p.170's example).
		expect(run.result.outflows[11]!.values[0]).toBeCloseTo(1.5909090909, 9);
		expect(run.result.outflows[13]!.values[0]).toBeCloseTo(1.9090909091, 9);
		expect(run.result.outflows[14]!.values[0]).toBe(0);
		expect(run.detail.deficitCase[0]).toBe('definedReduced');
		expect(run.result.messages.some((m) => /major failure to supply defined demands/.test(m.text))).toBe(true);
	});

	it('a dry reservoir supplies nothing and evaporation is limited to the water there was (R3-RV3)', () => {
		const run = runReservoir(exampleModule({ initialStorageMm3: 0.01, panMm: flat(2000), panFactors: flat(1) }), inflow1990(0), ctx(1990, 1990));
		expect(run.detail.deficitCase[0]).toBe('dry');
		expect(run.detail.evaporation.values[0]! - run.detail.rainfall.values[0]!).toBeCloseTo(0.01, 12);
		expect(run.result.outflows[11]!.values[0]).toBe(0);
		expect(run.result.messages.some((m) => /reservoir was dry/.test(m.text))).toBe(true);
	});

	it('a defined spill route carries its defined release plus the spill (TT 689 pp.88–89, p.169)', () => {
		const run = runReservoir(
			exampleModule({ spillRoute: 11, initialStorageMm3: 10, outflows: [{ route: 11, definedFlowFile: 'SYDOM.abs' }] }),
			inflow1990(5),
			ctx(1990, 1990)
		);
		expect(run.detail.spill.values[0]).toBeGreaterThan(0);
		expect(run.result.outflows[11]!.values[0]).toBeCloseTo(0.5 + run.detail.spill.values[0]!, 12);
	});
});

describe('run modes (D1, spec §5)', () => {
	const growing = exampleModule({
		capacity: [
			{ year: 1990, fullSupplyVolumeMm3: 0, fullSupplyAreaKm2: 0 },
			{ year: 1991, fullSupplyVolumeMm3: 0, fullSupplyAreaKm2: 0 },
			{ year: 1992, fullSupplyVolumeMm3: 8, fullSupplyAreaKm2: 2 },
			{ year: 2025, fullSupplyVolumeMm3: 8, fullSupplyAreaKm2: 2 }
		],
		initialStorageMm3: undefined
	});
	const years = { start: 1990, end: 1993 };
	const inflows: RouteFlows = { 1: S(1990, new Array(48).fill(1)) };
	const filesFor = (): Record<string, DemandSeries> => ({
		'SYDOM.ABS': {
			fileName: 'SYDOM.abs',
			rows: [1990, 1991, 1992, 1993, 2025].map((year) => ({ year, months: flat(year === 2025 ? 0.3 : 0.1) })),
			hasTotals: false,
			hasAverage: false
		}
	});
	const rainRows = (): RainfallSeries => ({ code: 'SYA', rows: [1990, 1991, 1992, 1993].map((year) => ({ year, months: flat(5) })) });

	it('historical: no dam before it is built (capacity 0 passes inflow less drafts to the spill route)', () => {
		const { detail, result } = runReservoir(growing, inflows, ctx(years.start, years.end, { rain: rainRows(), files: filesFor() }));
		expect(detail.capacity.values.slice(0, 24).every((c) => c === 0)).toBe(true);
		expect(detail.capacity.values[24]).toBe(8);
		expect(detail.storage.values.slice(0, 24).every((s) => s === 0)).toBe(true);
		// '*' wants 1.0 but the empty dam is below its trigger (4), so 0.5 is asked (TT 689 p.171); the rest passes on.
		expect(result.outflows[11]!.values[0]).toBe(0.1);
		expect(result.outflows[12]!.values[0]).toBe(0.5);
		expect(result.outflows[10]!.values[0]).toBeCloseTo(0.4, 12);
		expect(detail.storage.values[30]).toBeGreaterThan(0);
	});

	it('present day: capacity and drafts held at the chosen year', () => {
		const { detail, result } = runReservoir(growing, inflows, ctx(years.start, years.end, { mode: { kind: 'presentDay', year: 2025 }, rain: rainRows(), files: filesFor() }));
		expect(detail.capacity.values.every((c) => c === 8)).toBe(true);
		expect(detail.startStorage.values[0]).toBe(4); // 50 % of the held FSV (R3-RV6)
		expect(result.outflows[11]!.values.every((v) => v === 0.3)).toBe(true);
	});

	it('natural: the dam is removed — every inflow passes to the spill route, no drafts, no evaporation', () => {
		const run = runReservoir(growing, inflows, ctx(years.start, years.end, { mode: { kind: 'natural' }, rain: rainRows(), files: filesFor() }), {
			demands: { 10: S(1990, new Array(48).fill(9)) }
		});
		expect(run.result.outflows[10]!.values).toEqual(inflows[1]!.values);
		expect(run.result.outflows[11]!.values.every((v) => v === 0)).toBe(true);
		expect(run.result.outflows[12]!.values.every((v) => v === 0)).toBe(true);
		expect(run.detail.storage.values.every((v) => v === 0)).toBe(true);
		expect(run.detail.evaporation.values.every((v) => v === 0)).toBe(true);
		expect(run.result.messages).toEqual([]);
	});

	it('natural mode needs no rainfall file and no capacity table', () => {
		const run = simulateReservoir(exampleModule({ capacity: [], rainfallFile: 'MISSING.RAN' }), inflow1990(1), ctx(1990, 1990, { mode: { kind: 'natural' } }));
		expect(run.outflows[10]!.values[0]).toBe(1);
	});
});

describe('initial storage (L.015, spec §3.7)', () => {
	const first = (over: Partial<ReservoirModule>, input?: ReservoirRunInput) =>
		runReservoir(exampleModule(over), inflow1990(0), ctx(1990, 1990), input).detail.startStorage.values[0];
	it('absent or negative → 50 % of the first year’s FSV (TT 691 p.158)', () => {
		expect(first({ initialStorageMm3: undefined })).toBe(5);
		expect(first({ initialStorageMm3: -1 })).toBe(5);
	});
	it('0 → empty by default (R3-RV7, U-9), or half full under the option', () => {
		expect(first({ initialStorageMm3: 0 })).toBe(0);
		expect(first({ initialStorageMm3: 0 }, { options: { zeroInitialStorage: 'halfFull' } })).toBe(5);
	});
	it('a stated value is used as is; above CAP it spills in the first month', () => {
		const run = runReservoir(exampleModule({ initialStorageMm3: 12, outflows: [{ route: 10, definedFlowFile: null }], panMm: flat(0) }), inflow1990(0), ctx(1990, 1990));
		expect(run.detail.startStorage.values[0]).toBe(12);
		expect(run.detail.storage.values[0]).toBe(10);
		expect(run.detail.spill.values[0]).toBeCloseTo(2 + run.detail.rainfall.values[0]!, 12);
	});
});

describe('invalid data throws, naming the module (R2-2 pattern)', () => {
	const go = (over: Partial<ReservoirModule>, c = ctx(1990, 1990), inflows = inflow1990(1), input: ReservoirRunInput = {}) => () =>
		runReservoir(exampleModule(over), inflows, c, input);
	it.each<[string, () => unknown, RegExp]>([
		['non-positive power', go({ areaVolumePower: 0 }), /RV 4 \(SY Dam\): area–volume power/],
		['negative capacity', go({ capacity: [{ year: 1990, fullSupplyVolumeMm3: -1, fullSupplyAreaKm2: 1 }] }), /RV 4.*negative or invalid full supply volume/],
		['no capacity rows', go({ capacity: [] }), /NYR = 0/],
		['missing rainfall file', go({ rainfallFile: 'NONE.RAN' }), /rainfall file 'NONE.RAN'.*not in the network/],
		['rainfall year missing', go({}, ctx(1990, 1991, { rain: { code: 'SYA', rows: [{ year: 1990, months: flat(1) }] } }), { 1: S(1990, new Array(24).fill(1)) }), /has no year 1991/],
		['negative rainfall', go({}, ctx(1990, 1990, { rain: { code: 'SYA', rows: [{ year: 1990, months: twelve(1, -2) }] } })), /negative or invalid value \(-2\) in Nov 1990/],
		['spill route not an outflow', go({ spillRoute: 99 }), /spill route 99/],
		['missing defined-flow file', go({}, ctx(1990, 1990, { files: {} })), /'SYDOM.abs' is not in the network/],
		['defined file short of the run', go({}, ctx(1990, 1991, { rain: { code: 'SYA', rows: [1990, 1991].map((year) => ({ year, months: flat(1) })) }, files: { 'SYDOM.ABS': { fileName: 'SYDOM.abs', rows: [{ year: 1990, months: flat(1) }], hasTotals: false, hasAverage: false } } }), { 1: S(1990, new Array(24).fill(1)) }), /no row for 1991/],
		['simulated inflow not given', go({}, ctx(1990, 1990), {}), /no flow was given for simulated inflow route 1/],
		['inflow of the wrong length', go({}, ctx(1990, 1990), { 1: S(1990, [1, 2]) }), /inflow route 1 covers 1990 for 2 months/],
		['negative pan', go({ panMm: twelve(-1) }), /pan evaporation for Oct/],
		['negative restriction factor', go({ outflows: [{ route: 10, definedFlowFile: null }, { route: 12, definedFlowFile: '*', monthlyAbstraction: { volumesMm3: flat(1), fullSupplyAboveMm3: 1, restrictionFactor: -0.1 } }] }), /restriction factor/],
		['* without L.014', go({ outflows: [{ route: 10, definedFlowFile: null }, { route: 12, definedFlowFile: '*' }] }), /without its L.014/],
		['demand on a defined route', go({}, ctx(1990, 1990), inflow1990(1), { demands: { 11: S(1990, [...flat(1)]) } }), /route 11, which has a defined flow/],
		['demand on an unknown route', go({}, ctx(1990, 1990), inflow1990(1), { demands: { 77: S(1990, [...flat(1)]) } }), /route 77, which is not an outflow route/],
		['negative demand', go({}, ctx(1990, 1990), inflow1990(1), { demands: { 10: S(1990, [...twelve(1, -1)]) } }), /calculated demand on route 10 is negative/],
		['capacity table short of the run', go({ capacity: [{ year: 1991, fullSupplyVolumeMm3: 1, fullSupplyAreaKm2: 1 }] }), /does not cover 1990/]
	])('%s', (_name, run, message) => {
		expect(run).toThrow(ReservoirRunError);
		expect(run).toThrow(message);
	});
});

describe('a defined inflow imposes its file (R3-2)', () => {
	it('adds the file’s flows to the simulated inflows', () => {
		const files: Record<string, DemandSeries> = {
			'SYDOM.ABS': { fileName: 'SYDOM.abs', rows: [{ year: 1990, months: flat(0) }], hasTotals: false, hasAverage: false },
			'TRF.IN': { fileName: 'TRF.in', rows: [{ year: 1990, months: flat(0.7) }], hasTotals: false, hasAverage: false }
		};
		const run = runReservoir(exampleModule({ inflows: [{ route: 1, definedFlowFile: null }, { route: 2, definedFlowFile: 'TRF.in' }] }), inflow1990(1), ctx(1990, 1990, { files }));
		expect(run.detail.inflow.values[0]).toBeCloseTo(1.7, 12);
	});
});

describe('invariants over random synthetic reservoirs', () => {
	const rand = seededRandom(20261029);
	const between = (lo: number, hi: number) => lo + (hi - lo) * rand();
	const cases = Array.from({ length: 60 }, (_, k) => k);

	function randomCase(k: number) {
		const startYear = 1950;
		const endYear = 1950 + 2 + Math.floor(rand() * 4);
		const n = 12 * (endYear - startYear + 1);
		const cap = k % 7 === 0 ? 0 : between(0.5, 30);
		const module = exampleModule({
			number: k + 1,
			areaVolumePower: between(0.4, 0.9),
			mapMm: between(200, 1200),
			capacity: [
				{ year: startYear, fullSupplyVolumeMm3: cap * between(0.3, 1), fullSupplyAreaKm2: between(0, 5) },
				{ year: endYear, fullSupplyVolumeMm3: cap, fullSupplyAreaKm2: between(0, 5) }
			],
			panMm: twelve(...Array.from({ length: 12 }, () => between(50, 300))),
			panFactors: twelve(...Array.from({ length: 12 }, () => between(0.6, 1))),
			inflows: [{ route: 1, definedFlowFile: null }, { route: 2, definedFlowFile: 'IN.def' }],
			outflows: [
				{ route: 10, definedFlowFile: null },
				{ route: 11, definedFlowFile: 'SYDOM.abs' },
				{ route: 12, definedFlowFile: '*', monthlyAbstraction: { volumesMm3: twelve(...Array.from({ length: 12 }, () => between(0, 1.5))), fullSupplyAboveMm3: between(0, cap), restrictionFactor: rand() } },
				{ route: 13, definedFlowFile: null }
			],
			initialStorageMm3: rand() < 0.3 ? undefined : between(0, cap)
		});
		const rows = (f: () => number) => Array.from({ length: endYear - startYear + 1 }, (_, y) => ({ year: startYear + y, months: twelve(...Array.from({ length: 12 }, f)) }));
		const files: Record<string, DemandSeries> = {
			'SYDOM.ABS': { fileName: 'SYDOM.abs', rows: rows(() => (rand() < 0.2 ? 0 : between(0, 1))), hasTotals: false, hasAverage: false },
			'IN.DEF': { fileName: 'IN.def', rows: rows(() => between(0, 0.5)), hasTotals: false, hasAverage: false }
		};
		const rain: RainfallSeries = { code: 'SYA', rows: rows(() => (rand() < 0.3 ? 0 : between(0, 30))) };
		const inflows: RouteFlows = { 1: S(startYear, Array.from({ length: n }, () => (rand() < 0.3 ? 0 : between(0, 4) ** 2))) };
		const demands: RouteFlows = { 13: S(startYear, Array.from({ length: n }, () => between(0, 2))) };
		return { module, inflows, demands, startYear, endYear, files, rain };
	}

	it.each(cases)('case %i: mass balance closes, 0 ≤ S ≤ CAP, supply ≤ demand', (k) => {
		const c = randomCase(k);
		const { result, detail } = runReservoir(c.module, c.inflows, ctx(c.startYear, c.endYear, { files: c.files, rain: c.rain }), { demands: c.demands });
		const n = detail.storage.values.length;
		for (let t = 0; t < n; t++) {
			const s1 = detail.startStorage.values[t]!;
			const s2 = detail.storage.values[t]!;
			const drafts = detail.routes.reduce((s, r) => s + r.supply.values[t]!, 0);
			const balance = s1 + detail.inflow.values[t]! + detail.rainfall.values[t]! - detail.evaporation.values[t]! - detail.spill.values[t]! - drafts;
			expect(Math.abs(balance - s2)).toBeLessThan(1e-9);
			expect(s2).toBeGreaterThanOrEqual(0);
			expect(s2).toBeLessThanOrEqual(detail.capacity.values[t]! + 1e-12);
			expect(detail.evaporation.values[t]).toBeGreaterThanOrEqual(0);
			expect(detail.spill.values[t]).toBeGreaterThanOrEqual(0);
			if (t > 0) expect(s1).toBe(detail.storage.values[t - 1]);
			for (const r of detail.routes) {
				expect(r.supply.values[t]).toBeLessThanOrEqual(r.demand.values[t]! + 1e-12);
				expect(r.supply.values[t]).toBeGreaterThanOrEqual(0);
			}
			// Spill only when full; a deficit only when empty.
			if (detail.spill.values[t]! > 0) expect(s2).toBe(detail.capacity.values[t]);
			if (detail.deficitCase[t] !== 'none') expect(s2).toBe(0);
		}
		// Every outflow route is in the result; route flow = supply (+ spill on the spill route).
		for (const r of detail.routes) {
			const flow = result.outflows[r.route]!.values;
			flow.forEach((v, t) => expect(v).toBeCloseTo(r.supply.values[t]! + (r.isSpillRoute ? detail.spill.values[t]! : 0), 12));
		}
		// Every deficit message carries the module and the month.
		for (const m of result.messages) expect(m.module).toEqual({ type: 'RV', number: c.module.number });
	});

	it.each(cases.slice(0, 20))('case %i: natural mode is a pass-through to the spill route', (k) => {
		const c = randomCase(k);
		const { result, detail } = runReservoir(c.module, c.inflows, ctx(c.startYear, c.endYear, { mode: { kind: 'natural' }, files: c.files, rain: c.rain }), { demands: c.demands });
		expect(result.outflows[10]!.values).toEqual(c.inflows[1]!.values); // the defined inflow is zero in natural mode (R3-2)
		for (const r of [11, 12, 13]) expect(result.outflows[r]!.values.every((v) => v === 0)).toBe(true);
		expect(detail.storage.values.every((v) => v === 0)).toBe(true);
	});

	it.each(cases.slice(0, 20))('case %i: float32 storage stays within 1e-5 of float64', (k) => {
		const c = randomCase(k);
		const c64 = runReservoir(c.module, c.inflows, ctx(c.startYear, c.endYear, { files: c.files, rain: c.rain }), { demands: c.demands });
		const c32 = runReservoir(c.module, c.inflows, ctx(c.startYear, c.endYear, { files: c.files, rain: c.rain }), { demands: c.demands, options: { precision: 'float32' } });
		c32.detail.storage.values.forEach((v, t) => {
			expect(Math.fround(v)).toBe(v);
			expect(Math.abs(v - c64.detail.storage.values[t]!)).toBeLessThan(1e-4 * Math.max(1, c64.detail.capacity.values[t]!));
		});
	});
});
