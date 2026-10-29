import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readReservoir, writeReservoir } from './reservoir.js';
import { WrsmParseError } from './tokens.js';

// Synthetic fixtures only: docs/formats/examples/ and made-up text below.

const example = (name: string) => readFileSync(new URL(`../../../../docs/formats/examples/network/${name}`, import.meta.url), 'latin1');
const crlf = (lines: readonly string[]) => lines.map((l) => `${l}\r\n`).join('');

/** A made-up reservoir with the given lines from L.009 on. */
const reservoir = (tail: readonly string[], table = [' 2000', ' 1.00', ' 0.50']) =>
	crlf([
		"7 'Test dam'",
		"   500. 'TEST.RAN'  0.7000",
		`   ${table[0] === '' ? 0 : 1}`,
		...table,
		'  10.00   10.00   10.00   10.00   10.00   10.00   10.00   10.00   10.00   10.00   10.00   10.00',
		' 0.8000  0.8000  0.8000  0.8000  0.8000  0.8000  0.8000  0.8000  0.8000  0.8000  0.8000  0.8000',
		...tail
	]);

describe('readReservoir / writeReservoir: synthetic examples', () => {
	it.each(['SYRV3.DAT', 'SYRV4.DAT'])('%s round-trips byte for byte', (name) => {
		const text = example(name);
		expect(writeReservoir(readReservoir(text, name))).toBe(text);
	});

	it('reads the capacity table, routes, defined-flow file and initial storage', () => {
		const m = readReservoir(example('SYRV4.DAT'), 'SYRV4.DAT');
		expect(m).toMatchObject({ kind: 'RV', number: 4, name: 'SY Dam', mapMm: 600, rainfallFile: 'SYA.RAN', areaVolumePower: 0.65 });
		expect(m.capacity).toEqual([
			{ year: 1990, fullSupplyVolumeMm3: 5, fullSupplyAreaKm2: 1.1 },
			{ year: 1992, fullSupplyVolumeMm3: 5, fullSupplyAreaKm2: 1.1 },
			{ year: 1994, fullSupplyVolumeMm3: 7.5, fullSupplyAreaKm2: 1.45 }
		]);
		expect(m.panMm[0]).toBe(160);
		expect(m.panFactors[11]).toBe(0.8);
		expect(m.spillRoute).toBe(10);
		expect(m.inflows).toEqual([{ route: 9, definedFlowFile: null }]);
		expect(m.outflows).toEqual([
			{ route: 10, definedFlowFile: null },
			{ route: 11, definedFlowFile: 'SYDOM.abs' }
		]);
		expect(m.initialStorageMm3).toBe(2.5);
		expect(m.unpaddedRouteLines).toBeUndefined();
	});

	it('leaves the initial storage out when L.015 is absent', () => {
		expect(readReservoir(example('SYRV3.DAT'), 'SYRV3.DAT').initialStorageMm3).toBeUndefined();
	});
});

describe('readReservoir / writeReservoir: layouts', () => {
	it('reads and writes three empty table lines for NYR = 0 (D-12)', () => {
		const text = reservoir(['3    ', '0    ', '1    ', "3 ' '"], ['', '', '']);
		const m = readReservoir(text, 'T.DAT');
		expect(m.capacity).toEqual([]);
		expect(m.inflows).toEqual([]);
		expect(writeReservoir(m)).toBe(text);
	});

	it("reads a '*' monthly defined abstraction with its L.014 line (U-8) and writes it back", () => {
		const text = reservoir([
			'3    ',
			'0    ',
			'2    ',
			"3 ' '",
			"4 '*'",
			'1.000 1.000 1.000 1.000 1.000 1.000 1.000 1.000 1.000 1.000 1.000 1.250 0.400 0.500'
		]);
		const m = readReservoir(text, 'T.DAT');
		expect(m.outflows[1]).toEqual({
			route: 4,
			definedFlowFile: '*',
			monthlyAbstraction: {
				volumesMm3: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1.25],
				fullSupplyAboveMm3: 0.4,
				restrictionFactor: 0.5
			}
		});
		expect(writeReservoir(m)).toBe(text);
	});

	it('keeps count and route lines written without the 5-column padding (U-10)', () => {
		const text = reservoir(['3', '1', "2 ' '", '1', "3 ' '"]);
		const m = readReservoir(text, 'T.DAT');
		expect(m.unpaddedRouteLines).toBe(true);
		expect(writeReservoir(m)).toBe(text);
	});

	it("reads both blank spellings of 'no file' as null", () => {
		const m = readReservoir(reservoir(['3    ', '1    ', "2 ''", '1    ', "3 ' '"]), 'T.DAT');
		expect(m.inflows[0]?.definedFlowFile).toBeNull();
	});

	it('reads a leading-dot real and a negative initial storage', () => {
		const m = readReservoir(reservoir(['3    ', '0    ', '1    ', "3 ' '", '  -1.000']), 'T.DAT');
		expect(m.initialStorageMm3).toBe(-1);
		expect(readReservoir(reservoir(['3    ', '0    ', '1    ', "3 ' '", '.5']), 'T.DAT').initialStorageMm3).toBe(0.5);
	});
});

describe('readReservoir: errors name the file, line and field', () => {
	const fails = (text: string) => {
		try {
			readReservoir(text, 'TRV7.DAT');
		} catch (e) {
			expect(e).toBeInstanceOf(WrsmParseError);
			return (e as WrsmParseError).message;
		}
		throw new Error('expected a parse error');
	};

	it('a file that stops early', () => {
		expect(fails(reservoir(['3    ', '1    ']))).toBe('TRV7.DAT:11 (L.011): expected line type L.011, found end of file');
	});

	it('a non-numeric value', () => {
		expect(fails(reservoir(['x    ', '0    ', '0    ']))).toBe("TRV7.DAT:9:1 (L.009 spill route): expected a number, found 'x'");
	});

	it('a table shorter than NYR', () => {
		expect(fails(reservoir([], [' 2000', '', ' 0.50']))).toBe('TRV7.DAT:5:1 (L.005 FSV[0]): expected a number, found end of line');
	});

	it('extra values on a line', () => {
		expect(fails(reservoir(['3  4', '0    ', '0    ']))).toBe("TRV7.DAT:9:4: unexpected '4' at end of L.009");
	});

	it('a line after L.015', () => {
		expect(fails(reservoir(['3    ', '0    ', '1    ', "3 ' '", '   1.000', 'x']))).toBe(
			'TRV7.DAT:14: unexpected line after the last reservoir line type (L.015)'
		);
	});

	it('the writer refuses a value too wide for its field', () => {
		const m = readReservoir(example('SYRV3.DAT'), 'SYRV3.DAT');
		expect(() => writeReservoir({ ...m, mapMm: 12345678 })).toThrow('L.002 MAP: 12345678. does not fit F7.0');
	});
});
