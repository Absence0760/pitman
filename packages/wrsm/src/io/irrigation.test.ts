import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readIrrigation, upgradeIrrigation, writeIrrigation } from './irrigation.js';
import { WrsmParseError } from './tokens.js';
import type { IrrigationPitmanLayout } from '../types.js';

// Synthetic fixtures only: docs/formats/examples/ and made-up text below.

const example = (path: string) => readFileSync(new URL(`../../../../docs/formats/examples/${path}`, import.meta.url), 'latin1');
const SYRR6 = example('network/SYRR6.DAT');
const lines = (text: string) => text.split('\r\n').slice(0, -1);
const crlf = (ls: readonly string[]) => ls.map((l) => `${l}\r\n`).join('');

/** SYRR6 with line `index` (0-based) replaced. */
const withLine = (index: number, text: string) => crlf(lines(SYRR6).map((l, k) => (k === index ? text : l)));

/** A made-up v42 (WQT type 4) file per TT 691 pp.162–163: SYRR6's L.001–L.030, then L.031–L.040. */
const V42 = crlf([
	" 6  'SY Irrigation' 42",
	' 4',
	...lines(SYRR6).slice(2),
	'1.000 1.000 1.000 1.000 1.000 1.000 1.000 1.000 1.000 1.000 1.000 1.000',
	'0.600 0.600 0.600 0.600 0.600 0.600 0.600 0.600 0.600 0.600 0.600 0.600',
	'2 1',
	'1990 1994',
	'0.00 0.50',
	'0.000',
	'0.00',
	'400.00',
	'50.00',
	'0.000'
]);

describe('readIrrigation / writeIrrigation: v32 (WQT)', () => {
	it('SYRR6 round-trips byte for byte', () => {
		expect(writeIrrigation(readIrrigation(SYRR6, 'SYRR6.DAT'))).toBe(SYRR6);
	});

	it('reads the area table, routes and WQT parameters', () => {
		const m = readIrrigation(SYRR6, 'SYRR6.DAT');
		if (m.layout !== 'wqt') throw new Error(`layout ${m.layout}`);
		expect(m).toMatchObject({ number: 6, name: 'SY Irrigation', fileVersion: 32, modelType: 2, mapMm: 650, rainfallFile: 'SYA.RAN' });
		expect([m.droughtReduction, m.curtailByClipping]).toEqual([false, false]);
		expect(m.areaKm2).toEqual([
			{ year: 1990, value: 2 },
			{ year: 1992, value: 2.5 },
			{ year: 1994, value: 3 }
		]);
		expect(m.maxAnnualAllocationMm).toBe(9999);
		expect([m.abstractionRoute, m.returnFlowRoute, m.returnFlowPercent]).toEqual([7, 8, 10]);
		expect([m.areaInterpolation, m.maxAllocationMm3PerYear, m.allocationPoints, m.allocationInterpolation, m.runoffModule]).toEqual([1, 0, 0, 1, 1]);
		expect([m.canalSeepageToReturn, m.netReturnFlows]).toEqual([0, true]);
		expect([m.efficiencyFactor, m.returnFlowFactor, m.returnFlowUpperZone, m.returnFlowLowerZone]).toEqual([0.85, 0.02, 0.75, 0.15]);
		expect([m.soilMoistureCapacityUpperMm, m.soilMoistureCapacityLowerMm, m.soilMoistureTargetMm, m.soilMoistureInitialMm]).toEqual([400, 1000, 250, 250]);
		expect(m.aPanFactors[0]).toBe(0.55);
		expect(m.panFactors[0]).toBe(0.45);
		expect(m.effectiveRainfallLimits).toEqual([100, 0]);
	});

	it('reads the crop table', () => {
		const m = readIrrigation(SYRR6, 'SYRR6.DAT');
		if (m.layout !== 'wqt') throw new Error(`layout ${m.layout}`);
		expect(m.crops).toHaveLength(1);
		expect(m.crops[0]).toMatchObject({ percent: 100, description: 'composite' });
		expect(m.crops[0]?.factors[4]).toBe(0.6);
	});

	it('reads the allocation, return-flow growth and efficiency tables (L.022–L.030)', () => {
		const m = readIrrigation(SYRR6, 'SYRR6.DAT');
		if (m.layout !== 'wqt') throw new Error(`layout ${m.layout}`);
		expect(m.allocation).toEqual({ interpolation: 1, values: [] });
		expect(m.returnFlowGrowth).toEqual({
			interpolation: 1,
			values: [
				{ year: 1990, value: 1 },
				{ year: 1994, value: 1 }
			]
		});
		expect(m.efficiency).toEqual({ interpolation: 1, values: [] });
	});

	it('round-trips allocation and efficiency tables, which no real file has (U-11)', () => {
		const ls = lines(SYRR6);
		const text = crlf([...ls.slice(0, 21), '2 1', '1990 1994', '90.000 91.000', ...ls.slice(22, 25), '2 1', '1990 1994', '0.600 0.700']);
		const m = readIrrigation(text, 'T.DAT');
		if (m.layout !== 'wqt') throw new Error(`layout ${m.layout}`);
		expect(m.allocation.values).toEqual([
			{ year: 1990, value: 90 },
			{ year: 1994, value: 91 }
		]);
		expect(m.efficiency.values[1]).toEqual({ year: 1994, value: 0.7 });
		expect(writeIrrigation(m)).toBe(text);
	});

	it('keeps an absent L.003 clipping flag absent (D-10)', () => {
		const text = withLine(2, "650.00  'SYA.RAN' 0");
		const m = readIrrigation(text, 'T.DAT');
		expect(m.layout === 'wqt' && m.curtailByClipping).toBeUndefined();
		expect(writeIrrigation(m)).toBe(text);
	});

	it('writes no year or area line when NYR = 0 (D-12)', () => {
		const ls = lines(SYRR6);
		const text = crlf([...ls.slice(0, 3), '0', ...ls.slice(6)]);
		const m = readIrrigation(text, 'T.DAT');
		expect(m.areaKm2).toEqual([]);
		expect(writeIrrigation(m)).toBe(text);
	});
});

describe('readIrrigation / writeIrrigation: the original (Pitman) layout', () => {
	it('reads the unversioned legacy example', () => {
		const m = readIrrigation(example('legacy/SYRR22.DAT'), 'SYRR22.DAT');
		expect(m).toMatchObject({ layout: 'pitman', number: 22, name: 'SY old irrigation', fileVersion: 0, modelType: 1, mapMm: 600 });
		expect(m.areaKm2).toEqual([
			{ year: 1990, value: 1.5 },
			{ year: 1994, value: 2 }
		]);
		expect(m.pIndex[0]).toBe(0.8);
		expect(m.panMm[11]).toBe(120);
		expect(m.panFactors[1]).toBe(0.5);
		expect(m.maxAnnualAllocationMm).toBe(9999);
		expect([m.abstractionRoute, m.returnFlowRoute, m.returnFlowPercent]).toEqual([7, 0, 0]);
	});

	it('writes it upgraded to v32 with the same L.001–L.012 values (docs/formats.md §8.2)', () => {
		const m = readIrrigation(example('legacy/SYRR22.DAT'), 'SYRR22.DAT') as IrrigationPitmanLayout;
		const written = writeIrrigation(m);
		expect(lines(written).slice(0, 3)).toEqual([" 22  'SY old irrigation' 32", ' 1', "600.00  'SYA.RAN' 0 0"]);
		const reread = readIrrigation(written, 'SYRR22.DAT');
		expect(reread).toEqual(upgradeIrrigation(m));
		expect(reread).toMatchObject({ layout: 'wqt', modelType: 1, crops: [{ factors: m.panFactors, percent: 100, description: 'composite' }] });
		expect(writeIrrigation(reread)).toBe(written);
	});

	it("reads the manual's 12-line v32 layout (TT 691 pp.158–159) as 'pitman'", () => {
		const text = crlf([
			" 4  'Test irrigation' 32",
			' 1',
			"700.00  'TEST.RAN'",
			'2',
			'1970 1990',
			'10.00 10.00',
			...lines(SYRR6).slice(6, 12)
		]);
		const m = readIrrigation(text, 'T.DAT');
		expect(m).toMatchObject({ layout: 'pitman', fileVersion: 32, modelType: 1, returnFlowRoute: 8 });
	});
});

describe('readIrrigation / writeIrrigation: v42 (WQT type 4, manual only, U-11)', () => {
	it('reads L.031–L.040', () => {
		const m = readIrrigation(V42, 'T.DAT');
		if (m.layout !== 'wqt4') throw new Error(`layout ${m.layout}`);
		expect(m.modelType).toBe(4);
		expect(m.minRainfallFactors[0]).toBe(1);
		expect(m.maxRainfallFactors[11]).toBe(0.6);
		expect(m.capacity).toEqual({
			interpolation: 1,
			values: [
				{ year: 1990, value: 0 },
				{ year: 1994, value: 0.5 }
			]
		});
		expect([m.canalTransmissionLoss, m.deepSeatedGroundwater, m.maxUpperZoneStorageMm, m.minUpperZoneStorageMm, m.canalEndSpill]).toEqual([0, 0, 400, 50, 0]);
		expect(m.returnFlowGrowth.values).toHaveLength(2);
	});

	it('refuses to write it (docs/formats.md §8.1)', () => {
		expect(() => writeIrrigation(readIrrigation(V42, 'T.DAT'))).toThrow('writing WQT type 4 (file version 42) is not supported');
	});
});

describe('readIrrigation: errors name the file, line and field', () => {
	const fails = (text: string) => {
		try {
			readIrrigation(text, 'TRR6.DAT');
		} catch (e) {
			expect(e).toBeInstanceOf(WrsmParseError);
			return (e as WrsmParseError).message;
		}
		throw new Error('expected a parse error');
	};

	it('an unknown file version', () => {
		expect(fails(withLine(0, " 6  'SY Irrigation' 33"))).toBe(
			"TRR6.DAT:1:21 (L.001 version): irrigation file version '33' is not supported (known: none, 32, 42)"
		);
	});

	it('a flag other than 0 or 1', () => {
		expect(fails(withLine(13, '0.000 2'))).toBe("TRR6.DAT:14:7 (L.014 NETRETFLOWS): expected 0 or 1, found '2'");
	});

	it('a model type outside 1–4', () => {
		expect(fails(withLine(1, ' 5'))).toBe('TRR6.DAT:2:2 (L.002 MODEL): model type 5 is not 1–4');
	});

	it('a crop line missing its name', () => {
		expect(fails(withLine(19, '0.450 0.500 0.480 0.480 0.600 0.550 0.400 0.300 0.250 0.250 0.300 0.400 100.00'))).toBe(
			'TRR6.DAT:20:79 (L.020 crop): expected a quoted string, found end of line'
		);
	});

	it('a v32 file that stops inside the WQT lines', () => {
		expect(fails(crlf(lines(SYRR6).slice(0, 16)))).toBe('TRR6.DAT:17 (L.017): expected line type L.017, found end of file');
	});

	it('a v32 file missing the drought flag', () => {
		expect(fails(withLine(2, "650.00  'SYA.RAN'"))).toBe('TRR6.DAT:3:18 (L.003 DROUGHT_APPLICABLE): a WQT file (more than 12 lines) needs the drought flag');
	});
});
