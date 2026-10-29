import { describe, expect, it } from 'vitest';
import { samiAquiferStep } from '../groundwater/sami/aquifer.js';
import { fakeSamiParts } from '../groundwater/sami/fake-parts.js';
import { samiInterflow, samiInterflowRouter, samiSoilPass } from '../groundwater/sami/soil.js';
import type { ReductionInput, StreamflowReduction } from '../landuse/contract.js';
import type { Monthly12, PitmanParameters, RainfallSeries, RunoffModule, SamiParameters } from '../types.js';
import { PitmanRunError, runRunoffModule, simulateModuleRunoff, runoffModuleRainfall } from './pitman.js';
import { forestReduction } from '../landuse/forest.js';
import { SAMI_PARTS, SAMI_PARTS_NOT_WIRED, SFR_TARGETS, STREAMFLOW_REDUCTIONS } from './wiring.js';

// runRunoffModule with Sami (groundwater model 2) and streamflow reductions.
// Synthetic fixtures only (issue #3 rule 2).

const twelve = (f: (m: number) => number) => Array.from({ length: 12 }, (_, m) => f(m)) as unknown as Monthly12;
const classic: PitmanParameters = { POW: 2, SL: 0, ST: 200, FT: 10, GW: 3, ZMIN: 0, ZMAX: 500, PI: 1.5, TL: 0.25, GL: 2.5, R: 0.5, FF: 1 };
const samiSet: PitmanParameters = { POW: 2, SL: 20, ST: 260, FT: 8, GW: 4, ZMIN: 15, ZMAX: 700, PI: 1.5, TL: 0.5, GL: 3, R: 0.5, FF: 1 };

const samiBlock: SamiParameters = {
	aquiferThicknessM: 20,
	storativity: 0.005,
	initialAquiferStorage: 70,
	staticWaterLevelMm: 60,
	unsaturatedStorage: 10,
	initialUnsaturatedStorage: 5,
	PPOW: 0.2,
	GPOW: 2,
	maxDischarge: 2,
	gwSwPower: -0.05,
	HGSL: 30,
	HGGW: 3,
	maxHydraulicGradient: 0.001,
	transmissivity: 10,
	boreholeDistanceToRiver: 1000,
	gwEvaporationArea: 1,
	K2: 0.1,
	K3: -3,
	interflowLag: 1,
	rechargeAveragingMonths: 2,
	abstractionMode: 1,
	pitman: samiSet,
	abstractions: [{ year: 2001, value: 0.12 }, { year: 2002, value: 0.24 }]
};

function module(overrides: Partial<RunoffModule> = {}): RunoffModule {
	return {
		kind: 'RU',
		number: 4,
		name: 'Synthetic Sami',
		fileVersion: 7,
		fileVersionInFile: true,
		areaKm2: 120,
		mapMm: 700,
		rainfallFile: 'SYN.RAN',
		pitman: classic,
		sPanMm: twelve((m) => 120 + 10 * m),
		panFactors: twelve(() => 0.9),
		afforestation: { algorithm: 0, algorithmInFile: true, areaKm2: [] },
		outflows: [{ route: 1, percent: 100 }],
		groundwaterModel: 2,
		sami: samiBlock,
		aPanFactors: twelve(() => 0.7),
		...overrides
	};
}

const ran: RainfallSeries = {
	code: 'SYN',
	rows: [2001, 2002, 2003].map((year, y) => ({ year, months: twelve((m) => (m >= 1 && m <= 6 ? 14 + 3 * y + m : 2)) }))
};
const period = { startYear: 2001, endYear: 2003 };

describe('wiring (src/runoff/wiring.ts)', () => {
	it('ships with the real Sami parts and both land-use models wired', () => {
		expect(SAMI_PARTS).not.toBe(SAMI_PARTS_NOT_WIRED);
		expect(SAMI_PARTS.soilPass).toBe(samiSoilPass);
		expect(SAMI_PARTS.aquiferStep).toBe(samiAquiferStep);
		expect(SAMI_PARTS.interflowRouter).toBe(samiInterflowRouter); // R6-A10: O(1) TL cap a month
		expect(STREAMFLOW_REDUCTIONS).toHaveLength(2);
		expect(STREAMFLOW_REDUCTIONS[0]).toBe(forestReduction);
		expect(typeof SFR_TARGETS.alien).toBe('function');
		expect(() => SAMI_PARTS_NOT_WIRED.aquiferInit({} as never)).toThrow(/not wired/);
	});

	it('runs a Sami module with the default (real) parts', () => {
		const result = runRunoffModule(module(), ran, period);
		expect(result.outflow.values).toHaveLength(36);
		expect(result.outflow.values.every(Number.isFinite)).toBe(true);
	});

	it('refuses a Sami module when the parts are not wired, naming it (R2-2)', () => {
		const run = () => runRunoffModule(module(), ran, { ...period, samiParts: SAMI_PARTS_NOT_WIRED });
		expect(run).toThrow(PitmanRunError);
		expect(run).toThrow(/RU 4: groundwater model 2 \(Sami\) parts are not wired yet/);
	});
});

describe('runRunoffModule with Sami', () => {
	it('runs the L.035 set through the composition and reports the §3.12 series', () => {
		const result = runRunoffModule(module(), ran, { ...period, samiParts: fakeSamiParts() });
		expect(result.sami).toBeDefined();
		expect(result.outflow.values).toHaveLength(36);
		// The Pitman core used L.035 (ST 260) with GW = GL = 0, not the classic L.003 set.
		expect(result.sami!.pitman.months.every((m) => m.sEnd <= samiSet.ST && m.base === 0)).toBe(true);
		result.outflow.values.forEach((v, i) => expect(v).toBeCloseTo((result.sami!.months[i]!.runoff * 120) / 1000, 12));
		expect(result.diagnostics.netRunoff).toEqual(result.outflow);
		for (const key of ['surfaceRunoff', 'groundwaterOutflow', 'pavedFlow', 'soilMoistureMm', 'aquiferStorageMm', 'rechargeMm', 'interflow'] as const) {
			expect(result.diagnostics[key]!.values).toHaveLength(36);
		}
	});

	it('hands the aquifer E_m × APF_m, the rain, and the L.036–L.037 abstraction in Mm³/a spread over 12 months', () => {
		const result = runRunoffModule(module(), ran, { ...period, samiParts: fakeSamiParts() });
		const months = result.sami!.months;
		expect(months[3]!.aquiferInput.petGw).toBeCloseTo((120 + 30) * 0.7, 12);
		expect(months[3]!.aquiferInput.rain).toBeCloseTo((ran.rows[0]!.months[3] / 100) * 700, 12);
		expect(months[0]!.aquiferInput.abstraction).toBeCloseTo(((0.12 / 12) * 1000) / 120, 12);
		expect(months[30]!.aquiferInput.abstraction).toBeCloseTo(((0.24 / 12) * 1000) / 120, 12); // held flat beyond the table
	});

	it('applies no abstraction in natural mode (D1, R3-N9), and none with the flag off under whenFlagOn', () => {
		const natural = runRunoffModule(module(), ran, { ...period, mode: { kind: 'natural' }, samiParts: fakeSamiParts() });
		expect(natural.sami!.months.every((m) => m.aquiferInput.abstraction === 0)).toBe(true);
		const flagOff = module({ sami: { ...samiBlock, abstractionMode: 0 } });
		const quirk = runRunoffModule(flagOff, ran, { ...period, samiParts: fakeSamiParts() });
		expect(quirk.sami!.months[0]!.aquiferInput.abstraction).toBeGreaterThan(0); // TT 691 p.145: acts on the L.036 count
		const strict = runRunoffModule(flagOff, ran, { ...period, samiParts: fakeSamiParts(), sami: { abstractions: 'whenFlagOn' } });
		expect(strict.sami!.months.every((m) => m.aquiferInput.abstraction === 0)).toBe(true);
	});

	it('warns and applies none for a time-series abstraction file (OQ-S9), and falls back to L.005 without A-pan factors (OQ-S7)', () => {
		const m = module({ sami: { ...samiBlock, abstractionMode: 2 }, aPanFactors: undefined });
		const result = runRunoffModule(m, ran, { ...period, samiParts: fakeSamiParts() });
		expect(result.messages.map((x) => x.text)).toEqual(
			expect.arrayContaining([expect.stringMatching(/AbstractionsOn = 2/), expect.stringMatching(/no A-pan factors/)])
		);
		expect(result.sami!.months[2]!.aquiferInput.petGw).toBeCloseTo((120 + 20) * 0.9, 12);
		expect(result.sami!.months.every((x) => x.aquiferInput.abstraction === 0)).toBe(true);
	});

	it('runs with the real soil side, and turns its RangeError into a PitmanRunError naming the module (R6-S1/S2)', () => {
		const parts = { ...fakeSamiParts(), soilPass: samiSoilPass, interflow: samiInterflow };
		const ok = runRunoffModule(module(), ran, { ...period, samiParts: parts });
		expect(ok.outflow.values.every(Number.isFinite)).toBe(true);
		const bad = module({ sami: { ...samiBlock, rechargeAveragingMonths: 0 } });
		const run = () => runRunoffModule(bad, ran, { ...period, samiParts: parts });
		expect(run).toThrow(PitmanRunError);
		expect(run).toThrow(/RU 4: Sami: .*MMA/);
	});

	it('validates the L.035 set, not L.003', () => {
		const bad = module({ sami: { ...samiBlock, pitman: { ...samiSet, ST: 10 } } });
		expect(() => runRunoffModule(bad, ran, { ...period, samiParts: fakeSamiParts() })).toThrow(/ST = 10 must exceed SL = 20/);
	});

	it('warns about months of negative runoff instead of clamping them', () => {
		const fake = fakeSamiParts();
		const thirsty = {
			...fake,
			aquiferStep: ((s, i, p) => {
				const r = fake.aquiferStep(s, i, p);
				return { ...r, out: { ...r.out, transmissionLoss: i.runoffForHead + 50 } };
			}) as typeof fake.aquiferStep
		};
		const result = runRunoffModule(module(), ran, { ...period, samiParts: thirsty });
		expect(result.outflow.values.some((v) => v < 0)).toBe(true);
		expect(result.messages.some((m) => /negative in \d+ month/.test(m.text))).toBe(true);
	});
});

describe('runRunoffModule with streamflow reductions', () => {
	const afforested = module({
		groundwaterModel: 0,
		afforestation: { algorithm: 1, algorithmInFile: true, areaKm2: [{ year: 2000, value: 5 }] }
	});

	it('subtracts each injected reduction from the unreduced runoff, replacing the wired ones', () => {
		const seen: ReductionInput[] = [];
		const tenth: StreamflowReduction = (inp) => (seen.push(inp), { reductionMm3: { ...inp.unreducedRunoffMm3, values: inp.unreducedRunoffMm3.values.map((v) => 0.1 * Math.max(0, v)) }, messages: [] });
		const fixed: StreamflowReduction = (inp) => ({ reductionMm3: { ...inp.unreducedRunoffMm3, values: inp.unreducedRunoffMm3.values.map(() => 0.001) }, virginMarMm3: 1.25, messages: [{ level: 'info', text: 'fixed' }] });
		const parent = module({ number: 1 });
		const base = runRunoffModule(afforested, ran, period);
		const result = runRunoffModule(afforested, ran, { ...period, reductions: [tenth, fixed], parent, mode: { kind: 'presentDay', year: 2002 } });
		expect(base.messages.some((m) => /R6-F3/.test(m.text))).toBe(true); // the wired forestReduction
		expect(result.messages.some((m) => /R6-F3/.test(m.text))).toBe(false);
		expect(result.messages.find((m) => m.text === 'fixed')).toMatchObject({ module: { type: 'RU', number: 4 } });
		expect(seen[0]).toMatchObject({ module: afforested, parent, mode: { kind: 'presentDay', year: 2002 }, startYear: 2001, endYear: 2003 });
		expect(seen[0]!.unreducedRunoffMm3.values).toEqual(base.outflow.values);
		expect(seen[0]!.rainfallMm).toEqual(runoffModuleRainfall(afforested, ran, 2001, 2003).rainfallMm);
		result.outflow.values.forEach((v, i) => {
			const q = base.outflow.values[i]!;
			expect(v).toBeCloseTo(q - Math.min(Math.max(0, q), 0.1 * Math.max(0, q) + 0.001), 12);
		});
		expect(result.unreducedOutflow!.values).toEqual(base.outflow.values);
		expect(result.virginMarMm3).toBe(1.25);
		expect(result.diagnostics.netRunoff).toBe(result.outflow);
	});

	it('caps the total reduction at the runoff, with a warning', () => {
		const all: StreamflowReduction = (inp) => ({ reductionMm3: { ...inp.unreducedRunoffMm3, values: inp.unreducedRunoffMm3.values.map((v) => Math.abs(v) + 1) }, messages: [] });
		const base = runRunoffModule(afforested, ran, period);
		const result = runRunoffModule(afforested, ran, { ...period, reductions: [all] });
		// A month the classic lag already took below 0 (TL < 0.5, OQ-22) is left as it is; nothing is removed from it.
		result.outflow.values.forEach((v, i) => expect(v).toBe(Math.min(0, base.outflow.values[i]!)));
		expect(result.messages.some((m) => /capped at the runoff/.test(m.text))).toBe(true);
	});

	it('rejects a reduction that breaks the contract', () => {
		const short: StreamflowReduction = (inp) => ({ reductionMm3: { ...inp.unreducedRunoffMm3, values: [0] }, messages: [] });
		const negative: StreamflowReduction = (inp) => ({ reductionMm3: { ...inp.unreducedRunoffMm3, values: inp.unreducedRunoffMm3.values.map(() => -1) }, messages: [] });
		expect(() => runRunoffModule(afforested, ran, { ...period, reductions: [short] })).toThrow(/returned 1 months; the run has 36/);
		expect(() => runRunoffModule(afforested, ran, { ...period, reductions: [negative] })).toThrow(/finite and ≥ 0/);
	});

	it('an empty list applies nothing: outflow unchanged, no warning', () => {
		const base = runRunoffModule(afforested, ran, period);
		const none = runRunoffModule(afforested, ran, { ...period, reductions: [] });
		expect(none.outflow.values).toEqual(base.outflow.values);
		expect(none.messages).toEqual([]);
	});
});

describe('simulateModuleRunoff (the re-run hook for land-use models)', () => {
	it('gives the same depths runRunoffModule converts, for classic and Sami', () => {
		const rain = runoffModuleRainfall(module(), ran, 2001, 2003);
		for (const m of [module({ groundwaterModel: 0 }), module()]) {
			const parts = fakeSamiParts();
			const depths = simulateModuleRunoff(m, rain, { ...period, samiParts: parts });
			const result = runRunoffModule(m, ran, { ...period, samiParts: fakeSamiParts() });
			result.outflow.values.forEach((v, i) => expect(v).toBeCloseTo((depths.runoffMm[i]! * m.areaKm2) / 1000, 12));
		}
	});
});


describe('runRunoffModule: evaporation diagnostics and per-month overrides (R6-V10, R6-P1)', () => {
	it('reports actual (E + interception) and potential (FF·S-pan·pan factor) evaporation, classic and Sami', () => {
		for (const m of [module({ groundwaterModel: 0 }), module()]) {
			const r = runRunoffModule(m, ran, { ...period, samiParts: fakeSamiParts() });
			const pitman = r.sami ? r.sami.pitman : null;
			const FF = m.groundwaterModel === 2 ? samiSet.FF : classic.FF;
			expect(r.diagnostics.potentialEvaporationMm!.values[13]).toBeCloseTo(FF * (120 + 10) * 0.9, 12);
			if (pitman) expect(r.diagnostics.actualEvaporationMm!.values[5]).toBe(pitman.months[5]!.E + pitman.months[5]!.interception);
			expect(r.diagnostics.actualEvaporationMm!.values).toHaveLength(36);
		}
	});

	it('hands the reductions the run evaporation', () => {
		let seen: unknown;
		const peek: StreamflowReduction = (inp) => ((seen = (inp as { evaporation?: unknown }).evaporation), { reductionMm3: { ...inp.unreducedRunoffMm3, values: inp.unreducedRunoffMm3.values.map(() => 0) }, messages: [] });
		const r = runRunoffModule(module({ groundwaterModel: 0 }), ran, { ...period, reductions: [peek] });
		expect(seen).toEqual({ potentialMm: r.diagnostics.potentialEvaporationMm!.values, actualMm: r.diagnostics.actualEvaporationMm!.values });
	});

	it('takes a per-month impervious fraction instead of the paved table', () => {
		const ai = new Array<number>(36).fill(0).map((_, i) => (i < 12 ? 0 : 0.25));
		const withTable = module({ groundwaterModel: 0, paved: { fraction: [{ year: 2001, value: 0.9 }] } });
		const r = runRunoffModule(withTable, ran, { ...period, imperviousFraction: ai });
		const pm3 = r.diagnostics.pavedFlow!.values;
		expect(pm3[3]).toBe(0);
		expect(pm3[15]).toBeCloseTo((0.25 * (ran.rows[1]!.months[3] / 100) * 700 * 120) / 1000, 12);
		expect(() => runRunoffModule(withTable, ran, { ...period, imperviousFraction: [0.1] })).toThrow(/imperviousFraction has 1 months; the run has 36/);
		expect(() => runRunoffModule(withTable, ran, { ...period, imperviousFraction: ai.map(() => 1.5) })).toThrow(/outside 0–1/);
	});

	it('converts depth to volume on a per-month area', () => {
		const area = new Array<number>(36).fill(0).map((_, i) => (i < 24 ? 120 : 60));
		for (const m of [module({ groundwaterModel: 0 }), module()]) {
			const base = runRunoffModule(m, ran, { ...period, samiParts: fakeSamiParts() });
			const half = runRunoffModule(m, ran, { ...period, samiParts: fakeSamiParts(), activeAreaKm2: area });
			expect(half.outflow.values[10]).toBe(base.outflow.values[10]);
			expect(half.outflow.values[30]).toBeCloseTo(base.outflow.values[30]! / 2, 12);
			expect(half.diagnostics.pavedFlow!.values[30]).toBeCloseTo(base.diagnostics.pavedFlow!.values[30]! / 2, 12);
		}
	});
});
