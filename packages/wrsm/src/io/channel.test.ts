import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readChannel, writeChannel } from './channel.js';
import { WrsmParseError } from './tokens.js';

// Synthetic fixtures only: docs/formats/examples/ and made-up text below.

const example = readFileSync(new URL('../../../../docs/formats/examples/network/SYCR5.DAT', import.meta.url), 'latin1');
const crlf = (lines: readonly string[]) => lines.map((l) => `${l}\r\n`).join('');

/** Lines of a made-up channel; `routes` replaces L.006–L.010, `tail` L.011 on. */
const channel = (routes: readonly string[], tail: readonly string[]) =>
	crlf([
		"8 'Test reach'   2",
		"     0. ' '",
		'   0.00    1.00    1.00    1.00',
		'  10.00   10.00   10.00   10.00   10.00   10.00   10.00   10.00   10.00   10.00   10.00   10.00',
		' 1.0000  1.0000  1.0000  1.0000  1.0000  1.0000  1.0000  1.0000  1.0000  1.0000  1.0000  1.0000',
		...routes,
		...tail
	]);

const WETLAND_TAIL = [
	'   1   0',
	'    0.000     0.000     0.600     0.000     0.000     0.000',
	'  0.000',
	'   0',
	'   0',
	'   0',
	'    0.000     0.000     0.000'
];

describe('readChannel / writeChannel: the synthetic example', () => {
	it('reads the routes, defined inflow file and wetland lines', () => {
		const m = readChannel(example, 'SYCR5.DAT');
		expect(m).toMatchObject({ kind: 'CR', number: 5, name: 'SY River', fileVersion: 2, wetlandMapMm: 600, wetlandRainfallFile: 'SYA.RAN' });
		expect([m.bedLossMm3PerMonth, m.wetlandStorageMm3, m.wetlandAreaKm2, m.rechargeCoefficient]).toEqual([0, 1, 1, 1]);
		expect(m.principalOutflowRoute).toBe(9);
		expect(m.inflows.map((r) => r.route)).toEqual([2, 5, 6, 8, 12]);
		expect(m.inflows[4]).toEqual({ route: 12, definedFlowFile: 'SYINF.abs' });
		expect(m.outflows).toEqual([{ route: 9, definedFlowFile: null }]);
		expect([m.reserved, m.wetlandType]).toEqual([1, 0]);
		expect(m.comprehensiveWetland?.areaVolumePower).toBe(0.6);
		expect(m.qdiv).toBe(0);
		expect([m.localWetlandInflowRoute, m.localWetlandOutflowRoute, m.diversionRoute]).toEqual([0, 0, 0]);
		expect(m.diversion).toEqual({ bankfullCapacity: 0, efficiency: 0, maxMonthlyMm3: 0 });
		expect(m.trailingLines).toBeUndefined();
	});

	it('round-trips, except that L.012 and L.017 start in the real files\' F9.3 column', () => {
		// Every real CR file writes L.012 as F9.3,5F10.3 and L.017 as
		// F9.3,2F10.3; the example has F10.3 throughout (one blank more).
		// The writer follows the real files (docs/formats.md §15: files win).
		const lines = example.split('\r\n');
		const expected = lines.map((l, k) => (k === 15 || k === 20 ? l.slice(1) : l)).join('\r\n');
		expect(writeChannel(readChannel(example, 'SYCR5.DAT'))).toBe(expected);
	});
});

describe('readChannel / writeChannel: layouts', () => {
	it('round-trips WRSM2000 layout byte for byte', () => {
		const text = channel(['3    ', '1    ', "2 ' '", '1    ', "3 'OUT.abs'"], WETLAND_TAIL);
		expect(writeChannel(readChannel(text, 'T.DAT'))).toBe(text);
	});

	it('keeps count and route lines written without the 5-column padding (U-10)', () => {
		const text = channel(['3', '1', "2 ' '", '1', "3 ' '"], WETLAND_TAIL);
		const m = readChannel(text, 'T.DAT');
		expect(m.unpaddedRouteLines).toBe(true);
		expect(writeChannel(m)).toBe(text);
	});

	it('reads the hand-made free-format L.004/L.005 style and writes WRSM2000 layout', () => {
		const text = crlf([
			"8 'Test reach'   2",
			"     0. ' '",
			'   0.00    1.00    1.00    1.00',
			'10. 20. 30. 40. 50. 60. 70. 80. 90. 100. 110. 120.',
			'.81  .82  .83  .84  .85  .86  .87  .88  .89  .90  .91  .92 ',
			'3    ',
			'0    ',
			'1    ',
			"3 ' '",
			...WETLAND_TAIL
		]);
		const m = readChannel(text, 'T.DAT');
		expect(m.panMm[9]).toBe(100);
		expect(m.panFactors[0]).toBe(0.81);
		const written = writeChannel(m).split('\r\n');
		expect(written[3]).toBe('  10.00   20.00   30.00   40.00   50.00   60.00   70.00   80.00   90.00  100.00  110.00  120.00');
		expect(written[4]).toBe(' 0.8100  0.8200  0.8300  0.8400  0.8500  0.8600  0.8700  0.8800  0.8900  0.9000  0.9100  0.9200');
	});

	it('reads a file that stops at L.011 (the manual\'s layout for no wetland) and writes it back', () => {
		const text = channel(['3    ', '0    ', '1    ', "3 ' '"], ['   1   0']);
		const m = readChannel(text, 'T.DAT');
		expect(m.comprehensiveWetland).toBeUndefined();
		expect(writeChannel(m)).toBe(text);
	});

	it('keeps lines after L.017 verbatim', () => {
		const text = channel(['3    ', '0    ', '1    ', "3 ' '"], [...WETLAND_TAIL, 'extra 1', '']);
		const m = readChannel(text, 'T.DAT');
		expect(m.trailingLines).toEqual([
			{ line: 17, text: 'extra 1' },
			{ line: 18, text: '' }
		]);
		expect(writeChannel(m)).toBe(text);
	});
});

describe('readChannel: errors name the file, line and field', () => {
	const fails = (text: string) => {
		try {
			readChannel(text, 'TCR8.DAT');
		} catch (e) {
			expect(e).toBeInstanceOf(WrsmParseError);
			return (e as WrsmParseError).message;
		}
		throw new Error('expected a parse error');
	};

	it('an unknown file version', () => {
		expect(fails(crlf(["8 'Test reach'   3"]))).toBe('TCR8.DAT:1:18 (L.001 file version): channel file version 3 is not supported (only version 2 is known)');
	});

	it('a wetland type outside 0–3', () => {
		expect(fails(channel(['3    ', '0    ', '1    ', "3 ' '"], ['   1   5']))).toBe('TCR8.DAT:10:8 (L.011 wetland type): wetland type 5 is not 0–3');
	});

	it('a route count that runs past the end of the file', () => {
		expect(fails(channel(['3    ', '2    ', "2 ' '"], []))).toBe('TCR8.DAT:9 (L.008): expected line type L.008, found end of file');
	});

	it('a non-integer route', () => {
		expect(fails(channel(['3    ', '1    ', "2.5 ' '"], []))).toBe("TCR8.DAT:8:1 (L.008 route): expected an integer, found '2.5'");
	});

	it('eleven pan values', () => {
		const text = example.split('\r\n');
		text[3] = text[3]!.slice(0, -8);
		expect(fails(text.join('\r\n'))).toBe('TCR8.DAT:4:88 (L.004 pan evaporation[11]): expected a number, found end of line');
	});
});
