import { describe, expect, it } from 'vitest';
import type { ChannelModule, DemandSeries, Monthly12, MonthlySeries, RainfallSeries, RunMode } from '../types.js';
import type { ChannelSimulator, ModuleRunContext, RouteFlows } from '../network/contract.js';
import { seededRandom } from '../synthetic/synthetic.js';
import {
	ChannelRunError,
	DEFAULT_CHANNEL_OPTIONS,
	MAX_FAILURE_MESSAGES,
	createChannelSimulator,
	diversionFlow,
	runChannel,
	shareProportionally,
	simulateChannel,
	wetlandClimate,
	type ChannelRunResult
} from './channel.js';

// Hand-worked numbers: docs/theory/channel.md §2.6 and §3.3–§5.

const twelve = (v: number) => new Array(12).fill(v) as unknown as Monthly12;
const START = 2000;
const END = 2001;
const N = 24;

function series(values: number[] | number): MonthlySeries {
	return { startYear: START, values: typeof values === 'number' ? new Array(N).fill(values) : values, unit: 'Mm3' };
}

function file(name: string, perMonth: number, years: number[] = [START, END]): DemandSeries {
	return { fileName: name, rows: years.map((year) => ({ year, months: twelve(perMonth) })), hasTotals: false, hasAverage: false };
}

/** Rain of 5 % of MAP every month (30 mm at MAP 600). */
const RAIN: RainfallSeries = { code: 'X', rows: [START, END].map((year) => ({ year, months: twelve(5) })) };

function context(mode: RunMode = { kind: 'historical' }, files: DemandSeries[] = []): ModuleRunContext {
	return {
		mode,
		startYear: START,
		endYear: END,
		rainfall: (name) => (name.toUpperCase() === 'W.RAN' ? RAIN : undefined),
		flowFile: (name) => files.find((f) => f.fileName.toUpperCase() === name.toUpperCase())
	};
}

function reach(over: Partial<ChannelModule> = {}): ChannelModule {
	return {
		kind: 'CR',
		number: 7,
		name: 'Test reach',
		fileVersion: 2,
		wetlandMapMm: 600,
		wetlandRainfallFile: 'W.RAN',
		bedLossMm3PerMonth: 0,
		wetlandStorageMm3: 10,
		wetlandAreaKm2: 5,
		rechargeCoefficient: 1,
		panMm: twelve(150),
		panFactors: twelve(0.8),
		principalOutflowRoute: 9,
		inflows: [
			{ route: 1, definedFlowFile: null },
			{ route: 2, definedFlowFile: null }
		],
		outflows: [{ route: 9, definedFlowFile: null }],
		reserved: 1,
		wetlandType: 0,
		comprehensiveWetland: { bankfullAreaKm2: 4, bankfullVolumeMm3: 8, areaVolumePower: 0.5, channelBankfullCapacity: 10, excessToWetland: 0.5, wetlandToChannel: 0.25 },
		qdiv: 0,
		localWetlandInflowRoute: 0,
		localWetlandOutflowRoute: 0,
		diversionRoute: 0,
		diversion: { bankfullCapacity: 5, efficiency: 0.8, maxMonthlyMm3: 10 },
		...over
	};
}

const flows = (r: ChannelRunResult, route: number) => r.outflows[route]!.values;

describe('allocation helpers', () => {
	it('shares a shortfall in proportion to demand (TT 689 ch.8 p.170)', () => {
		const s = shareProportionally(3.5, [2.5, 3]);
		expect(s[0]).toBeCloseTo(1.59, 2);
		expect(s[1]).toBeCloseTo(1.91, 2);
		expect(shareProportionally(10, [2, 3])).toEqual([2, 3]);
		expect(shareProportionally(0, [2, 3])).toEqual([0, 0]);
	});

	it('diverts min(capacity, efficiency × flow above bankfull, demand) (TT 689 p.148)', () => {
		const d = { bankfullCapacity: 5, efficiency: 0.8, maxMonthlyMm3: 10 };
		expect(diversionFlow(20, d)).toBe(10);
		expect(diversionFlow(14, d)).toBeCloseTo(7.2, 12);
		expect(diversionFlow(20, d, 7)).toBe(7);
		expect(diversionFlow(4, d)).toBe(0);
	});

	it('net evaporation depth = pan × factor − % MAP × MAP (§5)', () => {
		expect(wetlandClimate(150, 0.8, 5, 600)).toEqual({ gross: 120, rain: 30, net: 90 });
	});
});

describe('channel reach without special features', () => {
	it('is a ChannelSimulator', () => {
		const s: ChannelSimulator = simulateChannel;
		expect(typeof s).toBe('function');
	});

	it('sums the inflows into the principal route, less the bed loss (TT 689 p.144)', () => {
		const r = simulateChannel(reach({ bedLossMm3PerMonth: 1 }), { 1: series(3), 2: series(2) }, context());
		expect(flows(r, 9)).toEqual(new Array(N).fill(4));
		expect(r.storage).toBeUndefined();
		const dry = simulateChannel(reach({ bedLossMm3PerMonth: 6 }), { 1: series(3), 2: series(2) }, context());
		expect(flows(dry, 9)).toEqual(new Array(N).fill(0));
		expect((dry as ChannelRunResult).breakdown.bedLoss.values[0]).toBe(5);
	});

	it('serves defined outflows before calculated demands, and shares a shortfall (TT 689 p.144, pp.169–170)', () => {
		const m = reach({
			bedLossMm3PerMonth: 1,
			outflows: [
				{ route: 9, definedFlowFile: null },
				{ route: 10, definedFlowFile: 'ABS.abs' },
				{ route: 11, definedFlowFile: null },
				{ route: 12, definedFlowFile: null }
			]
		});
		// 5 in, 1 bed loss, 0.5 defined: 3.5 left for demands of 2.5 and 3.
		const r = simulateChannel(m, { 1: series(3), 2: series(2) }, context(undefined, [file('ABS.abs', 0.5)]), { 11: series(2.5), 12: series(3) });
		expect(flows(r, 10)[0]).toBe(0.5);
		expect(flows(r, 11)[0]).toBeCloseTo(1.5909, 4);
		expect(flows(r, 12)[0]).toBeCloseTo(1.9091, 4);
		expect(flows(r, 9)[0]).toBe(0);
		expect(r.messages.filter((x) => x.at).length).toBe(2 * N);
		expect(r.messages.at(-1)!.text).toMatch(/48 major and 0 minor failures to supply calculated demands/);
		expect(r.messages[0]!.module).toEqual({ type: 'CR', number: 7 });
		expect(r.messages[0]!.at).toEqual({ year: 2000, month: 0 });
	});

	it('gives a defined route its full flow even when the reach is dry, by default (OQ-CR3)', () => {
		const m = reach({ outflows: [{ route: 9, definedFlowFile: null }, { route: 10, definedFlowFile: 'ABS.abs' }] });
		const ctx = context(undefined, [file('ABS.abs', 4)]);
		const r = runChannel(m, { 1: series(1), 2: series(1) }, ctx);
		expect(flows(r, 10)[0]).toBe(4);
		expect(r.breakdown.created.values[0]).toBe(2);
		expect(r.messages[0]!.text).toMatch(/major failure to supply defined demand on route 10/);
		const limited = runChannel(m, { 1: series(1), 2: series(1) }, ctx, {}, { ...DEFAULT_CHANNEL_OPTIONS, definedShortfall: 'limitToAvailable' });
		expect(flows(limited, 10)[0]).toBe(2);
		expect(limited.breakdown.created.values[0]).toBe(0);
	});

	it('a defined principal route loses a surplus and creates a shortfall (TT 689 §7.2 p.168)', () => {
		const m = reach({ outflows: [{ route: 9, definedFlowFile: 'P.abs' }] });
		const r = runChannel(m, { 1: series(3), 2: series(2) }, context(undefined, [file('P.abs', 4)]));
		expect(flows(r, 9)[0]).toBe(4);
		expect(r.breakdown.lost.values[0]).toBe(1);
		const short = runChannel(m, { 1: series(1), 2: series(1) }, context(undefined, [file('P.abs', 4)]));
		expect(short.breakdown.created.values[0]).toBe(2);
		const limited = runChannel(m, { 1: series(1), 2: series(1) }, context(undefined, [file('P.abs', 4)]), {}, { ...DEFAULT_CHANNEL_OPTIONS, definedShortfall: 'limitToAvailable' });
		expect(flows(limited, 9)[0]).toBe(2);
		expect(limited.breakdown.created.values[0]).toBe(0);
		// Natural mode ignores the defined principal flow and passes the river on (OQ-CR16).
		const nat = runChannel(m, { 1: series(3), 2: series(2) }, context({ kind: 'natural' }, [file('P.abs', 4)]));
		expect(flows(nat, 9)[0]).toBe(5);
		expect(nat.breakdown.lost.values[0]).toBe(0);
	});

	it('imposes a defined inflow file and leaves an outflow with no demand at zero', () => {
		const m = reach({
			inflows: [{ route: 1, definedFlowFile: 'IN.abs' }],
			outflows: [{ route: 9, definedFlowFile: null }, { route: 13, definedFlowFile: null }]
		});
		const r = simulateChannel(m, { 1: series(100) }, context(undefined, [file('IN.abs', 2)]));
		expect(flows(r, 9)[0]).toBe(2);
		expect(flows(r, 13)).toEqual(new Array(N).fill(0));
	});

	it('takes a missing upstream route as zero, with a message', () => {
		const r = simulateChannel(reach(), { 1: series(3) }, context());
		expect(flows(r, 9)[0]).toBe(3);
		expect(r.messages[0]!.text).toMatch(/inflow route 2 has no upstream flow/);
	});

	it('natural mode removes defined and calculated abstractions and defined inflows (D1, OQ-CR12)', () => {
		const m = reach({
			inflows: [{ route: 1, definedFlowFile: null }, { route: 2, definedFlowFile: 'IN.abs' }],
			outflows: [{ route: 9, definedFlowFile: null }, { route: 10, definedFlowFile: 'ABS.abs' }, { route: 11, definedFlowFile: null }],
			bedLossMm3PerMonth: 0.5
		});
		const files = [file('ABS.abs', 1), file('IN.abs', 2)];
		const r = simulateChannel(m, { 1: series(3) }, context({ kind: 'natural' }, files), { 11: series(1) });
		expect(flows(r, 9)[0]).toBe(2.5);
		expect(flows(r, 10)[0]).toBe(0);
		expect(flows(r, 11)[0]).toBe(0);
		const keep = createChannelSimulator({ definedInflowInNatural: 'keep' })(m, { 1: series(3) }, context({ kind: 'natural' }, files), { 11: series(1) });
		expect(flows(keep, 9)[0]).toBe(4.5);
	});

	it('holds a defined file at the present-day year (R3-2)', () => {
		const m = reach({ outflows: [{ route: 9, definedFlowFile: null }, { route: 10, definedFlowFile: 'ABS.abs' }] });
		const f: DemandSeries = { fileName: 'ABS.abs', rows: [{ year: 2000, months: twelve(1) }, { year: 2001, months: twelve(2) }], hasTotals: false, hasAverage: false };
		const r = simulateChannel(m, { 1: series(5) }, context({ kind: 'presentDay', year: 2025 }, [f]));
		expect(flows(r, 10)).toEqual(new Array(N).fill(2));
		expect(flows(r, 9)[0]).toBe(3);
	});

	it('caps the per-month failure messages at 255 per type (TT 691 p.87)', () => {
		const long = { ...context(), startYear: 1900, endYear: 1929 };
		const m = reach({ outflows: [{ route: 9, definedFlowFile: null }, { route: 11, definedFlowFile: null }] });
		const r = simulateChannel(m, { 1: { startYear: 1900, values: new Array(360).fill(0), unit: 'Mm3' } }, long, {
			11: { startYear: 1900, values: new Array(360).fill(1), unit: 'Mm3' }
		});
		expect(r.messages.filter((x) => x.at).length).toBe(MAX_FAILURE_MESSAGES);
		expect(r.messages.at(-1)!.text).toMatch(/360 major and 0 minor .*first 255 listed/);
	});
});

describe('special features', () => {
	it('basic wetland: the run reproduces the §3.3 month', () => {
		const m = reach({ wetlandType: 1, inflows: [{ route: 1, definedFlowFile: null }] });
		const r = runChannel(m, { 1: series(4) }, context(), {}, { ...DEFAULT_CHANNEL_OPTIONS, initialWetlandStorage: 8 });
		expect(r.breakdown.initialStorage).toBe(8);
		expect(r.storage!.values[0]).toBeCloseTo(11.575282, 6);
		expect(r.breakdown.wetlandNetEvaporation.values[0]).toBeCloseTo(0.424718, 6);
		expect(flows(r, 9)[0]).toBe(0);
		// Rain on the average area: 30 mm × 5 × 9.438187/10 km².
		expect(r.breakdown.wetlandRain.values[0]).toBeCloseTo(0.03 * 5 * 0.9438187, 6);
		expect(r.breakdown.wetlandEvaporation.values[0]).toBeCloseTo(0.12 * 5 * 0.9438187, 6);
	});

	it('comprehensive wetland: the run reproduces the §4.3 month, local routes included', () => {
		const m = reach({
			wetlandType: 2,
			inflows: [{ route: 1, definedFlowFile: null }, { route: 3, definedFlowFile: null }],
			outflows: [{ route: 9, definedFlowFile: null }, { route: 14, definedFlowFile: 'WA.abs' }],
			localWetlandInflowRoute: 3,
			localWetlandOutflowRoute: 14
		});
		const r = runChannel(m, { 1: series(30), 3: series(1) }, context(undefined, [file('WA.abs', 0.5)]));
		expect(r.breakdown.initialStorage).toBe(8);
		expect(r.storage!.values[0]).toBeCloseTo(16.933863, 6);
		expect(flows(r, 9)[0]).toBeCloseTo(21.116733, 6);
		expect(flows(r, 14)[0]).toBe(0.5);
		expect(r.breakdown.wetlandInflow.values[0]).toBe(10);
		expect(r.breakdown.wetlandLocalInflow.values[0]).toBe(1);
	});

	it('diversion channel: diverts after the abstractions, capped by the maximum (TT 689 pp.147–148)', () => {
		const m = reach({
			wetlandType: 3,
			inflows: [{ route: 1, definedFlowFile: null }],
			outflows: [{ route: 9, definedFlowFile: null }, { route: 15, definedFlowFile: null }, { route: 11, definedFlowFile: null }],
			diversionRoute: 15
		});
		// 22 in, 2 to the irrigation route: qtot = 20 → divert 10, 10 to the principal.
		const r = runChannel(m, { 1: series(22) }, context(), { 11: series(2) });
		expect(flows(r, 15)[0]).toBe(10);
		expect(flows(r, 9)[0]).toBe(10);
		// A demand on the diversion route limits it.
		const d = runChannel(m, { 1: series(22) }, context(), { 11: series(2), 15: series(7) });
		expect(flows(d, 15)[0]).toBe(7);
		// Natural mode removes the diversion (OQ-CR12).
		const nat = runChannel(m, { 1: series(22) }, context({ kind: 'natural' }), { 11: series(2) });
		expect(flows(nat, 15)[0]).toBe(0);
		expect(flows(nat, 9)[0]).toBe(22);
	});

	it('a diversion route acts as an ordinary outflow when the feature is not active (TT 689 pp.148–149)', () => {
		const m = reach({
			inflows: [{ route: 1, definedFlowFile: null }],
			outflows: [{ route: 9, definedFlowFile: null }, { route: 15, definedFlowFile: null }],
			diversionRoute: 15
		});
		const r = simulateChannel(m, { 1: series(22) }, context());
		expect(flows(r, 15)[0]).toBe(0);
		expect(flows(r, 9)[0]).toBe(22);
	});
});

describe('invalid data throws, naming the module', () => {
	const run = (m: ChannelModule, inflows: RouteFlows = { 1: series(1), 2: series(1) }, ctx = context()) => () => simulateChannel(m, inflows, ctx);
	it.each([
		['no principal route', reach({ principalOutflowRoute: 0 }), /no principal outflow route/],
		['negative bed loss', reach({ bedLossMm3PerMonth: -1 }), /CHBL/],
		['basic CHC1 = 0', reach({ wetlandType: 1, wetlandStorageMm3: 0 }), /CHC1/],
		['basic CHC3 > 1', reach({ wetlandType: 1, rechargeCoefficient: 2 }), /CHC3/],
		['comprehensive Snom = 0', reach({ wetlandType: 2, comprehensiveWetland: { ...reach().comprehensiveWetland!, bankfullVolumeMm3: 0 } }), /bankfull volume/],
		['comprehensive Kin > 1', reach({ wetlandType: 2, comprehensiveWetland: { ...reach().comprehensiveWetland!, excessToWetland: 1.5 } }), /proportion into/],
		['diversion without a route', reach({ wetlandType: 3 }), /no diversion route/],
		['diversion route not an outflow', reach({ wetlandType: 3, diversionRoute: 44 }), /not an outflow route/],
		['diversion route = principal', reach({ wetlandType: 3, diversionRoute: 9 }), /principal/],
		['diversion efficiency > 1', reach({ wetlandType: 3, diversionRoute: 15, outflows: [{ route: 9, definedFlowFile: null }, { route: 15, definedFlowFile: null }], diversion: { bankfullCapacity: 0, efficiency: 1.5, maxMonthlyMm3: 1 } }), /efficiency/],
		['wetland without a rainfall file', reach({ wetlandType: 1, wetlandRainfallFile: null }), /rainfall file/],
		['wetland rainfall not in the bundle', reach({ wetlandType: 1, wetlandRainfallFile: 'NONE.RAN' }), /not in the network/],
		['missing defined-flow file', reach({ inflows: [{ route: 1, definedFlowFile: 'GONE.abs' }] }), /GONE\.abs' is not in the network/]
	])('%s', (_, m, pattern) => {
		expect(run(m)).toThrow(ChannelRunError);
		expect(run(m)).toThrow(pattern);
		expect(run(m)).toThrow(/CR7 'Test reach'/);
	});

	it('rejects a series of the wrong length or with negative flows', () => {
		expect(run(reach(), { 1: { startYear: START, values: [1], unit: 'Mm3' } })).toThrow(/covers 2000 for 1 months/);
		expect(run(reach(), { 1: series(-1) })).toThrow(/flows must be ≥ 0/);
	});

	it('rejects a defined-flow file without a year of the run, naming the module and route', () => {
		const m = reach({ inflows: [{ route: 1, definedFlowFile: 'IN.abs' }] });
		const f = () => simulateChannel(m, {}, context(undefined, [file('IN.abs', 1, [START])]));
		expect(f).toThrow(ChannelRunError);
		expect(f).toThrow(/CR7 'Test reach': route 1: IN\.abs: no row for 2001/);
	});

	it('rejects a negative % MAP in the wetland rainfall', () => {
		const m = reach({ wetlandType: 1, inflows: [{ route: 1, definedFlowFile: null }] });
		const ctx = { ...context(), rainfall: () => ({ code: 'X', rows: [{ year: START, months: twelve(-99) }, { year: END, months: twelve(5) }] }) };
		expect(() => simulateChannel(m, { 1: series(1) }, ctx)).toThrow(/negative or missing % MAP in 2000/);
	});

	it('rejects a rainfall file without a year of the run', () => {
		const ctx = { ...context(), endYear: 2002 };
		const m = reach({ wetlandType: 1, inflows: [{ route: 1, definedFlowFile: null }] });
		expect(() => simulateChannel(m, { 1: { startYear: START, values: new Array(36).fill(1), unit: 'Mm3' } }, ctx)).toThrow(/no 2002 row/);
	});
});

describe('invariants over random synthetic reaches', () => {
	const sum = (r: ChannelRunResult, t: number) => Object.values(r.outflows).reduce((s, v) => s + v.values[t]!, 0);

	for (let seed = 1; seed <= 60; seed++) {
		const rnd = seededRandom(seed);
		const type = (seed % 4) as 0 | 1 | 2 | 3;
		const mode: RunMode = seed % 5 === 0 ? { kind: 'natural' } : { kind: 'historical' };
		it(`seed ${seed}: type ${type}, ${mode.kind}`, () => {
			const values = () => Array.from({ length: N }, () => (rnd() < 0.2 ? 0 : rnd() ** 2 * 40));
			const m = reach({
				wetlandType: type,
				bedLossMm3PerMonth: rnd() * 2,
				wetlandStorageMm3: 1 + rnd() * 20,
				wetlandAreaKm2: rnd() * 10,
				rechargeCoefficient: rnd(),
				panMm: twelve(50 + rnd() * 200),
				comprehensiveWetland: {
					bankfullAreaKm2: rnd() * 10,
					bankfullVolumeMm3: 0.5 + rnd() * 20,
					areaVolumePower: 0.2 + rnd(),
					channelBankfullCapacity: rnd() * 15,
					excessToWetland: rnd(),
					wetlandToChannel: rnd()
				},
				qdiv: rnd() < 0.5 ? 0 : rnd() * 5,
				inflows: [{ route: 1, definedFlowFile: null }, { route: 2, definedFlowFile: null }, { route: 3, definedFlowFile: null }],
				outflows: [
					{ route: 9, definedFlowFile: null },
					{ route: 10, definedFlowFile: 'ABS.abs' },
					{ route: 11, definedFlowFile: null },
					{ route: 14, definedFlowFile: null },
					{ route: 15, definedFlowFile: null }
				],
				localWetlandInflowRoute: 3,
				localWetlandOutflowRoute: 14,
				diversionRoute: 15,
				diversion: { bankfullCapacity: rnd() * 10, efficiency: rnd(), maxMonthlyMm3: rnd() * 10 }
			});
			const ctx = context(mode, [file('ABS.abs', rnd() * 2)]);
			const options = { ...DEFAULT_CHANNEL_OPTIONS, initialWetlandStorage: rnd() * 10, definedShortfall: rnd() < 0.5 ? 'supplyInFull' : 'limitToAvailable' } as const;
			const r = runChannel(m, { 1: series(values()), 2: series(values()), 3: series(values()) }, ctx, { 11: series(values()), 14: series(values().map((v) => v / 10)) }, options);
			const b = r.breakdown;
			let previous = b.initialStorage;
			for (let t = 0; t < N; t++) {
				const storage = b.storage.values[t]!;
				// Mass balance: inflow + created = outflows + bed loss + lost + net evaporation + ΔS.
				const lhs = b.inflow.values[t]! + b.created.values[t]!;
				const rhs = sum(r, t) + b.bedLoss.values[t]! + b.lost.values[t]! + b.wetlandNetEvaporation.values[t]! + storage - previous;
				expect(Math.abs(lhs - rhs)).toBeLessThan(1e-9 * Math.max(1, lhs));
				// Gross evaporation − rain = net.
				expect(b.wetlandEvaporation.values[t]! - b.wetlandRain.values[t]!).toBeCloseTo(b.wetlandNetEvaporation.values[t]!, 9);
				for (const v of Object.values(r.outflows)) expect(v.values[t]!).toBeGreaterThanOrEqual(0);
				expect(storage).toBeGreaterThanOrEqual(0);
				if (type === 0 || type === 3) {
					expect(storage).toBe(0);
					if (b.created.values[t] === 0) expect(sum(r, t)).toBeLessThanOrEqual(b.inflow.values[t]! + 1e-12);
				}
				if (type === 3) {
					const div = b.diversion.values[t]!;
					expect(div).toBeLessThanOrEqual(m.diversion!.maxMonthlyMm3 + 1e-12);
					expect(div).toBeLessThanOrEqual(b.upstreamOfFeature.values[t]! + 1e-12);
				}
				if (mode.kind === 'natural') {
					for (const route of [10, 11, 14, 15]) expect(r.outflows[route]!.values[t]).toBe(0);
				}
				previous = storage;
			}
			if (type === 1 || type === 2) expect(r.storage).toBeDefined();
		});
	}
});
