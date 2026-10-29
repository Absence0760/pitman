import { describe, expect, it } from 'vitest';
import type { HughesParameters, RunoffModule, SamiParameters } from '../types.js';
import { applyRunMode, holdYearTable } from './modes.js';
import { syntheticBundle } from './synthetic-bundle.js';

const base = syntheticBundle().modules.find((m): m is RunoffModule => m.kind === 'RU')!;

const developed: RunoffModule = {
	...base,
	afforestation: { algorithm: 2, algorithmInFile: true, areaKm2: [{ year: 1990, value: 2 }, { year: 2000, value: 6 }] },
	alienVegetation: { algorithm: 1, riparianArea: 0, areaKm2: [{ year: 1995, value: 1 }, { year: 2005, value: 3 }] } as RunoffModule['alienVegetation'],
	paved: { fraction: [{ year: 1990, value: 0.01 }, { year: 2010, value: 0.05 }] },
	sami: { abstractions: [{ year: 1990, value: 0.1 }, { year: 2000, value: 0.3 }] } as unknown as SamiParameters,
	hughes: { upperAbstraction: { annual: 2, monthlyPercent: [] }, riparianAbstraction: { annual: 1, monthlyPercent: [] } } as unknown as HughesParameters
};

describe('holdYearTable', () => {
	it('holds a table at its interpolated value in the year (OQ-17)', () => {
		expect(holdYearTable([{ year: 1990, value: 2 }, { year: 2000, value: 6 }], 1995)).toEqual([{ year: 1995, value: 4 }]);
	});

	it('holds flat beyond the last year and before the first', () => {
		expect(holdYearTable([{ year: 1990, value: 2 }, { year: 2000, value: 6 }], 2025)).toEqual([{ year: 2025, value: 6 }]);
		expect(holdYearTable([{ year: 1990, value: 2 }, { year: 2000, value: 6 }], 1950)).toEqual([{ year: 1950, value: 2 }]);
	});

	it('keeps an empty table empty', () => {
		expect(holdYearTable([], 2025)).toEqual([]);
	});
});

describe('applyRunMode (runoff modules, D1)', () => {
	it('returns the module unchanged in historical mode', () => {
		expect(applyRunMode(developed, { kind: 'historical' })).toBe(developed);
	});

	it('holds every development year table at the present-day year', () => {
		const m = applyRunMode(developed, { kind: 'presentDay', year: 2000 });
		expect(m.afforestation.areaKm2).toEqual([{ year: 2000, value: 6 }]);
		expect(m.alienVegetation!.areaKm2).toEqual([{ year: 2000, value: 2 }]);
		expect(m.paved!.fraction[0]!.year).toBe(2000);
		expect(m.paved!.fraction[0]!.value).toBeCloseTo(0.03, 12);
		expect(m.sami!.abstractions).toEqual([{ year: 2000, value: 0.3 }]);
		// Constants need no holding.
		expect(m.hughes).toBe(developed.hughes);
		expect(m.pitman).toBe(developed.pitman);
		expect(m.afforestation.algorithm).toBe(2);
	});

	it('removes paved area, afforestation, alien vegetation and groundwater abstractions in natural mode (TT 689 p.27)', () => {
		const m = applyRunMode(developed, { kind: 'natural' });
		expect(m.afforestation.areaKm2).toEqual([]);
		expect(m.alienVegetation!.areaKm2).toEqual([]);
		expect(m.paved!.fraction).toEqual([]);
		expect(m.sami!.abstractions).toEqual([]);
		expect(m.hughes!.upperAbstraction.annual).toBe(0);
		expect(m.hughes!.riparianAbstraction.annual).toBe(0);
		expect(m.areaKm2).toBe(developed.areaKm2);
		expect(m.outflows).toBe(developed.outflows);
	});

	it('never changes its input', () => {
		const before = structuredClone(developed);
		applyRunMode(developed, { kind: 'natural' });
		applyRunMode(developed, { kind: 'presentDay', year: 2025 });
		expect(developed).toEqual(before);
	});

	it('leaves absent optional blocks absent', () => {
		const bare: RunoffModule = { ...base, alienVegetation: undefined, paved: undefined } as unknown as RunoffModule;
		const m = applyRunMode(bare, { kind: 'natural' });
		expect(m.paved).toBeUndefined();
		expect(m.sami).toBeUndefined();
	});
});
