/**
 * Synthetic irrigation blocks for the tests: invented numbers in the ranges
 * the manuals' examples use (TT 691 pp.158–176). Not exported from the package.
 */

import { upgradeIrrigation } from '../io/irrigation.js';
import type { IrrigationPitmanLayout, IrrigationWqt4Layout, IrrigationWqtLayout, Monthly12, MonthlyRow, RainfallSeries } from '../types.js';

export const twelve = (v: number): Monthly12 => Array.from({ length: 12 }, () => v) as unknown as Monthly12;

export function pitmanBlock(over: Partial<IrrigationPitmanLayout> = {}): IrrigationPitmanLayout {
	return {
		kind: 'RR',
		layout: 'pitman',
		number: 1,
		name: 'Test block',
		fileVersion: 0,
		modelType: 1,
		mapMm: 600,
		rainfallFile: 'T.RAN',
		areaKm2: [{ year: 2000, value: 10 }],
		pIndex: twelve(0.5),
		panMm: twelve(200),
		panFactors: twelve(0.8),
		maxAnnualAllocationMm: 9999,
		effectiveRainfallFactors: twelve(0.5),
		abstractionRoute: 7,
		returnFlowRoute: 8,
		returnFlowPercent: 10,
		...over
	};
}

/** WQT type 2 on one composite crop: efficiency 0.8, no canal, no allocation. */
export function wqtBlock(over: Partial<IrrigationWqtLayout> = {}): IrrigationWqtLayout {
	return {
		...upgradeIrrigation(pitmanBlock()),
		modelType: 2,
		efficiencyFactor: 0.8,
		rainfallFactors: twelve(0.5),
		aPanFactors: twelve(0.9),
		crops: [{ factors: twelve(0.8), percent: 100, description: 'composite' }],
		soilMoistureCapacityUpperMm: 400,
		soilMoistureTargetMm: 250,
		soilMoistureInitialMm: 250,
		returnFlowFactor: 0.02,
		effectiveRainfallLimits: [0, 0],
		...over
	};
}

/** WQT type 4, version 42. */
export function wqt4Block(over: Partial<IrrigationWqt4Layout> = {}): IrrigationWqt4Layout {
	return {
		...wqtBlock(),
		layout: 'wqt4',
		fileVersion: 42,
		modelType: 4,
		panFactors: twelve(0.5),
		minRainfallFactors: twelve(1),
		maxRainfallFactors: twelve(0.5),
		capacity: { interpolation: 1, values: [] },
		canalTransmissionLoss: 0,
		deepSeatedGroundwater: 0,
		maxUpperZoneStorageMm: 700,
		minUpperZoneStorageMm: 0,
		canalEndSpill: 0,
		...over
	};
}

export function rainfallOf(rows: readonly (readonly [number, number])[]): RainfallSeries {
	return { code: 'T', rows: rows.map(([year, pc]): MonthlyRow => ({ year, months: twelve(pc) })) };
}

/** A varied % MAP record: deterministic, wet and dry months and years, for the invariants. */
export function variedRainfall(startYear: number, endYear: number): RainfallSeries {
	const rows: MonthlyRow[] = [];
	for (let year = startYear; year <= endYear; year++) {
		const wet = 1 + 0.9 * Math.sin(year * 1.7);
		const months = Array.from({ length: 12 }, (_, m) => Math.max(0, 8.3 * wet * (1 + Math.cos((m / 12) * 2 * Math.PI + year)))) as unknown as Monthly12;
		rows.push({ year, months });
	}
	return { code: 'T', rows };
}
