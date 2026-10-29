import { describe, expect, it } from 'vitest';
import { runRunoffModule } from '../runoff/pitman.js';
import { syntheticNetwork } from '../synthetic/index.js';
import type { RunMode, RunoffModule, SamiParameters } from '../types.js';
import { smoothedGushTargets } from './forest.js';
import {
	DEFAULT_SFR_OPTIONS,
	activeAreaByYear,
	applySfrStep,
	defaultTolerance,
	inheritFromParent,
	lowFlow,
	meanAnnual,
	runSfrGroup,
	sfrKind,
	sfrParameters,
	withSfrParameters,
	type ChildTargetModel,
	type SfrGroupInput,
	type SfrSimulator
} from './sfr.js';

const START = 1990;
const END = 2009;
const net = syntheticNetwork({ years: END - START + 1, seed: 7 });
const rain = net.rainfall[0]!.series;

/** A wet, afforestable parent (FT > 0, TT 690 p.127). */
const parent: RunoffModule = {
	...net.runoff[0]!,
	number: 1,
	areaKm2: 100,
	mapMm: 900,
	rainfallFile: net.rainfall[0]!.fileName,
	pitman: { ...net.runoff[0]!.pitman, SL: 0, ST: 200, FT: 25, GW: 3, ZMIN: 20, ZMAX: 600, PI: 1.5, R: 0.5, FF: 1, GL: 1.5 },
	outflows: [{ route: 1, percent: 100 }],
	inflowRoute: 0,
	sfrChildren: [11]
};

/** A child as a user creates it: its own (wrong) climate and parameters, a forest table and one route to the zero sink. */
const child = (afforestation: Partial<RunoffModule['afforestation']>, number = 11): RunoffModule => ({
	...net.runoff[1]!,
	number,
	name: `Forest ${number}`,
	areaKm2: 40,
	mapMm: 500,
	pitman: { ...net.runoff[1]!.pitman, ST: 90, PI: 4, FT: 2 },
	outflows: [{ route: 90 + number, percent: 100 }],
	inflowRoute: 0,
	sfrChildren: [],
	afforestation: {
		algorithm: 2,
		algorithmInFile: true,
		areaKm2: [{ year: START, value: 30 }],
		species: { pine: { percent: 60, rotationYears: 20 }, eucalyptus: { percent: 30, rotationYears: 10 }, wattle: { percent: 10, rotationYears: 10 } },
		optimalPercent: 60,
		...afforestation
	}
});

let simulations = 0;
/** The classic Pitman runner, with the module's land use as absent (the `SfrSimulator` contract). */
const simulate: SfrSimulator = (m) => {
	simulations++;
	return runRunoffModule(
		{ ...m, afforestation: { ...m.afforestation, areaKm2: [] }, alienVegetation: undefined, sfrChildren: [] },
		rain,
		{ startYear: START, endYear: END }
	);
};

const group = (children: RunoffModule[], mode: RunMode = { kind: 'historical' }, extra: Partial<SfrGroupInput> = {}): SfrGroupInput => ({
	parent,
	children,
	mode,
	startYear: START,
	endYear: END,
	simulate,
	...extra
});

const userDefined = (mar: number, low: number, areaKm2 = [{ year: START, value: 30 }]) => child({ algorithm: 4, userDefinedReduction: { marPercent: mar, lowFlowPercent: low }, areaKm2 });

const fullParent = simulate(parent).outflow.values;
const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

describe('meanAnnual and lowFlow', () => {
	it('mean annual volume is the monthly mean × 12', () => {
		expect(meanAnnual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])).toBeCloseTo(78, 12);
		expect(meanAnnual([])).toBe(0);
	});

	it('low flow is the mean of the lowest 25 % of months (TT 689 p.138)', () => {
		const months = [9, 1, 8, 2, 7, 3, 6, 4, 5, 10, 11, 12];
		expect(lowFlow(months)).toBeCloseTo((1 + 2 + 3) / 3, 12);
		expect(lowFlow([5])).toBe(5);
		expect(lowFlow([])).toBe(0);
	});
});

describe('activeAreaByYear (D1, R6-F12)', () => {
	const table = [
		{ year: 1990, value: 10 },
		{ year: 2000, value: 20 }
	];

	it('interpolates by year in historical mode, flat beyond the table', () => {
		expect(activeAreaByYear(table, { kind: 'historical' }, 1988, 2002)).toEqual([10, 10, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 20, 20]);
	});

	it('holds the area at the present-day year', () => {
		expect(activeAreaByYear(table, { kind: 'presentDay', year: 1995 }, 1990, 1993)).toEqual([15, 15, 15, 15]);
	});

	it('is zero in natural mode', () => {
		expect(activeAreaByYear(table, { kind: 'natural' }, 1990, 1992)).toEqual([0, 0, 0]);
	});
});

describe('inheritFromParent (TT 689 p.138; TT 691 RU_CopyClimate, RU_CopyParameters)', () => {
	const sami = { HGSL: 5, pitman: { ...parent.pitman, ST: 300 }, abstractions: [{ year: 1990, value: 0.2 }] } as unknown as SamiParameters;
	const p: RunoffModule = { ...parent, groundwaterModel: 2, sami, paved: { fraction: [{ year: 1990, value: 0.05 }] }, inflowRoute: 7 };
	const c = child({});
	const inherited = inheritFromParent(p, { ...c, paved: { fraction: [{ year: 1990, value: 0.1 }] } });

	it('copies climate, parameters and the groundwater model from the parent', () => {
		expect(inherited.mapMm).toBe(p.mapMm);
		expect(inherited.rainfallFile).toBe(p.rainfallFile);
		expect(inherited.sPanMm).toBe(p.sPanMm);
		expect(inherited.panFactors).toBe(p.panFactors);
		expect(inherited.aPanFactors).toBe(p.aPanFactors);
		expect(inherited.pitman).toBe(p.pitman);
		expect(inherited.groundwaterModel).toBe(2);
		expect(inherited.sami!.pitman).toBe(sami.pitman);
		expect(inherited.sami!.HGSL).toBe(5);
	});

	it('keeps the child’s identity, area, land use and route, and drops paved area, RTIN and abstractions (R6-F13)', () => {
		expect(inherited.number).toBe(11);
		expect(inherited.areaKm2).toBe(40);
		expect(inherited.afforestation).toBe(c.afforestation);
		expect(inherited.outflows).toBe(c.outflows);
		expect(inherited.paved).toBeUndefined();
		expect(inherited.inflowRoute).toBeUndefined();
		expect(inherited.sfrChildren).toBeUndefined();
		expect(inherited.sami!.abstractions).toEqual([]);
	});
});

describe('the calibrated parameters', () => {
	it('reads and writes the active set: classic L.003, Sami L.035 + L.032 HGSL', () => {
		expect(sfrParameters(parent)).toEqual({ PI: 1.5, FF: 1, SL: 0, ST: 200, HGSL: 0 });
		const next = withSfrParameters(parent, { PI: 5, FF: 1.2, SL: 10, ST: 210, HGSL: 10 });
		expect(next.pitman).toMatchObject({ PI: 5, FF: 1.2, SL: 10, ST: 210, POW: parent.pitman.POW });

		const sami = { HGSL: 4, pitman: { ...parent.pitman, ST: 150 } } as unknown as SamiParameters;
		const s: RunoffModule = { ...parent, groundwaterModel: 2, sami };
		expect(sfrParameters(s)).toEqual({ PI: 1.5, FF: 1, SL: 0, ST: 150, HGSL: 4 });
		const t = withSfrParameters(s, { PI: 3, FF: 1.1, SL: 2, ST: 152, HGSL: 6 });
		expect(t.sami!.pitman).toMatchObject({ PI: 3, FF: 1.1, SL: 2, ST: 152 });
		expect(t.sami!.HGSL).toBe(6);
		expect(t.pitman).toBe(parent.pitman);
	});

	it('ΔPI = k·ΔFF and ΔSL = ΔST (TT 690 p.126; k R6-F6), HGSL with SL (R6-F14)', () => {
		const p = { PI: 1.5, FF: 1, SL: 5, ST: 200, HGSL: 5 };
		const q = applySfrStep(p, 0.1, 3, 34, 'reflect');
		expect(q.FF).toBeCloseTo(1.1, 12);
		expect(q.PI).toBeCloseTo(1.5 + 3.4, 12);
		expect(q.SL).toBe(8);
		expect(q.ST).toBe(203);
		expect(q.HGSL).toBe(8);
	});

	it('floors SL at 0: reflect grows ST by twice the overshoot, clamp moves it by ΔSL (R6-F8)', () => {
		const p = { PI: 2, FF: 1.1, SL: 4, ST: 124, HGSL: 4 };
		const reflect = applySfrStep(p, 0, -11, 34, 'reflect');
		expect(reflect.SL).toBe(0);
		expect(reflect.ST).toBe(124 + 2 * 7);
		expect(reflect.HGSL).toBe(0);
		const clamp = applySfrStep(p, 0, -11, 34, 'clamp');
		expect(clamp.SL).toBe(0);
		expect(clamp.ST).toBe(113);
	});

	it('floors PI at 0 and FF at 0.01 (R6-F15)', () => {
		const q = applySfrStep({ PI: 1, FF: 0.5, SL: 0, ST: 100, HGSL: 0 }, -1, 0, 34, 'reflect');
		expect(q.PI).toBe(0);
		expect(q.FF).toBe(0.01);
	});

	it('closing error: 1 % to iteration 10, then 2, 4, 8, 16 (TT 689 p.139; R6-F9)', () => {
		expect([1, 10, 11, 16, 17, 24, 25, 32, 33, 40].map(defaultTolerance)).toEqual([1, 1, 2, 2, 4, 4, 8, 8, 16, 16]);
		expect(DEFAULT_SFR_OPTIONS.maxIterations).toBe(40);
		expect(DEFAULT_SFR_OPTIONS.slStepFactor(10)).toBe(0.7);
		expect(DEFAULT_SFR_OPTIONS.slStepFactor(11)).toBe(0.35);
	});
});

describe('sfrKind', () => {
	it('forest, alien or none (R6-F11)', () => {
		expect(sfrKind(child({}))).toBe('forest');
		const alien: RunoffModule = { ...child({ areaKm2: [] }), alienVegetation: { algorithm: 1, riparianArea: 0, areaKm2: [{ year: 1990, value: 3 }] } };
		expect(sfrKind(alien)).toBe('alien');
		expect(sfrKind({ ...alien, alienVegetation: { ...alien.alienVegetation!, algorithm: 0 } })).toBe('none');
		expect(sfrKind(child({ areaKm2: [] }))).toBe('none');
	});
});

describe('runSfrGroup', () => {
	it('conserves area: with 0 % targets the parent + child flows equal the free catchment (TT 689 p.162 KB article 1)', () => {
		const r = runSfrGroup(group([userDefined(0, 0)]));
		r.outflowMm3.values.forEach((v, i) => expect(v).toBeCloseTo(fullParent[i]!, 9));
		expect(r.children[0]!.iterations).toEqual([]);
		expect(r.parentAreaKm2ByYear.every((a) => a === 70)).toBe(true);
	});

	it('Virgin MAR is the child’s natural runoff over its active area (TT 689 p.139 example 1)', () => {
		const r = runSfrGroup(group([userDefined(0, 0)]));
		expect(r.virginMarMm3[11]).toBeCloseTo((meanAnnual(fullParent) * 30) / 100, 9);
		expect(r.children[0]!.virginLowFlowMm3).toBeCloseTo((lowFlow(fullParent) * 30) / 100, 9);
	});

	it('zero afforested area ⇒ zero child flow, zero reduction, Virgin MAR 0', () => {
		const r = runSfrGroup(group([child({ areaKm2: [{ year: START, value: 0 }] })]));
		expect(r.children[0]!.outflowMm3.values.every((v) => v === 0)).toBe(true);
		expect(r.virginMarMm3[11]).toBe(0);
		expect(r.children[0]!.kind).toBe('none');
		expect(r.children[0]!.targets).toBeNull();
		r.outflowMm3.values.forEach((v, i) => expect(v).toBeCloseTo(fullParent[i]!, 9));
	});

	it('a zero Virgin MAR zeroes the targets (the run logs)', () => {
		const later = child({ areaKm2: [{ year: 1990, value: 0 }, { year: 2000, value: 10 }] });
		const r = runSfrGroup(group([later], { kind: 'presentDay', year: 1985 }));
		const c = r.children[0]!;
		expect(c.kind).toBe('forest');
		expect(c.virginMarMm3).toBe(0);
		expect(c.targets).toEqual({ marPercent: 0, lowFlowPercent: 0 });
		expect(c.outflowMm3.values.every((v) => v === 0)).toBe(true);
	});

	it('natural mode ⇒ the parent on its full area, children zero, no Virgin MAR (D1; TT 689 p.13)', () => {
		const r = runSfrGroup(group([userDefined(50, 50)], { kind: 'natural' }));
		expect(r.outflowMm3.values).toEqual(fullParent);
		expect(r.children[0]!.outflowMm3.values.every((v) => v === 0)).toBe(true);
		expect(r.virginMarMm3).toEqual({});
		expect(r.parentAreaKm2ByYear.every((a) => a === 100)).toBe(true);
	});

	it('calibrates a user-defined child to its targets within the closing error (TT 689 p.137, p.139)', () => {
		const r = runSfrGroup(group([userDefined(40, 30)]));
		const c = r.children[0]!;
		expect(c.converged).toBe(true);
		const last = c.iterations[c.iterations.length - 1]!;
		expect(Math.abs(last.errMar)).toBeLessThanOrEqual(defaultTolerance(last.iteration));
		expect(Math.abs(last.errLowFlow)).toBeLessThanOrEqual(defaultTolerance(last.iteration));
		expect(c.achieved!.marPercent).toBeCloseTo(40, -0.5);
		expect(c.finalParameters!.FF).toBeGreaterThan(1);
		// ΔPI = k·ΔFF over the whole calibration.
		expect(c.finalParameters!.PI - c.initialParameters!.PI).toBeCloseTo(34 * (c.finalParameters!.FF - c.initialParameters!.FF), 9);
	});

	it('reduces: 0 ≤ child flow, child MAR ≤ Virgin MAR, total MAR ≤ the free catchment’s', () => {
		const r = runSfrGroup(group([userDefined(40, 30)]));
		const c = r.children[0]!;
		expect(c.outflowMm3.values.every((v) => v >= 0)).toBe(true);
		expect(meanAnnual(c.outflowMm3.values)).toBeLessThanOrEqual(c.virginMarMm3!);
		expect(r.outflowMm3.values.every((v) => v >= 0)).toBe(true);
		expect(sum(r.outflowMm3.values)).toBeLessThanOrEqual(sum(fullParent));
		// The reduction is what the child lost: parent own + child = total.
		r.outflowMm3.values.forEach((v, i) => expect(v).toBeCloseTo(r.parentOwnMm3.values[i]! + c.outflowMm3.values[i]!, 12));
	});

	it('Smoothed Gush targets follow Table 11.1 at the parent’s MAP', () => {
		const r = runSfrGroup(group([child({})]));
		const c = r.children[0]!;
		const expected = smoothedGushTargets(child({}).afforestation.species!, parent.mapMm);
		expect(c.targets!.marPercent).toBeCloseTo(expected.marPercent, 12);
		expect(c.targets!.lowFlowPercent).toBeCloseTo(expected.lowFlowPercent, 12);
		expect(c.label).toBe('Smoothed Gush/Pitman');
	});

	it('present day holds the area at the year for every year (D1)', () => {
		const growing = userDefined(30, 30, [
			{ year: 1990, value: 10 },
			{ year: 2000, value: 30 }
		]);
		const r = runSfrGroup(group([growing], { kind: 'presentDay', year: 1995 }));
		expect(r.children[0]!.areaKm2ByYear.every((a) => a === 20)).toBe(true);
		expect(r.parentAreaKm2ByYear.every((a) => a === 80)).toBe(true);
		const h = runSfrGroup(group([growing]));
		expect(h.parentAreaKm2ByYear.slice(0, 3)).toEqual([90, 88, 86]);
	});

	it('takes a growing child’s area out of the parent year by year (TT 689 p.140)', () => {
		const growing = userDefined(0, 0, [
			{ year: 1990, value: 0 },
			{ year: 2009, value: 38 }
		]);
		const r = runSfrGroup(group([growing]));
		r.outflowMm3.values.forEach((v, i) => expect(v).toBeCloseTo(fullParent[i]!, 9));
		const c = r.children[0]!;
		expect(c.outflowMm3.values.slice(0, 12).every((v) => v === 0)).toBe(true);
		expect(c.outflowMm3.values[12 * 19 + 5]).toBeCloseTo((fullParent[12 * 19 + 5]! * 38) / 100, 9);
	});

	it('two children share the parent; each Virgin MAR is reported', () => {
		const a = userDefined(20, 20);
		const b = { ...userDefined(0, 0, [{ year: START, value: 10 }]), number: 12, outflows: [{ route: 102, percent: 100 }] };
		const r = runSfrGroup(group([a, b]));
		expect(Object.keys(r.virginMarMm3).sort()).toEqual(['11', '12']);
		expect(r.parentAreaKm2ByYear[0]).toBe(60);
	});

	it('errors when the children outgrow the parent (TT 689 p.127)', () => {
		const big = userDefined(0, 0, [{ year: START, value: 120 }]);
		const r = runSfrGroup(group([{ ...big, areaKm2: 120 }]));
		expect(r.messages.some((m) => m.level === 'error' && /exceed/.test(m.text))).toBe(true);
		expect(r.parentAreaKm2ByYear.every((a) => a === 0)).toBe(true);
	});

	it('warns when the active area passes the child’s own area (TT 689 p.139)', () => {
		const r = runSfrGroup(group([{ ...userDefined(0, 0), areaKm2: 20 }]));
		expect(r.messages.some((m) => /more than the child/.test(m.text))).toBe(true);
	});

	it('warns for FT = 0 in a parent (TT 690 p.127) and for paved area in a child (TT 689 p.140)', () => {
		const p0 = { ...parent, pitman: { ...parent.pitman, FT: 0 } };
		const r = runSfrGroup({ ...group([{ ...userDefined(0, 0), paved: { fraction: [{ year: START, value: 0.1 }] } }]), parent: p0 });
		expect(r.messages.some((m) => /FT = 0/.test(m.text))).toBe(true);
		expect(r.messages.some((m) => /paved/.test(m.text))).toBe(true);
	});

	it('an alien-vegetation child without a model runs virgin, with a warning; with a model, it is calibrated', () => {
		const alien: RunoffModule = { ...child({ areaKm2: [] }), alienVegetation: { algorithm: 1, riparianArea: 0, areaKm2: [{ year: START, value: 30 }] } };
		const none = runSfrGroup(group([alien]));
		expect(none.messages.some((m) => /no alien vegetation model/.test(m.text))).toBe(true);
		none.outflowMm3.values.forEach((v, i) => expect(v).toBeCloseTo(fullParent[i]!, 9));

		let seen: number | undefined;
		const model: ChildTargetModel = ({ virgin }) => {
			seen = virgin.marMm3;
			return { targets: { marPercent: 25, lowFlowPercent: 25 }, label: 'CSIR ALIEN Vegetation', messages: [] };
		};
		const withModel = runSfrGroup(group([alien], { kind: 'historical' }, { targets: { alien: model } }));
		expect(seen).toBeCloseTo(withModel.virginMarMm3[11]!, 12);
		expect(withModel.children[0]!.label).toBe('CSIR ALIEN Vegetation');
		expect(withModel.children[0]!.converged).toBe(true);
	});

	it('applies a target model’s after-calibration step to the child flow (riparian deduction hook)', () => {
		const model: ChildTargetModel = () => ({
			targets: { marPercent: 0, lowFlowPercent: 0 },
			label: 'test',
			messages: [],
			adjustOutflow: ({ outflowMm3 }) => ({ outflowMm3: outflowMm3.map((v) => v / 2), messages: [{ level: 'info', text: 'halved' }] })
		});
		const r = runSfrGroup(group([userDefined(0, 0)], { kind: 'historical' }, { targets: { forest: model } }));
		const c = r.children[0]!;
		expect(meanAnnual(c.outflowMm3.values)).toBeCloseTo(c.virginMarMm3! / 2, 9);
		expect(r.messages.some((m) => m.text === 'halved')).toBe(true);
	});

	it('runs the parent once and each child a bounded number of times', () => {
		simulations = 0;
		runSfrGroup(group([userDefined(40, 30)]));
		// parent + virgin + 2 Jacobian runs + at most 40 iterations.
		expect(simulations).toBeLessThanOrEqual(1 + 1 + 2 + 40);
	});

	it('warns when the iteration does not converge (TT 689 p.139: 40 iterations)', () => {
		const r = runSfrGroup(group([userDefined(99, 1)]), { maxIterations: 3, tolerance: () => 1e-6 });
		expect(r.children[0]!.converged).toBe(false);
		expect(r.children[0]!.iterations).toHaveLength(3);
		expect(r.messages.some((m) => /did not converge after 3 iterations/.test(m.text))).toBe(true);
	});

	it('rejects a simulator that returns the wrong period', () => {
		const bad: SfrSimulator = (m) => ({ ...simulate(m), outflow: { startYear: START + 1, values: [], unit: 'Mm3' } });
		expect(() => runSfrGroup(group([userDefined(0, 0)], { kind: 'historical' }, { simulate: bad }))).toThrow(/simulator returned/);
	});

	it('never changes its inputs', () => {
		const c = userDefined(40, 30);
		const before = structuredClone([parent, c]);
		runSfrGroup(group([c]));
		expect([parent, c]).toEqual(before);
	});
});
