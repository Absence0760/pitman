import { describe, expect, it } from 'vitest';
import type { RunMode } from '../types.js';
import { droughtFactor, effectiveRainfall, interpolateYearTable, irrigationDemand, IrrigationRunError, proportion, sapwatEffectiveRainfall, unitCropDemand } from './demand.js';
import { pitmanBlock, rainfallOf, twelve, wqt4Block, wqtBlock } from './fixtures.js';

const HISTORICAL: RunMode = { kind: 'historical' };
/** One year at 5 % MAP a month: 30 mm on a 600 mm block. */
const year = (over = 5) => rainfallOf([[2000, over]]);

describe('the Pitman method, TT 690 ch.3 p.11', () => {
	it('computes G, N and V (eqs. 3.1–3.3)', () => {
		const d = irrigationDemand(pitmanBlock(), year(), HISTORICAL, 2000, 2000);
		expect(d.modelType).toBe(1);
		expect(d.cropDemandMm[0]).toBeCloseTo(160, 10); // 200 × 0.8
		expect(d.unitDemandMm[0]).toBeCloseTo(145, 10); // 160 − 30 × 0.5
		expect(d.gross.values[0]).toBeCloseTo(0.725, 10); // 0.001 × 145 × 10 × 0.5
	});

	it('never lets N go negative (eq. 3.2)', () => {
		const d = irrigationDemand(pitmanBlock({ panFactors: twelve(0.01) }), year(), HISTORICAL, 2000, 2000);
		expect(d.unitDemandMm[0]).toBe(0);
		expect(d.gross.values[0]).toBe(0);
	});

	it('reduces every month in proportion when the annual depth passes PERM (TT 689 p.95)', () => {
		// Depth without a limit: 145 × 0.5 × 12 = 870 mm.
		const d = irrigationDemand(pitmanBlock({ maxAnnualAllocationMm: 435 }), year(), HISTORICAL, 2000, 2000);
		expect(d.gross.values[0]).toBeCloseTo(0.3625, 10);
		expect(d.gross.values.reduce((s, v) => s + v, 0)).toBeCloseTo(4.35, 10); // 435 mm over 10 km²
	});

	it('generates no abstraction at all with PERM = 0 (TT 689 p.95)', () => {
		const d = irrigationDemand(pitmanBlock({ maxAnnualAllocationMm: 0 }), year(), HISTORICAL, 2000, 2000);
		expect(d.gross.values.every((v) => v === 0)).toBe(true);
	});

	it('takes the 12-line layout as type 1 whatever L.002 says', () => {
		expect(irrigationDemand(pitmanBlock({ modelType: 2 }), year(), HISTORICAL, 2000, 2000).modelType).toBe(1);
	});
});

describe('effective rainfall', () => {
	it('applies the factor above the upper limit and all of it below the lower (eqs. 5.4, 5.6)', () => {
		expect(effectiveRainfall(150, 0.4, 1, 100, 0)).toBeCloseTo(60, 10);
		expect(effectiveRainfall(10, 0.4, 1, 100, 20)).toBeCloseTo(10, 10);
	});

	it('interpolates the factor between the limits, ERF at the top and 1 at the bottom (eq. 5.5 as corrected, TT 689 p.97)', () => {
		// Half way: (0.4 + 1) / 2 = 0.7 of 50 mm. Eq. 5.5 as printed would give (1 + 0.3) × 50.
		expect(effectiveRainfall(50, 0.4, 1, 100, 0)).toBeCloseTo(35, 10);
		expect(effectiveRainfall(99.999, 0.4, 1, 100, 0)).toBeCloseTo(40, 2);
		expect(effectiveRainfall(0.001, 0.4, 1, 100, 0)).toBeCloseTo(0.001, 5);
	});

	it('uses RRERFM below the lower limit for type 4 (eqs. 6.18a–c)', () => {
		expect(effectiveRainfall(10, 0.3, 0.9, 100, 20)).toBeCloseTo(9, 10); // 6.18a
		expect(effectiveRainfall(60, 0.3, 0.9, 100, 20)).toBeCloseTo(36, 10); // 6.18b: (0.3 + 0.6 × 40/80) × 60
		expect(effectiveRainfall(120, 0.3, 0.9, 100, 20)).toBeCloseTo(36, 10); // 6.18c
	});

	it('copes with equal limits, as Table 5.2 asks', () => {
		expect(effectiveRainfall(50, 0.4, 1, 0, 0)).toBeCloseTo(20, 10);
		expect(effectiveRainfall(0, 0.4, 1, 0, 0)).toBe(0);
		expect(effectiveRainfall(50, 0.4, 1, 890, 890)).toBeCloseTo(50, 10);
	});

	it('follows the SAPWAT quadratic (eqs. 5.7, 6.19b), ET capped at 75 mm', () => {
		// −0.001 × 2500 + 0.025 × 2500 / 75 + 0.0016 × 50 × 75 + 0.6 × 50 = 34.3333…
		expect(sapwatEffectiveRainfall(50, 75)).toBeCloseTo(34.3333333, 6);
		expect(sapwatEffectiveRainfall(50, 150)).toBeCloseTo(34.3333333, 6);
		// ET 40: −2.5 + 1.5625 + 3.2 + 30 = 32.2625
		expect(sapwatEffectiveRainfall(50, 40)).toBeCloseTo(32.2625, 6);
	});

	it('keeps the SAPWAT rainfall between 0 and the rain, and 0 with no ET (R7-I8)', () => {
		expect(sapwatEffectiveRainfall(5000, 75)).toBe(0);
		expect(sapwatEffectiveRainfall(100, 1)).toBe(100);
		expect(sapwatEffectiveRainfall(50, 0)).toBe(0);
	});
});

describe('crop demand', () => {
	const crops = [
		{ factors: twelve(1), percent: 60, description: 'a' },
		{ factors: twelve(0.1), percent: 40, description: 'b' }
	];

	it('counts positive crop demand only, crop by crop (eq. 4.1, R7-I5)', () => {
		// a: 0.6 × (100 − 50) = 30; b: 0.4 × (10 − 50) = −16, dropped.
		expect(unitCropDemand(crops, 100, 0, 50, 'perCrop')).toBeCloseTo(30, 10);
	});

	it('can clip the total instead (eq. 6.17a read as p.35)', () => {
		expect(unitCropDemand(crops, 100, 0, 50, 'total')).toBeCloseTo(14, 10);
		expect(unitCropDemand(crops, 100, 0, 500, 'total')).toBe(0);
	});

	it('ignores a crop on under 0.01 % of the area (TT 689 p.96)', () => {
		const tiny = [{ factors: twelve(1), percent: 0.001, description: 'x' }];
		expect(unitCropDemand(tiny, 100, 0, 0, 'perCrop')).toBe(0);
	});
});

describe('WQT type 2, TT 690 ch.4', () => {
	it('builds QIG from DIN, efficiency and canal loss (eqs. 4.1–4.6)', () => {
		const d = irrigationDemand(wqtBlock({ canalFlowLoss: 0.2 }), year(), HISTORICAL, 2000, 2000);
		// ER = 0.5 × 30 = 15; DIN = 200 × 0.8 − 15 = 145.
		expect(d.unitDemandMm[0]).toBeCloseTo(145, 10);
		expect(d.cropDemandMm[0]).toBeCloseTo(160, 10);
		expect(d.openWaterEvaporationMm[0]).toBeCloseTo(180, 10); // A-pan × L.018
		// (145 × 10 / 1000) × (1 / 0.8) × (1 / 0.8)
		expect(d.gross.values[0]).toBeCloseTo(2.265625, 10);
		expect(d.targetAreaKm2[0]).toBe(10);
	});

	it('scales the target area and every month to the annual allocation (eq. 4.8)', () => {
		const d = irrigationDemand(wqtBlock({ maxAllocationMm3PerYear: 10.875 }), year(), HISTORICAL, 2000, 2000);
		// Unlimited: 1.8125 a month, 21.75 a year; ALL is half of that.
		expect(d.gross.values[0]).toBeCloseTo(0.90625, 10);
		expect(d.targetAreaKm2[0]).toBeCloseTo(5, 10);
		expect(d.areaKm2[0]).toBe(10);
		expect(d.messages).toContainEqual(expect.objectContaining({ level: 'info', text: expect.stringContaining('allocation limits irrigation in 1 year') }));
	});

	it('clips high months at the even monthly value when L.003 v4 asks (TT 691 p.161, R7-I10)', () => {
		const months = [10, 10, 10, 10, 10, 10, 0, 0, 0, 0, 0, 0] as const;
		const rain = { code: 'T', rows: [{ year: 2000, months: months as unknown as ReturnType<typeof twelve> }] };
		const block = wqtBlock({ maxAllocationMm3PerYear: 12, curtailByClipping: true, rainfallFactors: twelve(1) });
		const d = irrigationDemand(block, rain, HISTORICAL, 2000, 2000);
		expect(d.gross.values[0]).toBeCloseTo(1, 10);
		expect(d.gross.values[6]).toBeCloseTo(1, 10);
		expect(Math.max(...d.gross.values)).toBeCloseTo(1, 10);
		expect(d.targetAreaKm2[6]).toBeCloseTo(10 * (1 / 2), 10); // the unlimited month is 2.0
	});

	it('takes a zero RRMA as no limit by default and as no water on request (R7-I4)', () => {
		const block = wqtBlock({ maxAllocationMm3PerYear: 0 });
		expect(irrigationDemand(block, year(), HISTORICAL, 2000, 2000).gross.values[0]).toBeCloseTo(1.8125, 10);
		expect(irrigationDemand(block, year(), HISTORICAL, 2000, 2000, { zeroAllocation: 'noWater' }).gross.values[0]).toBe(0);
	});

	it('grows the allocation, efficiency and return factor by year for types 2–3 (TT 689 pp.98, 102, 106)', () => {
		const block = wqtBlock({
			efficiencyFactor: 0.8,
			efficiency: { interpolation: 1, values: [{ year: 2000, value: 1 }, { year: 2002, value: 0.5 }] },
			returnFlowGrowth: { interpolation: 1, values: [{ year: 2000, value: 1 }, { year: 2002, value: 2 }] }
		});
		const d = irrigationDemand(block, rainfallOf([[2000, 5], [2001, 5], [2002, 5]]), HISTORICAL, 2000, 2002);
		expect(d.efficiency[12]).toBeCloseTo(0.6, 10);
		expect(d.returnFlowFactor[24]).toBeCloseTo(0.04, 10);
	});

	it('reads an efficiency and return factor above 1 as percentages (TT 690 eq. 4.3, TT 691 p.160, R7-I6)', () => {
		expect(proportion(96)).toBeCloseTo(0.96, 10);
		expect(proportion(0.85)).toBe(0.85);
		const d = irrigationDemand(wqtBlock({ efficiencyFactor: 96, returnFlowFactor: 6 }), year(), HISTORICAL, 2000, 2000);
		expect(d.efficiency[0]).toBeCloseTo(0.96, 10);
		expect(d.returnFlowFactor[0]).toBeCloseTo(0.06, 10);
		expect(d.messages.filter((m) => /percentage/.test(m.text))).toHaveLength(2);
	});

	it('refuses an efficiency of 0 and a canal that loses everything', () => {
		expect(() => irrigationDemand(wqtBlock({ efficiencyFactor: 0 }), year(), HISTORICAL, 2000, 2000)).toThrow(IrrigationRunError);
		expect(() => irrigationDemand(wqtBlock({ canalFlowLoss: 1 }), year(), HISTORICAL, 2000, 2000)).toThrow(/TLPQ/);
	});
});

describe('the drought factor, eqs. 5.8, 6.21a', () => {
	it('is the wetter of the month and the year against their means, capped at 1', () => {
		expect(droughtFactor(50, 100, 800, 1000)).toBeCloseTo(0.8, 10);
		expect(droughtFactor(90, 100, 500, 1000)).toBeCloseTo(0.9, 10);
		expect(droughtFactor(300, 100, 500, 1000)).toBe(1);
		expect(droughtFactor(0, 0, 0, 1000)).toBe(0);
	});

	it('reduces DIN for types 2–3, against the means over the whole file (eq. 5.9)', () => {
		const block = wqtBlock({ droughtReduction: true });
		const rain = rainfallOf([[2000, 5], [2001, 15]]); // mean 10 % a month, 120 mm a year... 2000 is half of it
		const d = irrigationDemand(block, rain, HISTORICAL, 2000, 2000);
		expect(d.droughtFactor[0]).toBeCloseTo(0.5, 10);
		expect(d.unitDemandMm[0]).toBeCloseTo(72.5, 10);
	});

	it('uses MAP for the year in type 4 (eq. 6.21a)', () => {
		const block = wqt4Block({ droughtReduction: true, rainfallFactors: twelve(1), maxRainfallFactors: twelve(1), effectiveRainfallLimits: [0, 0] });
		const rain = rainfallOf([[2000, 4], [2001, 4]]); // 4 % × 12 = 48 % of MAP in both years; month and mean equal
		const d = irrigationDemand(block, rain, HISTORICAL, 2000, 2000);
		expect(d.droughtFactor[0]).toBeCloseTo(1, 10); // the month equals its mean
		const dry = irrigationDemand(block, rainfallOf([[2000, 4], [2001, 12]]), HISTORICAL, 2000, 2000);
		expect(dry.droughtFactor[0]).toBeCloseTo(0.5, 10); // month 24 mm / mean 48 mm; the year is 48 % of MAP, below that
	});

	it('does nothing when the flag is off (eq. 6.21b)', () => {
		expect(irrigationDemand(wqtBlock(), year(), HISTORICAL, 2000, 2000).droughtFactor.every((v) => v === 1)).toBe(true);
	});
});

describe('WQT-SAPWAT, TT 690 ch.5', () => {
	it('takes the first crop row as ET and ignores the rest (TT 689 p.96; Table 5.1)', () => {
		const block = wqtBlock({
			modelType: 3,
			crops: [
				{ factors: twelve(150), percent: 100, description: 'representative' },
				{ factors: twelve(900), percent: 100, description: 'ignored' }
			]
		});
		const d = irrigationDemand(block, year(), HISTORICAL, 2000, 2000);
		// ER on 30 mm, ET capped at 75: −0.9 + 0.3 + 3.6 + 18 = 21; DIN = 150 − 21.
		expect(d.unitDemandMm[0]).toBeCloseTo(129, 8);
		expect(d.cropDemandMm[0]).toBe(150);
		expect(d.gross.values[0]).toBeCloseTo((129 * 10) / 1000 / 0.8, 8);
	});

	it('needs a crop line', () => {
		expect(() => irrigationDemand(wqtBlock({ modelType: 3, crops: [] }), year(), HISTORICAL, 2000, 2000)).toThrow(/SAPWAT/);
	});
});

describe('WQT type 4, TT 690 §6.6', () => {
	const flat = { rainfallFactors: twelve(0.5), maxRainfallFactors: twelve(0.5), effectiveRainfallLimits: [0, 0] as const };

	it('builds QID, QID1 and QIG (eqs. 6.20, 6.22, 6.23)', () => {
		const d = irrigationDemand(wqt4Block({ ...flat, canalFlowLoss: 0.2 }), year(), HISTORICAL, 2000, 2000);
		expect(d.modelType).toBe(4);
		expect(d.gross.values[0]).toBeCloseTo(((145 * 10) / 1000 / 0.8) / 0.8, 10);
		expect(d.openWaterEvaporationMm[0]).toBeCloseTo(100, 10); // A-pan × L.009, not L.018
	});

	it('takes L.030 as the efficiency itself, not a growth (TT 689 p.102), and RRIE when it is empty', () => {
		const block = wqt4Block({ ...flat, efficiency: { interpolation: 1, values: [{ year: 2000, value: 0.5 }] } });
		expect(irrigationDemand(block, year(), HISTORICAL, 2000, 2000).efficiency[0]).toBeCloseTo(0.5, 10);
		expect(irrigationDemand(wqt4Block(flat), year(), HISTORICAL, 2000, 2000).efficiency[0]).toBeCloseTo(0.8, 10);
	});

	it('limits a month to the system capacity (eq. 6.24); a capacity of 0 is no limit (R7-I15)', () => {
		const capped = wqt4Block({ ...flat, capacity: { interpolation: 1, values: [{ year: 2000, value: 1 }] } });
		expect(irrigationDemand(capped, year(), HISTORICAL, 2000, 2000).gross.values[0]).toBe(1);
		const zero = wqt4Block({ ...flat, capacity: { interpolation: 1, values: [{ year: 2000, value: 0 }] } });
		expect(irrigationDemand(zero, year(), HISTORICAL, 2000, 2000).gross.values[0]).toBeCloseTo(1.8125, 10);
	});

	it('spreads the allocation by DFAC and carries the unused part forward within the year (eqs. 6.25–6.29)', () => {
		// Winter rain makes the actual demand small in months 0–5, while the mean says the months are equal.
		const months = twelve(5).map((v, m) => (m < 6 ? 40 : 0)) as unknown as ReturnType<typeof twelve>;
		const wetFirst = { year: 2000, months };
		const dryFirst = { year: 2001, months: [...months].reverse() as unknown as ReturnType<typeof twelve> };
		const block = wqt4Block({ ...flat, maxAllocationMm3PerYear: 12, efficiencyFactor: 1 });
		const d = irrigationDemand(block, { code: 'T', rows: [wetFirst, dryFirst] }, HISTORICAL, 2000, 2000);
		// Rain 240 mm: ER 120, DIN 40, QIG 0.4, so 0.6 of each month's 1.0 stays. Dry months want 1.6.
		expect(d.gross.values[0]).toBeCloseTo(0.4, 10);
		expect(d.gross.values[6]).toBeCloseTo(1.6, 10); // 1.0 + 0.6 of ACCALOC… and the surplus continues
		const total = d.gross.values.reduce((s, v) => s + v, 0);
		expect(total).toBeLessThanOrEqual(12 + 1e-9);
		expect(total).toBeCloseTo(12, 10); // 2.4 + 9.6: every drop of the year's allocation used
	});

	it('does not carry a surplus into the next year (eq. 6.28a)', () => {
		const block = wqt4Block({ ...flat, maxAllocationMm3PerYear: 6, efficiencyFactor: 1 });
		const months = twelve(5).map((v, m) => (m < 11 ? 80 : 0)) as unknown as ReturnType<typeof twelve>;
		const rain = { code: 'T', rows: [{ year: 2000, months }, { year: 2001, months: twelve(0) }] };
		const d = irrigationDemand(block, rain, HISTORICAL, 2000, 2001);
		expect(d.gross.values.slice(12).reduce((s, v) => s + v, 0)).toBeCloseTo(6, 10);
	});

	it('treats L.024 as the allocation itself for type 4 (TT 689 p.98)', () => {
		const block = wqt4Block({ ...flat, maxAllocationMm3PerYear: 500, efficiencyFactor: 1, allocation: { interpolation: 1, values: [{ year: 2000, value: 1.2 }] } });
		const d = irrigationDemand(block, year(), HISTORICAL, 2000, 2000);
		expect(d.gross.values.reduce((s, v) => s + v, 0)).toBeCloseTo(1.2, 10);
	});

	it('warns when a minimum rainfall factor is above its maximum, as TT 691 pp.172–174 has it (R7-I14)', () => {
		const block = wqt4Block({ rainfallFactors: twelve(1), maxRainfallFactors: twelve(0.6) });
		expect(irrigationDemand(block, year(), HISTORICAL, 2000, 2000).messages).toContainEqual(expect.objectContaining({ level: 'warning', text: expect.stringContaining('L.032') }));
	});

	it('refuses type 4 in a v32 layout (R7-I1)', () => {
		expect(() => irrigationDemand(wqtBlock({ modelType: 4 }), year(), HISTORICAL, 2000, 2000)).toThrow(/version 42/);
	});
});

describe('year tables and the run modes (D1)', () => {
	const areas = [{ year: 2000, value: 10 }, { year: 2002, value: 30 }];
	const rain = rainfallOf([[2000, 5], [2001, 5], [2002, 5], [2003, 5]]);

	it('interpolates by code: linear, exponential, stepped (U-14), flat beyond the table', () => {
		expect(interpolateYearTable(areas, 2001, 1)).toBeCloseTo(20, 10);
		expect(interpolateYearTable(areas, 2001, 2)).toBeCloseTo(Math.sqrt(300), 10);
		expect(interpolateYearTable(areas, 2001, 3)).toBe(10);
		expect(interpolateYearTable(areas, 1990, 1)).toBe(10);
		expect(interpolateYearTable(areas, 2020, 2)).toBe(30);
		expect(interpolateYearTable([{ year: 2000, value: 0 }, { year: 2002, value: 30 }], 2001, 2)).toBeCloseTo(15, 10); // a zero end stays linear
	});

	it('historical follows the table', () => {
		const d = irrigationDemand(pitmanBlock({ areaKm2: areas }), rain, HISTORICAL, 2000, 2003);
		expect([d.areaKm2[0], d.areaKm2[12], d.areaKm2[24], d.areaKm2[36]]).toEqual([10, 20, 30, 30]);
	});

	it('present day holds the area, and everything from it, at the chosen year', () => {
		const d = irrigationDemand(pitmanBlock({ areaKm2: areas }), rain, { kind: 'presentDay', year: 2001 }, 2000, 2003);
		expect(new Set(d.areaKm2)).toEqual(new Set([20]));
		expect(new Set(d.gross.values.map((v) => v.toFixed(9))).size).toBe(1);
	});

	it('present day beyond the table holds its last value', () => {
		const d = irrigationDemand(pitmanBlock({ areaKm2: areas }), rain, { kind: 'presentDay', year: 2025 }, 2000, 2003);
		expect(d.areaKm2[0]).toBe(30);
	});

	it('natural has no irrigation and reads no rainfall', () => {
		const d = irrigationDemand(pitmanBlock({ areaKm2: areas }), undefined, { kind: 'natural' }, 2000, 2003);
		expect(d.gross.values.every((v) => v === 0)).toBe(true);
		expect(d.areaKm2.every((v) => v === 0)).toBe(true);
	});

	it('warns on an area table that does not span a historical run (TT 689 p.82)', () => {
		const d = irrigationDemand(pitmanBlock({ areaKm2: areas }), rain, HISTORICAL, 2000, 2003);
		expect(d.messages).toContainEqual(expect.objectContaining({ level: 'warning', text: expect.stringContaining("don't cover the run") }));
	});

	it('warns when a block has no area at all', () => {
		const d = irrigationDemand(pitmanBlock({ areaKm2: [] }), year(), HISTORICAL, 2000, 2000);
		expect(d.gross.values.every((v) => v === 0)).toBe(true);
		expect(d.messages[0]).toMatchObject({ level: 'warning', text: expect.stringContaining('irrigates nothing') });
	});

	it('names the module and the year when rainfall is missing', () => {
		expect(() => irrigationDemand(pitmanBlock(), year(), HISTORICAL, 2000, 2001)).toThrow(/RR 1 \(Test block\).*no year 2001/);
		expect(() => irrigationDemand(pitmanBlock(), undefined, HISTORICAL, 2000, 2000)).toThrow(/rainfall file 'T\.RAN'/);
	});
});
