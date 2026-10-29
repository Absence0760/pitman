import { describe, expect, it } from 'vitest';
import { potentialEvaporation, runRunoffModule, simulatePitman } from '../runoff/pitman.js';
import { syntheticNetwork } from '../synthetic/index.js';
import type { AlienVegetation, RunMode, RunoffModule } from '../types.js';
import { alienReductionTargets, alienTargetModel, riparianVolume } from './alien.js';
import { activePitman, runSfrGroup, type SfrGroupInput, type SfrSimulator } from './sfr.js';

// alienTargetModel through 6.3's parent/child mechanism (docs/theory/alien.md §4.2), synthetic only.

const START = 1990;
const END = 2009;
const net = syntheticNetwork({ years: END - START + 1, seed: 7 });
const rain = net.rainfall[0]!.series;

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

const alien = (over: Partial<AlienVegetation> = {}): AlienVegetation => ({
	algorithm: 1,
	riparianArea: 0,
	areaKm2: [{ year: START, value: 20 }, { year: END, value: 20 }],
	composition: { tallTrees: { percent: 40, ageYears: 20 }, mediumTrees: { percent: 40, ageYears: 20 }, tallShrubs: { percent: 20, ageYears: 20 } },
	optimalPercent: 50,
	...over
});

const child = (av: AlienVegetation): RunoffModule => ({
	...net.runoff[1]!,
	number: 11,
	name: 'Alien 11',
	areaKm2: 25,
	outflows: [{ route: 91, percent: 100 }],
	inflowRoute: 0,
	sfrChildren: [],
	afforestation: { ...net.runoff[1]!.afforestation, areaKm2: [] },
	alienVegetation: av
});

/** Monthly EAVE (interception + soil evaporation, R6-V10) of a module's classic run. */
function actualEvaporation(m: RunoffModule): number[] {
	const rainfallMm: number[] = [];
	for (const row of rain.rows) if (row.year >= START && row.year <= END) for (const pc of row.months) rainfallMm.push((pc / 100) * m.mapMm);
	return simulatePitman({ params: m.pitman, sPanMm: m.sPanMm, panFactors: m.panFactors, rainfallMm }).months.map((mo) => mo.E + mo.interception);
}

const runClassic = (m: RunoffModule) => runRunoffModule({ ...m, afforestation: { ...m.afforestation, areaKm2: [] }, alienVegetation: undefined, sfrChildren: [] }, rain, { startYear: START, endYear: END });
/** Classic Pitman, reporting EAVE beside its diagnostics. */
const simulate: SfrSimulator = (m) => {
	const r = runClassic(m);
	return { ...r, diagnostics: { ...r.diagnostics, actualEvaporationMm: { startYear: START, values: actualEvaporation(m), unit: 'mm' } } } as ReturnType<SfrSimulator>;
};
/** The same without EAVE. */
// A simulator whose diagnostics carry no actual evaporation (EAVE), as before R6-V10 added it to runRunoffModule.
const simulateBare: SfrSimulator = (m) => {
	const r = runClassic(m);
	const { actualEvaporationMm: _, ...diagnostics } = r.diagnostics;
	return { ...r, diagnostics };
};

const group = (av: AlienVegetation, mode: RunMode = { kind: 'historical' }, extra: Partial<SfrGroupInput> = {}): SfrGroupInput => ({
	parent,
	children: [child(av)],
	mode,
	startYear: START,
	endYear: END,
	simulate,
	targets: { alien: alienTargetModel() },
	...extra
});

describe('alienTargetModel in runSfrGroup', () => {
	it('gives the CSIR targets and the child is calibrated to them', () => {
		const r = runSfrGroup(group(alien()));
		const c = r.children[0]!;
		const t = alienReductionTargets(alien());
		expect(c.kind).toBe('alien');
		expect(c.label).toBe('CSIR ALIEN Vegetation');
		expect(c.targets).toEqual({ marPercent: t.tprm, lowFlowPercent: t.tprl });
		expect(c.converged).toBe(true);
		expect(Math.abs(c.achieved!.marPercent - t.tprm)).toBeLessThan(2);
	});

	it('riparian %: the calibrated outflow loses min(flow, ETVOL) each month (eqs. 12.10–12.12)', () => {
		const plain = runSfrGroup(group(alien())).children[0]!;
		const rip = runSfrGroup(group(alien({ riparianArea: 5 }))).children[0]!;
		// The riparian % doesn't change the targets, so the calibration is the same.
		expect(rip.finalParameters).toEqual(plain.finalParameters);
		const final = { ...inheritChild(alien({ riparianArea: 5 })), ...activeParams(plain.finalParameters!) };
		const pe = potentialEvaporation(final.sPanMm, final.panFactors, activePitman(final).FF);
		const eave = actualEvaporation({ ...final, areaKm2: 20 });
		let reduced = 0;
		plain.outflowMm3.values.forEach((q, t) => {
			const etvol = riparianVolume(Math.max(0, pe[t % 12]! - eave[t]!), 5, 20);
			expect(rip.outflowMm3.values[t]).toBeCloseTo(Math.max(0, q - etvol), 12);
			if (etvol > 0 && q > 0) reduced++;
		});
		expect(reduced).toBeGreaterThan(0);
	});

	it('without EAVE from the simulator the deduction is skipped with a warning', () => {
		const plain = runSfrGroup(group(alien(), { kind: 'historical' }, { simulate: simulateBare })).children[0]!;
		const r = runSfrGroup(group(alien({ riparianArea: 5 }), { kind: 'historical' }, { simulate: simulateBare }));
		expect(r.children[0]!.outflowMm3.values).toEqual(plain.outflowMm3.values);
		expect(r.messages.some((m) => /riparian alien vegetation .* not deducted/.test(m.text))).toBe(true);
	});

	it('natural mode: no child effect; algorithm 0: no targets', () => {
		expect(runSfrGroup(group(alien({ riparianArea: 5 }), { kind: 'natural' })).children[0]!.targets).toBeNull();
		const none = alienTargetModel()({ child: child(alien({ algorithm: 0 })), parent, mode: { kind: 'historical' }, startYear: START, endYear: END, areaKm2ByYear: [], virgin: { outflowMm3: [], marMm3: 0, lowFlowMm3: 0, run: null } });
		expect(none.targets).toBeNull();
		expect(none.adjustOutflow).toBeUndefined();
	});
});

// The child as runSfrGroup runs it: the parent's climate and parameters with the calibrated SL, ST, PI, FF.
function inheritChild(av: AlienVegetation): RunoffModule {
	return { ...child(av), mapMm: parent.mapMm, rainfallFile: parent.rainfallFile, pitman: parent.pitman, sPanMm: parent.sPanMm, panFactors: parent.panFactors };
}
function activeParams(p: { readonly PI: number; readonly FF: number; readonly SL: number; readonly ST: number }): Pick<RunoffModule, 'pitman'> {
	return { pitman: { ...parent.pitman, PI: p.PI, FF: p.FF, SL: p.SL, ST: p.ST } };
}
