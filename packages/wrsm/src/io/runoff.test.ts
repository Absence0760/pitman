import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { RunoffModule } from '../types.js';
import { readRunoff, writeRunoff } from './runoff.js';
import { WrsmParseError } from './tokens.js';

// Synthetic, byte-exact examples (docs/formats.md §17).
const examples = fileURLToPath(new URL('../../../../docs/formats/examples/', import.meta.url));
const load = (path: string): string => readFileSync(`${examples}${path}`, 'latin1');
const read = (path: string): RunoffModule => readRunoff(load(path), path.split('/').pop() ?? path);

/** Replace the `n`th (1-based) line of a CRLF file. */
function withLine(text: string, n: number, line: string): string {
	const lines = text.split('\r\n');
	lines[n - 1] = line;
	return lines.join('\r\n');
}

function parseError(fn: () => unknown): WrsmParseError {
	try {
		fn();
	} catch (e) {
		if (e instanceof WrsmParseError) return e;
		throw e;
	}
	throw new Error('expected a WrsmParseError');
}

describe('round trip of the synthetic examples', () => {
	const files = [
		'network/SYRU1.DAT',
		'network/SYRU2.DAT',
		'network/SYRU11.DAT',
		'network/SYRU12.DAT',
		'legacy/SYRU21.DAT'
	];
	it.each(files)('%s writes back byte-identical', (path) => {
		const text = load(path);
		const module = readRunoff(text, path);
		expect(writeRunoff(module)).toBe(text);
		expect(readRunoff(writeRunoff(module), path)).toEqual(module);
	});
});

describe('readRunoff fields', () => {
	it('reads a Sami parent with two outflows and two SFR children', () => {
		const m = read('network/SYRU1.DAT');
		expect(m).toMatchObject({ kind: 'RU', number: 1, name: 'SY Parent', fileVersion: 7, fileVersionInFile: true });
		expect(m).toMatchObject({ areaKm2: 120, mapMm: 650, rainfallFile: 'SYA.RAN', groundwaterModel: 2 });
		expect(m.outflows).toEqual([
			{ route: 1, percent: 60 },
			{ route: 2, percent: 40 }
		]);
		expect(m.sfrChildren).toEqual([11, 12]);
		expect(m.naturalised).toBe(false);
		expect(m.pitman).toEqual({ POW: 2, SL: 0, ST: 250, FT: 30, GW: 0, ZMIN: 20, ZMAX: 600, PI: 1.5, TL: 0.25, GL: 0, R: 0, FF: 1 });
		expect(m.sPanMm[0]).toBe(160);
		expect(m.panFactors[11]).toBe(0.85);
		expect(m.aPanFactors?.[0]).toBe(0.6);
		expect(m.layout).toBeUndefined();
	});

	it('reads the Sami block L.031–L.037 into the right fields', () => {
		const s = read('network/SYRU1.DAT').sami;
		expect(s).toMatchObject({
			aquiferThicknessM: 50,
			storativity: 0.005,
			initialAquiferStorage: 120,
			staticWaterLevelMm: 110,
			unsaturatedStorage: 20,
			initialUnsaturatedStorage: 10,
			PPOW: 0.2,
			GPOW: 3,
			maxDischarge: 2,
			gwSwPower: -0.05,
			HGSL: 0,
			HGGW: 2,
			maxHydraulicGradient: 0.001,
			transmissivity: 10,
			boreholeDistanceToRiver: 1000,
			gwEvaporationArea: 2.5,
			K2: 0.1,
			K3: -3,
			interflowLag: 0,
			rechargeAveragingMonths: 1,
			abstractionMode: 0,
			abstractions: []
		});
		// L.035 is Sami's own copy of the Pitman set: FT differs from L.003.
		expect(s?.pitman.FT).toBe(35);
	});

	it('reads the Hughes block L.021–L.030 carried by every v7 file', () => {
		const m = read('network/SYRU1.DAT');
		expect(m.inflowRoute).toBe(0);
		expect(m.upstreamGroundwaterModule).toBe(0);
		expect(m.hughes).toMatchObject({
			HGSL: 0,
			GPOW: 3,
			TLGMax: 2,
			HGGW: 2,
			useReachesForDrainageDensity: true,
			drainageDensity: 0.4,
			reaches: 1,
			riparianWidthPercent: 40,
			riparianStripFactor: 0.2,
			restWaterLevelM: 20,
			transmissivityM2PerDay: 10,
			storativity: 0.001,
			initialGroundwaterSlope: 0.01,
			upperAbstraction: { annual: 0 },
			riparianAbstraction: { annual: 0 }
		});
		expect(m.hughes?.pitman?.ST).toBe(250);
	});

	it('reads afforestation L.006–L.010 of a child', () => {
		const a = read('network/SYRU12.DAT').afforestation;
		expect(a).toEqual({
			algorithm: 1,
			algorithmInFile: true,
			areaKm2: [
				{ year: 1990, value: 8 },
				{ year: 1994, value: 8 }
			],
			species: {
				pine: { percent: 70, rotationYears: 20 },
				eucalyptus: { percent: 30, rotationYears: 10 },
				wattle: { percent: 0, rotationYears: 10 }
			},
			optimalPercent: 60,
			userDefinedReduction: { marPercent: 0, lowFlowPercent: 0 }
		});
	});

	it('reads alien vegetation L.011–L.015 of a child routed to the zero sink', () => {
		const m = read('network/SYRU11.DAT');
		expect(m.alienVegetation).toEqual({
			algorithm: 1,
			riparianArea: 0.5,
			areaKm2: [
				{ year: 1990, value: 4.5 },
				{ year: 1992, value: 4.5 },
				{ year: 1994, value: 4.5 }
			],
			composition: {
				tallTrees: { percent: 20, ageYears: 15 },
				mediumTrees: { percent: 30, ageYears: 10 },
				tallShrubs: { percent: 50, ageYears: 5 }
			},
			optimalPercent: 40
		});
		expect(m.outflows).toEqual([{ route: 3, percent: 100 }]);
		expect(m.sfrChildren).toEqual([]);
	});

	it('reads classic GW model 0 with paved areas', () => {
		const m = read('network/SYRU2.DAT');
		expect(m.groundwaterModel).toBe(0);
		expect(m.paved?.fraction).toEqual([
			{ year: 1990, value: 0.01 },
			{ year: 1994, value: 0.02 }
		]);
		expect(m.pitman).toMatchObject({ GW: 8, GL: 2.5, R: 0.5 });
		// The Hughes and Sami copies differ from L.003, and the classic set is the one in use.
		expect(m.hughes?.pitman?.GW).toBe(0);
		expect(m.sami?.pitman.FT).toBe(25);
		expect(m.afforestation.areaKm2).toEqual([]);
		expect(m.alienVegetation).toEqual({ algorithm: 0, riparianArea: 0, areaKm2: [] });
	});

	it('reads a version-0 file by the manual matrix', () => {
		const m = read('legacy/SYRU21.DAT');
		expect(m).toMatchObject({ fileVersion: 0, fileVersionInFile: false, name: 'SY v0 runoff' });
		expect(m.afforestation).toEqual({
			algorithm: 0,
			algorithmInFile: false,
			areaKm2: [
				{ year: 1990, value: 1 },
				{ year: 1994, value: 1.5 }
			]
		});
		expect(m.alienVegetation).toBeUndefined();
		expect(m.hughes).toBeUndefined();
		expect(m.sami).toBeUndefined();
		expect(m.outflows).toEqual([{ route: 30, percent: 100 }]);
	});

	it('accepts the manual form of L.039, all children on one line (D-4)', () => {
		const lines = load('network/SYRU1.DAT').split('\r\n');
		lines.splice(28, 2, '  11  12');
		const m = readRunoff(lines.join('\r\n'), 'SYRU1.DAT');
		expect(m.sfrChildren).toEqual([11, 12]);
		// The writer goes back to the one-per-line layout of the real files.
		expect(writeRunoff(m)).toBe(load('network/SYRU1.DAT'));
	});

	it('keeps the 3F7.2 layout of L.031', () => {
		const text = withLine(load('network/SYRU1.DAT'), 22, ' 50.00 0.0050 120.00 110.00  20.00');
		const m = readRunoff(text, 'SYRU1.DAT');
		expect(m.layout).toEqual({ samiStorageNarrow: true });
		expect(m.sami?.initialAquiferStorage).toBe(120);
		expect(writeRunoff(m)).toBe(text);
	});

	it('reads LF-only files and a missing final newline', () => {
		const text = load('network/SYRU2.DAT');
		const lf = text.replaceAll('\r\n', '\n').replace(/\n$/, '');
		expect(writeRunoff(readRunoff(lf, 'SYRU2.DAT'))).toBe(text);
	});
});

describe('the groundwater-abstraction flag quirk (TT 691 pp.145–146)', () => {
	const base = load('network/SYRU1.DAT').split('\r\n');
	const withPairs = (flag: number): string => {
		const lines = [...base];
		lines[24] = `   0.10   -3.00    0.00    1${String(flag).padStart(4)}`;
		lines.splice(26, 1, '   2', ' 1990 0.010', ' 1994 0.020');
		return lines.join('\r\n');
	};

	it('reads the L.037 pairs whatever the flag, and writes the flag as 1', () => {
		const m = readRunoff(withPairs(0), 'SYRU1.DAT');
		expect(m.sami?.abstractions).toEqual([
			{ year: 1990, value: 0.01 },
			{ year: 1994, value: 0.02 }
		]);
		expect(m.sami?.abstractionMode).toBe(1);
		expect(m.aPanFactors?.[0]).toBe(0.6);
		expect(writeRunoff(m)).toBe(withPairs(1));
	});

	it('rejects flag 2, whose time-series file position is unknown (U-3)', () => {
		const e = parseError(() => readRunoff(withPairs(2), 'SYRU1.DAT'));
		expect(e.message).toMatch(/^SYRU1\.DAT:25:\d+ \(L\.034 AbstractionsOn\): /);
	});
});

describe('readRunoff errors name file, line and field', () => {
	const text = load('network/SYRU1.DAT');

	it('for a truncated file', () => {
		const truncated = text.split('\r\n').slice(0, 20).join('\r\n');
		const e = parseError(() => readRunoff(truncated, 'SYRU1.DAT'));
		expect(e.message).toBe('SYRU1.DAT:21 (L.030): file ends where L.030 (12 × monthly %) was expected');
		expect(e).toMatchObject({ file: 'SYRU1.DAT', line: 21, field: 'L.030' });
	});

	it('for a truncated line', () => {
		const e = parseError(() => readRunoff(withLine(text, 4, '  160.  150.'), 'SYRU1.DAT'));
		expect(e.message).toBe('SYRU1.DAT:4:13 (L.004 S-pan evaporation[2]): expected a number, found end of line');
	});

	it('for a bad number', () => {
		const bad = withLine(text, 3, '   2.0     x   250  30.0   0.0    20   600   1.5  0.25  0.00   0.0    1.00');
		const e = parseError(() => readRunoff(bad, 'SYRU1.DAT'));
		expect(e.message).toBe("SYRU1.DAT:3:12 (L.003 SL): expected a number, found 'x'");
	});

	it('for Fortran overflow asterisks', () => {
		const bad = withLine(text, 24, '0.00100000    10.00  1000.00 ********');
		const e = parseError(() => readRunoff(bad, 'SYRU1.DAT'));
		expect(e.message).toBe("SYRU1.DAT:24:30 (L.033 Sami[3]): expected a number, found '********'");
	});

	it('for an unknown version', () => {
		const e = parseError(() => readRunoff(withLine(text, 1, "     1 'SY Parent'  8"), 'SYRU1.DAT'));
		expect(e.message).toBe('SYRU1.DAT:1:21 (L.001 file version): unknown runoff file version 8; versions 0–7 are supported');
	});

	it('for a count that is not an integer', () => {
		const e = parseError(() => readRunoff(withLine(text, 9, '  2.5'), 'SYRU1.DAT'));
		expect(e.message).toBe("SYRU1.DAT:9:3 (L.019 routes): expected an integer, found '2.5'");
	});

	it('for values left over on a line', () => {
		const e = parseError(() => readRunoff(withLine(text, 8, '   0   1'), 'SYRU1.DAT'));
		expect(e.message).toBe("SYRU1.DAT:8:8: unexpected '1' at end of L.016");
	});
});

describe('writeRunoff', () => {
	it('upgrades a version-0 file to v7 with the GW-model-0 defaults (§5.2)', () => {
		const v0 = read('legacy/SYRU21.DAT');
		const out = writeRunoff({ ...v0, fileVersion: 7 });
		const lines = out.split('\r\n');
		expect(lines[0]).toBe("    21 'SY v0 runoff'  7");
		expect(lines[5]).toBe('   2   0');
		// L.009 and L.010 are filled with zeros; L.010 carries all three values.
		expect(lines[8]).toBe('  0.00   0   0.00   0   0.00   0');
		expect(lines[9]).toBe('   0.00    0.00    0.00');
		expect(lines[10]).toBe('   0   0   0.00');
		const again = readRunoff(out, 'SYRU21.DAT');
		expect(again.groundwaterModel).toBe(0);
		expect(again.hughes?.pitman).toEqual(v0.pitman);
		expect(again.sami?.pitman).toEqual(v0.pitman);
		expect(again.aPanFactors).toEqual(v0.aPanFactors);
		// The same lines WRSM2000 carries in a native GW-model-0 file.
		const native = load('network/SYRU2.DAT').split('\r\n');
		expect(lines.slice(14, 24)).toEqual([
			'   0   0',
			'  0    0.000    3.000    2.000    2.000',
			lines[2],
			...native.slice(15, 22)
		]);
		expect(lines.slice(24, 32)).toEqual([
			' 20.00 0.0050   45.00   60.00   20.00',
			'  10.00    0.20    0.00    2.00   -0.05    0.00    2.00',
			'0.00100000    10.00  1000.00     0.00',
			'   0.10   -3.00    0.00    2   0',
			lines[2],
			'   0',
			'   0   0',
			load('legacy/SYRU21.DAT').split('\r\n')[12]
		]);
	});

	it('rounds half away from zero and never writes negative zero', () => {
		const m = read('network/SYRU2.DAT');
		const out = writeRunoff({ ...m, areaKm2: 45.25, outflows: [{ route: 5, percent: -0.01 }] });
		expect(out.split('\r\n')[1]).toBe("   45.3  540 'SYA.RAN'");
		expect(out.split('\r\n')[11]).toBe('   5   0.0');
	});

	it('doubles a quote inside a name', () => {
		const m = read('network/SYRU2.DAT');
		const out = writeRunoff({ ...m, name: "Kloof's end" });
		expect(out.split('\r\n')[0]).toBe("     2 'Kloof''s end'  7");
		expect(readRunoff(out, 'SYRU2.DAT').name).toBe("Kloof's end");
	});

	it('refuses a value too wide for its field', () => {
		const m = read('network/SYRU2.DAT');
		expect(() => writeRunoff({ ...m, areaKm2: 123456 })).toThrow('L.002 AREA: 123456 does not fit F7.1');
	});
});
