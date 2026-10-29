/**
 * Runoff module files, `<net>RU<n>.DAT` (TT 691 §12.1 L.001–L.040;
 * docs/formats.md §5).
 *
 * Reading is line by line in the grammar of the line table: each line is
 * self-contained (docs/formats.md §1.2), and the file version on L.001
 * decides which lines exist (§5.2). Writing reproduces the widths WRSM2000
 * itself writes, measured over the real files (§5.1, D-1), so a file read
 * and written back is byte-identical.
 *
 * Errors throw a `WrsmParseError` that names the file, line, column and
 * field, e.g. `SYRU1.DAT:3:9 (L.003 SL): expected a number, found 'x'`.
 */

import type {
	AfforestationAlgorithm,
	AlienVegetationAlgorithm,
	GroundwaterModel,
	HughesAbstraction,
	HughesParameters,
	Monthly12,
	PitmanParameters,
	RawLine,
	RunoffFileVersion,
	RunoffModule,
	RunoffOutflow,
	SamiAbstractionMode,
	SamiParameters,
	YearTable,
	YearValue
} from '../types.js';
import { FieldCursor, WrsmParseError, splitLines, tokenizeLine } from './tokens.js';

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** The Pitman parameter names in L.003 order (TT 691 §12.1). */
const PITMAN_FIELDS = ['POW', 'SL', 'ST', 'FT', 'GW', 'ZMIN', 'ZMAX', 'PI', 'TL', 'GL', 'R', 'FF'] as const;

/** Walks the file's physical lines, handing out one cursor per line type. */
class LineReader {
	private index = 0;
	private readonly lines: readonly string[];

	constructor(
		text: string,
		readonly file: string
	) {
		this.lines = splitLines(text).lines;
	}

	/** 1-based number of the next line. */
	get nextLine(): number {
		return this.index + 1;
	}

	get done(): boolean {
		return this.index >= this.lines.length;
	}

	/** The next line as a cursor; a truncated file fails naming the line type expected. */
	next(lineType: string, what: string): FieldCursor {
		const text = this.lines[this.index];
		if (text === undefined) {
			throw new WrsmParseError(`file ends where ${lineType} (${what}) was expected`, {
				file: this.file,
				line: this.index + 1,
				field: lineType
			});
		}
		this.index++;
		return new FieldCursor(tokenizeLine(text, this.index, { file: this.file }), { file: this.file });
	}

	/** The next line's tokens, without consuming it. */
	peekTokenCount(): number | undefined {
		const text = this.lines[this.index];
		return text === undefined ? undefined : tokenizeLine(text, this.index + 1, { file: this.file }).tokens.length;
	}

	/** Every line not yet read, verbatim. */
	rest(): RawLine[] {
		const out: RawLine[] = [];
		for (; this.index < this.lines.length; this.index++) {
			out.push({ line: this.index + 1, text: this.lines[this.index] ?? '' });
		}
		return out;
	}
}

/** Read a count (an integer ≥ 0) that fixes how many lines or values follow. */
function count(cursor: FieldCursor, field: string): number {
	const token = cursor.peek();
	const value = cursor.integer(field);
	if (value < 0) throw cursor.error(`expected a count of 0 or more, found '${token?.text ?? ''}'`, field, token);
	return value;
}

/** Read `n` values of `field` from a line and fail on leftovers. */
function numbersLine(cursor: FieldCursor, field: string, n: number): number[] {
	const out = cursor.numbers(field, n);
	cursor.end(field.split(' ')[0]);
	return out;
}

function twelve(values: number[]): Monthly12 {
	return values as unknown as Monthly12;
}

function readPitman(reader: LineReader, lineType: string): PitmanParameters {
	const c = reader.next(lineType, 'Pitman parameters POW … FF');
	const v = PITMAN_FIELDS.map((name) => c.number(`${lineType} ${name}`));
	c.end(lineType);
	return {
		POW: v[0]!,
		SL: v[1]!,
		ST: v[2]!,
		FT: v[3]!,
		GW: v[4]!,
		ZMIN: v[5]!,
		ZMAX: v[6]!,
		PI: v[7]!,
		TL: v[8]!,
		GL: v[9]!,
		R: v[10]!,
		FF: v[11]!
	};
}

function readMonthly(reader: LineReader, lineType: string, field: string): Monthly12 {
	return twelve(numbersLine(reader.next(lineType, `12 × ${field}`), `${lineType} ${field}`, 12));
}

/** A year table stored as N (already read), a line of N years, then a line of N values. */
function readYearTable(reader: LineReader, n: number, yearsLine: string, valuesLine: string): YearTable {
	if (n === 0) return [];
	const yc = reader.next(yearsLine, `${n} years`);
	const years: number[] = [];
	for (let k = 0; k < n; k++) years.push(yc.integer(`${yearsLine} year[${k}]`));
	yc.end(yearsLine);
	const values = numbersLine(reader.next(valuesLine, `${n} values`), `${valuesLine} value`, n);
	return years.map((year, k): YearValue => ({ year, value: values[k]! }));
}

function readAbstraction(reader: LineReader, annualLine: string, monthlyLine: string): HughesAbstraction {
	const annual = numbersLine(reader.next(annualLine, 'annual abstraction'), `${annualLine} annual`, 1)[0]!;
	return { annual, monthlyPercent: readMonthly(reader, monthlyLine, 'monthly %') };
}

/**
 * Read a runoff module file. `fileName` is used in error messages only.
 *
 * Versions 0–7 are read by the matrix in docs/formats.md §5.2; 5 and 6 are
 * read as 7 (their differences are unknown, U-1). Any other version, and
 * version 8 (the daily build, U-5), is an error.
 */
export function readRunoff(text: string, fileName: string): RunoffModule {
	const r = new LineReader(text, fileName);

	// L.001: module number, name, file version (absent = 0).
	const l1 = r.next('L.001', 'module number, name and file version');
	const number = l1.integer('L.001 NRUEN');
	const name = l1.string('L.001 RUNAM');
	const versionToken = l1.peek();
	let fileVersion: RunoffFileVersion = 0;
	if (versionToken !== undefined) {
		const v = l1.integer('L.001 file version');
		if (!Number.isInteger(v) || v < 0 || v > 7) {
			// v8 is the daily-time-step build (TT 691 §11.15, U-5).
			throw l1.error(`unknown runoff file version ${versionToken.text}; versions 0–7 are supported`, 'L.001 file version', versionToken);
		}
		fileVersion = v as RunoffFileVersion;
	}
	l1.end('L.001');
	const v = fileVersion;

	// L.002: area, MAP, rainfall file.
	const l2 = r.next('L.002', 'AREA, MAP and rainfall file');
	const areaKm2 = l2.number('L.002 AREA');
	const mapMm = l2.number('L.002 MAP');
	const rainfallFile = l2.string('L.002 rainfall file');
	l2.end('L.002');

	const pitman = readPitman(r, 'L.003');
	const sPanMm = readMonthly(r, 'L.004', 'S-pan evaporation');
	const panFactors = readMonthly(r, 'L.005', 'pan factor');

	// L.006–L.010: afforestation. Version 0 has no algorithm (Van der Zel).
	const l6 = r.next('L.006', v >= 1 ? 'NYRF and FORESTALG' : 'NYRF');
	const nyrf = count(l6, 'L.006 NYRF');
	let forestAlg = 0;
	if (v >= 1) {
		const tok = l6.peek();
		forestAlg = l6.integer('L.006 FORESTALG');
		if (forestAlg < 0 || forestAlg > 4) throw l6.error(`unknown afforestation algorithm ${forestAlg}`, 'L.006 FORESTALG', tok);
	}
	l6.end('L.006');
	const forestArea = readYearTable(r, nyrf, 'L.007', 'L.008');
	let afforestation: RunoffModule['afforestation'] = {
		algorithm: forestAlg as AfforestationAlgorithm,
		algorithmInFile: v >= 1,
		areaKm2: forestArea
	};
	if (nyrf > 0 && v >= 1) {
		const l9 = r.next('L.009', 'pine, eucalyptus and wattle % and rotations');
		const s = numbersLine(l9, 'L.009 species', 6);
		// L.010: all three values in every real file (D-3); older files may hold the first only.
		const l10 = r.next('L.010', 'optimal % and user-defined SFR');
		const optimalPercent = l10.number('L.010 optimal %');
		let userDefinedReduction: { marPercent: number; lowFlowPercent: number } | undefined;
		if (l10.remaining > 0) {
			userDefinedReduction = { marPercent: l10.number('L.010 UD_TPRM'), lowFlowPercent: l10.number('L.010 UD_TPRL') };
		}
		l10.end('L.010');
		afforestation = {
			...afforestation,
			species: {
				pine: { percent: s[0]!, rotationYears: s[1]! },
				eucalyptus: { percent: s[2]!, rotationYears: s[3]! },
				wattle: { percent: s[4]!, rotationYears: s[5]! }
			},
			optimalPercent,
			...(userDefinedReduction !== undefined && { userDefinedReduction })
		};
	}

	// L.011–L.015 (version ≥ 1): alien vegetation.
	let alienVegetation: RunoffModule['alienVegetation'];
	if (v >= 1) {
		const l11 = r.next('L.011', 'NYRA, VEGETATIONALG and riparian area');
		const nyra = count(l11, 'L.011 NYRA');
		const tok = l11.peek();
		const alg = l11.integer('L.011 VEGETATIONALG');
		if (alg < 0 || alg > 2) throw l11.error(`unknown alien-vegetation algorithm ${alg}`, 'L.011 VEGETATIONALG', tok);
		const riparianArea = l11.number('L.011 riparian area'); // U-21: units not stated
		l11.end('L.011');
		const areaKm2 = readYearTable(r, nyra, 'L.012', 'L.013');
		alienVegetation = { algorithm: alg as AlienVegetationAlgorithm, riparianArea, areaKm2 };
		if (nyra > 0) {
			const s = numbersLine(r.next('L.014', 'tall trees, medium trees, tall shrubs % and ages'), 'L.014 composition', 6);
			const optimalPercent = numbersLine(r.next('L.015', 'optimal %'), 'L.015 optimal %', 1)[0]!;
			alienVegetation = {
				...alienVegetation,
				composition: {
					tallTrees: { percent: s[0]!, ageYears: s[1]! },
					mediumTrees: { percent: s[2]!, ageYears: s[3]! },
					tallShrubs: { percent: s[4]!, ageYears: s[5]! }
				},
				optimalPercent
			};
		}
	}

	// L.016–L.018: paved area. Read in every version (U-2: the manual sets no condition).
	const l16 = r.next('L.016', 'NYRP');
	const nyrp = count(l16, 'L.016 NYRP');
	l16.end('L.016');
	const paved = { fraction: readYearTable(r, nyrp, 'L.017', 'L.018') };

	// L.019–L.020: outflow routes.
	const l19 = r.next('L.019', 'number of outflow routes');
	const nRoutes = count(l19, 'L.019 routes');
	l19.end('L.019');
	const outflows: RunoffOutflow[] = [];
	for (let k = 0; k < nRoutes; k++) {
		const c = r.next('L.020', `outflow route ${k + 1} of ${nRoutes}`);
		const route = c.integer('L.020 route');
		const percent = c.number('L.020 %');
		c.end('L.020');
		outflows.push({ route, percent });
	}

	let inflowRoute: number | undefined;
	let upstreamGroundwaterModule: number | undefined;
	let groundwaterModel: GroundwaterModel | undefined;
	let hughes: HughesParameters | undefined;
	let sami: SamiParameters | undefined;
	let samiStorageNarrow = false;

	// L.021–L.030 (version ≥ 3): Hughes; L.022 v5, L.023, L.024 from version 4.
	if (v >= 3) {
		const l21 = r.next('L.021', 'Hughes inflow route and upstream GW module');
		inflowRoute = l21.integer('L.021 RTIN');
		upstreamGroundwaterModule = l21.integer('L.021 UpStrRunoffModule');
		l21.end('L.021');

		const l22 = r.next('L.022', v >= 4 ? 'GW model, HGSL, GPOW, TLGMax, HGGW' : 'GW model, HGSL, GPOW, TLGMax');
		const gwTok = l22.peek();
		const gw = l22.integer('L.022 GWMODEL');
		if (gw < 0 || gw > 2) throw l22.error(`unknown groundwater model ${gw}`, 'L.022 GWMODEL', gwTok);
		groundwaterModel = gw as GroundwaterModel;
		const HGSL = l22.number('L.022 HGSL');
		const GPOW = l22.number('L.022 GPOW');
		const TLGMax = l22.number('L.022 TLGMax');
		const HGGW = v >= 4 ? l22.number('L.022 HGGW') : undefined;
		l22.end('L.022');

		let hPitman: PitmanParameters | undefined;
		let useReaches: boolean | undefined;
		let drainageDensity: number | undefined;
		if (v >= 4) {
			hPitman = readPitman(r, 'L.023');
			const l24 = r.next('L.024', 'use reaches for drainage density, drainage density');
			useReaches = l24.integer('L.024 use reaches') !== 0;
			drainageDensity = l24.number('L.024 drainage density');
			l24.end('L.024');
		}
		const p25 = numbersLine(r.next('L.025', 'Hughes reach and aquifer parameters'), 'L.025 Hughes', 6);
		const slope = numbersLine(r.next('L.026', 'initial GW slope'), 'L.026 slope', 1)[0]!;
		const upperAbstraction = readAbstraction(r, 'L.027', 'L.028');
		const riparianAbstraction = readAbstraction(r, 'L.029', 'L.030');
		hughes = {
			HGSL,
			GPOW,
			TLGMax,
			...(HGGW !== undefined && { HGGW }),
			...(hPitman !== undefined && { pitman: hPitman }),
			...(useReaches !== undefined && { useReachesForDrainageDensity: useReaches }),
			...(drainageDensity !== undefined && { drainageDensity }),
			reaches: p25[0]!,
			riparianWidthPercent: p25[1]!,
			riparianStripFactor: p25[2]!,
			restWaterLevelM: p25[3]!,
			transmissivityM2PerDay: p25[4]!,
			storativity: p25[5]!,
			initialGroundwaterSlope: slope,
			upperAbstraction,
			riparianAbstraction
		};
	}

	// L.031–L.037 (version ≥ 4): Sami.
	if (v >= 4) {
		const l31 = r.next('L.031', 'Sami aquifer parameters');
		const a = numbersLine(l31, 'L.031 Sami', 5);
		// 31 real files write vars 3–5 as 3F7.2, ending in column 34 rather than 37.
		samiStorageNarrow = l31.tokenLine.text.trimEnd().length === 34;
		const b = numbersLine(r.next('L.032', 'Sami storage and recharge parameters'), 'L.032 Sami', 7);
		const c = numbersLine(r.next('L.033', 'Sami hydraulic parameters'), 'L.033 Sami', 4);
		const l34 = r.next('L.034', 'K2, K3, interflow lag, recharge months, abstraction flag');
		const K2 = l34.number('L.034 K2');
		const K3 = l34.number('L.034 K3');
		const interflowLag = l34.number('L.034 lag');
		const rechargeAveragingMonths = l34.number('L.034 MMA'); // D-2: an integer in every file
		const flagTok = l34.peek();
		let abstractionMode = l34.integer('L.034 AbstractionsOn');
		if (abstractionMode < 0 || abstractionMode > 2) {
			throw l34.error(`unknown groundwater-abstraction flag ${abstractionMode}`, 'L.034 AbstractionsOn', flagTok);
		}
		if (abstractionMode === 2) {
			// U-3: the time-series file name's position is unknown.
			throw l34.error('groundwater abstraction from a time-series file (flag 2) is not supported', 'L.034 AbstractionsOn', flagTok);
		}
		l34.end('L.034');
		const sPitman = readPitman(r, 'L.035');
		const l36 = r.next('L.036', 'NYGA');
		const nyga = count(l36, 'L.036 NYGA');
		l36.end('L.036');
		// TT 691 pp.145–146 quirk (§5.5): read the pairs whenever NYGA > 0,
		// whatever the flag; a flag of 0 with pairs is treated as 1.
		if (nyga > 0) abstractionMode = 1;
		const abstractions: YearValue[] = [];
		for (let k = 0; k < nyga; k++) {
			const l37 = r.next('L.037', `GW abstraction ${k + 1} of ${nyga}`);
			const year = l37.integer('L.037 year');
			const value = l37.number('L.037 abstraction'); // U-4: units assumed million m³/a
			l37.end('L.037');
			abstractions.push({ year, value });
		}
		sami = {
			aquiferThicknessM: a[0]!,
			storativity: a[1]!,
			initialAquiferStorage: a[2]!,
			staticWaterLevelMm: a[3]!,
			unsaturatedStorage: a[4]!,
			initialUnsaturatedStorage: b[0]!,
			PPOW: b[1]!,
			GPOW: b[2]!,
			maxDischarge: b[3]!,
			gwSwPower: b[4]!,
			HGSL: b[5]!,
			HGGW: b[6]!,
			maxHydraulicGradient: c[0]!,
			transmissivity: c[1]!,
			boreholeDistanceToRiver: c[2]!,
			gwEvaporationArea: c[3]!,
			K2,
			K3,
			interflowLag,
			rechargeAveragingMonths,
			abstractionMode: abstractionMode as SamiAbstractionMode,
			pitman: sPitman,
			abstractions
		};
	}

	// L.038–L.039: naturalised flag and SFR children. Real files write one
	// child per line (D-4); the manual's single `nI4` line is accepted too.
	const l38 = r.next('L.038', 'naturalised flag and number of children');
	const naturalised = l38.integer('L.038 naturalised') !== 0;
	const nChildren = count(l38, 'L.038 children');
	l38.end('L.038');
	const sfrChildren: number[] = [];
	if (nChildren > 1 && r.peekTokenCount() === nChildren) {
		const c = r.next('L.039', `${nChildren} child module numbers`);
		for (let k = 0; k < nChildren; k++) sfrChildren.push(c.integer(`L.039 child[${k}]`));
		c.end('L.039');
	} else {
		for (let k = 0; k < nChildren; k++) {
			const c = r.next('L.039', `child module ${k + 1} of ${nChildren}`);
			sfrChildren.push(c.integer('L.039 child'));
			c.end('L.039');
		}
	}

	// L.040: A-pan factors (12F6.2 in the files, D-5).
	const aPanFactors = readMonthly(r, 'L.040', 'A-pan factor');

	const trailingLines = r.rest();

	return {
		kind: 'RU',
		number,
		name,
		fileVersion,
		fileVersionInFile: versionToken !== undefined,
		areaKm2,
		mapMm,
		rainfallFile,
		pitman,
		sPanMm,
		panFactors,
		afforestation,
		...(alienVegetation !== undefined && { alienVegetation }),
		paved,
		outflows,
		...(inflowRoute !== undefined && { inflowRoute }),
		...(upstreamGroundwaterModule !== undefined && { upstreamGroundwaterModule }),
		...(groundwaterModel !== undefined && { groundwaterModel }),
		...(hughes !== undefined && { hughes }),
		...(sami !== undefined && { sami }),
		naturalised,
		sfrChildren,
		aPanFactors,
		...(trailingLines.length > 0 && { trailingLines }),
		...(samiStorageNarrow && { layout: { samiStorageNarrow } })
	};
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** Round half away from zero on the float32 value (docs/formats.md §2, U-18). */
function fixed(value: number, decimals: number, field: string): string {
	if (!Number.isFinite(value)) throw new RangeError(`${field}: cannot write ${value}`);
	const x = Math.fround(value);
	let s = Math.abs(x).toFixed(decimals);
	if (decimals === 0) s += '.';
	// Negative zero, or a negative value that rounds to zero, is written unsigned (U-18).
	return x < 0 && /[1-9]/.test(s) ? `-${s}` : s;
}

/** `Fw.d`: right-justified in `w` columns; overflow is an error, never asterisks. */
function f(value: number, width: number, decimals: number, field: string): string {
	const s = fixed(value, decimals, field);
	if (s.length > width) throw new RangeError(`${field}: ${value} does not fit F${width}.${decimals}`);
	return s.padStart(width);
}

/** `Iw`: an integer right-justified in `w` columns. */
function i(value: number, width: number, field: string): string {
	if (!Number.isFinite(value)) throw new RangeError(`${field}: cannot write ${value}`);
	const n = Math.sign(value) * Math.round(Math.abs(value));
	const s = String(n === 0 ? 0 : n);
	if (s.length > width) throw new RangeError(`${field}: ${value} does not fit I${width}`);
	return s.padStart(width);
}

/** A quoted string, with an embedded quote doubled. */
function q(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function pitmanLine(p: PitmanParameters, lineType: string): string {
	// F6.1,I6,I6,F6.1,F6.1,I6,I6,F6.1,F6.2,F6.2,F6.1,F8.2 (D-1).
	return (
		f(p.POW, 6, 1, `${lineType} POW`) +
		i(p.SL, 6, `${lineType} SL`) +
		i(p.ST, 6, `${lineType} ST`) +
		f(p.FT, 6, 1, `${lineType} FT`) +
		f(p.GW, 6, 1, `${lineType} GW`) +
		i(p.ZMIN, 6, `${lineType} ZMIN`) +
		i(p.ZMAX, 6, `${lineType} ZMAX`) +
		f(p.PI, 6, 1, `${lineType} PI`) +
		f(p.TL, 6, 2, `${lineType} TL`) +
		f(p.GL, 6, 2, `${lineType} GL`) +
		f(p.R, 6, 1, `${lineType} R`) +
		f(p.FF, 8, 2, `${lineType} FF`)
	);
}

function monthlyLine(values: Monthly12, width: number, decimals: number, field: string): string {
	return values.map((x, k) => f(x, width, decimals, `${field}[${k}]`)).join('');
}

/** `F6.2,11F7.2`: the Hughes monthly-% lines L.028 and L.030. */
function percentLine(values: Monthly12, field: string): string {
	return values.map((x, k) => f(x, k === 0 ? 6 : 7, 2, `${field}[${k}]`)).join('');
}

/** `N(1X,I4)` then `N(1X,F0.d)` or `N(1X,Fw.d)`: a year table's two lines. */
function yearTableLines(table: YearTable, valueWidth: number, decimals: number, lineType: string): string[] {
	if (table.length === 0) return [];
	const years = table.map((y, k) => ` ${i(y.year, 4, `${lineType} year[${k}]`)}`).join('');
	const values = table
		.map((y, k) => {
			const field = `${lineType} value[${k}]`;
			return ` ${valueWidth === 0 ? fixed(y.value, decimals, field) : f(y.value, valueWidth, decimals, field)}`;
		})
		.join('');
	return [years, values];
}

const ZERO12 = twelve(Array.from({ length: 12 }, () => 0));

/**
 * Write a runoff module file in the layout its `fileVersion` requires, with
 * WRSM2000's own widths (docs/formats.md §5.1) and CRLF line ends. Lines a
 * version does not have are left out; optional values missing from the
 * module are written as the values WRSM2000 carries in its own files
 * (§5.2 upgrade table).
 */
export function writeRunoff(module: RunoffModule): string {
	const v = module.fileVersion;
	const out: string[] = [];
	const push = (...lines: string[]): void => {
		out.push(...lines);
	};

	// L.001: I6,1X,'name',I3.
	push(`${i(module.number, 6, 'L.001 NRUEN')} ${q(module.name)}${v === 0 && !module.fileVersionInFile ? '' : i(v, 3, 'L.001 file version')}`);
	// L.002: F7.1,I5,1X,'name'.
	push(`${f(module.areaKm2, 7, 1, 'L.002 AREA')}${i(module.mapMm, 5, 'L.002 MAP')} ${q(module.rainfallFile)}`);
	push(pitmanLine(module.pitman, 'L.003'));
	push(monthlyLine(module.sPanMm, 6, 0, 'L.004'));
	push(monthlyLine(module.panFactors, 6, 2, 'L.005'));

	// L.006–L.010.
	const aff = module.afforestation;
	push(i(aff.areaKm2.length, 4, 'L.006 NYRF') + (v >= 1 ? i(aff.algorithm, 4, 'L.006 FORESTALG') : ''));
	push(...yearTableLines(aff.areaKm2, 0, 1, 'L.008'));
	if (aff.areaKm2.length > 0 && v >= 1) {
		const s = aff.species;
		const pine = s?.pine ?? { percent: 0, rotationYears: 0 };
		const euc = s?.eucalyptus ?? { percent: 0, rotationYears: 0 };
		const wat = s?.wattle ?? { percent: 0, rotationYears: 0 };
		// F6.2,I4,F7.2,I4,F7.2,I4.
		push(
			f(pine.percent, 6, 2, 'L.009 %pine') +
				i(pine.rotationYears, 4, 'L.009 pine rotation') +
				f(euc.percent, 7, 2, 'L.009 %eucalyptus') +
				i(euc.rotationYears, 4, 'L.009 eucalyptus rotation') +
				f(wat.percent, 7, 2, 'L.009 %wattle') +
				i(wat.rotationYears, 4, 'L.009 wattle rotation')
		);
		// F7.2,F8.2,F8.2: all three written in v7 files (D-3).
		const ud = aff.userDefinedReduction;
		let l10 = f(aff.optimalPercent ?? 0, 7, 2, 'L.010 optimal %');
		if (ud !== undefined || v === 7) {
			l10 += f(ud?.marPercent ?? 0, 8, 2, 'L.010 UD_TPRM') + f(ud?.lowFlowPercent ?? 0, 8, 2, 'L.010 UD_TPRL');
		}
		push(l10);
	}

	// L.011–L.015 (version ≥ 1).
	if (v >= 1) {
		const av = module.alienVegetation ?? { algorithm: 0, riparianArea: 0, areaKm2: [] };
		push(
			i(av.areaKm2.length, 4, 'L.011 NYRA') +
				i(av.algorithm, 4, 'L.011 VEGETATIONALG') +
				f(av.riparianArea, 7, 2, 'L.011 riparian area')
		);
		push(...yearTableLines(av.areaKm2, 0, 1, 'L.013'));
		if (av.areaKm2.length > 0) {
			const c = av.composition;
			const shares = [c?.tallTrees, c?.mediumTrees, c?.tallShrubs];
			// F6.2,5F7.2.
			push(
				shares
					.flatMap((s) => [s?.percent ?? 0, s?.ageYears ?? 0])
					.map((x, k) => f(x, k === 0 ? 6 : 7, 2, `L.014 composition[${k}]`))
					.join('')
			);
			push(f(av.optimalPercent ?? 0, 6, 2, 'L.015 optimal %'));
		}
	}

	// L.016–L.018.
	const paved = module.paved?.fraction ?? [];
	push(i(paved.length, 4, 'L.016 NYRP'));
	push(...yearTableLines(paved, 5, 3, 'L.018'));

	// L.019–L.020: I3, then I4,F6.1 per route.
	push(i(module.outflows.length, 3, 'L.019 routes'));
	module.outflows.forEach((o, k) => push(i(o.route, 4, `L.020 route[${k}]`) + f(o.percent, 6, 1, `L.020 %[${k}]`)));

	// L.021–L.030 (version ≥ 3). Missing values take the GW-model-0 defaults (§5.2).
	if (v >= 3) {
		const h = module.hughes;
		push(i(module.inflowRoute ?? 0, 4, 'L.021 RTIN') + i(module.upstreamGroundwaterModule ?? 0, 4, 'L.021 UpStrRunoffModule'));
		push(
			i(module.groundwaterModel ?? 0, 3, 'L.022 GWMODEL') +
				f(h?.HGSL ?? 0, 9, 3, 'L.022 HGSL') +
				f(h?.GPOW ?? 3, 9, 3, 'L.022 GPOW') +
				f(h?.TLGMax ?? 2, 9, 3, 'L.022 TLGMax') +
				(v >= 4 ? f(h?.HGGW ?? 2, 9, 3, 'L.022 HGGW') : '')
		);
		if (v >= 4) {
			push(pitmanLine(h?.pitman ?? module.pitman, 'L.023'));
			push(i(h?.useReachesForDrainageDensity === false ? 0 : 1, 3, 'L.024 use reaches') + f(h?.drainageDensity ?? 0.4, 9, 5, 'L.024 drainage density'));
		}
		// I4,F7.2,F8.3,F7.2,F7.2,F7.4.
		push(
			i(h?.reaches ?? 1, 4, 'L.025 reaches') +
				f(h?.riparianWidthPercent ?? 40, 7, 2, 'L.025 riparian width %') +
				f(h?.riparianStripFactor ?? 0.2, 8, 3, 'L.025 riparian strip factor') +
				f(h?.restWaterLevelM ?? 20, 7, 2, 'L.025 rest water level') +
				f(h?.transmissivityM2PerDay ?? 10, 7, 2, 'L.025 transmissivity') +
				f(h?.storativity ?? 0.001, 7, 4, 'L.025 storativity')
		);
		push(f(h?.initialGroundwaterSlope ?? 0.01, 8, 4, 'L.026 slope'));
		push(f(h?.upperAbstraction.annual ?? 0, 8, 2, 'L.027 annual'));
		push(percentLine(h?.upperAbstraction.monthlyPercent ?? ZERO12, 'L.028'));
		push(f(h?.riparianAbstraction.annual ?? 0, 8, 2, 'L.029 annual'));
		push(percentLine(h?.riparianAbstraction.monthlyPercent ?? ZERO12, 'L.030'));
	}

	// L.031–L.037 (version ≥ 4).
	if (v >= 4) {
		const s = module.sami;
		// F6.2,F7.4,3F8.2, or 3F7.2 for the last three where the file had it.
		const w31 = module.layout?.samiStorageNarrow === true ? 7 : 8;
		push(
			f(s?.aquiferThicknessM ?? 20, 6, 2, 'L.031 aquifer thickness') +
				f(s?.storativity ?? 0.005, 7, 4, 'L.031 storativity') +
				f(s?.initialAquiferStorage ?? 45, w31, 2, 'L.031 initial aquifer storage') +
				f(s?.staticWaterLevelMm ?? 60, w31, 2, 'L.031 static water level') +
				f(s?.unsaturatedStorage ?? 20, w31, 2, 'L.031 unsaturated storage')
		);
		// F7.2,6F8.2.
		push(
			f(s?.initialUnsaturatedStorage ?? 10, 7, 2, 'L.032 initial unsaturated storage') +
				f(s?.PPOW ?? 0.2, 8, 2, 'L.032 PPOW') +
				f(s?.GPOW ?? 0, 8, 2, 'L.032 GPOW') +
				f(s?.maxDischarge ?? 2, 8, 2, 'L.032 max discharge') +
				f(s?.gwSwPower ?? -0.05, 8, 2, 'L.032 GW/SW power') +
				f(s?.HGSL ?? 0, 8, 2, 'L.032 HGSL') +
				f(s?.HGGW ?? 2, 8, 2, 'L.032 HGGW')
		);
		// F10.8,3F9.2.
		push(
			f(s?.maxHydraulicGradient ?? 0.001, 10, 8, 'L.033 max hydraulic gradient') +
				f(s?.transmissivity ?? 10, 9, 2, 'L.033 transmissivity') +
				f(s?.boreholeDistanceToRiver ?? 1000, 9, 2, 'L.033 borehole distance') +
				f(s?.gwEvaporationArea ?? 0, 9, 2, 'L.033 GW evaporation area')
		);
		const abstractions = s?.abstractions ?? [];
		// §5.5: with pairs present, write flag 1 so WRSM2000 v2.11 reads them.
		const flag = abstractions.length > 0 ? 1 : (s?.abstractionMode ?? 0);
		// F7.2,2F8.2,I5,I4 (D-2: var 4 is an integer).
		push(
			f(s?.K2 ?? 0.1, 7, 2, 'L.034 K2') +
				f(s?.K3 ?? -3, 8, 2, 'L.034 K3') +
				f(s?.interflowLag ?? 0, 8, 2, 'L.034 lag') +
				i(s?.rechargeAveragingMonths ?? 2, 5, 'L.034 MMA') +
				i(flag, 4, 'L.034 AbstractionsOn')
		);
		push(pitmanLine(s?.pitman ?? module.pitman, 'L.035'));
		push(i(abstractions.length, 4, 'L.036 NYGA'));
		// 1X,I4,1X,F5.3 (TT 691 p.144 example).
		abstractions.forEach((a, k) => push(` ${i(a.year, 4, `L.037 year[${k}]`)} ${f(a.value, 5, 3, `L.037 abstraction[${k}]`)}`));
	}

	// L.038–L.039: 2I4, then one I4 per child (D-4).
	const children = module.sfrChildren ?? [];
	push(i(module.naturalised === true ? 1 : 0, 4, 'L.038 naturalised') + i(children.length, 4, 'L.038 children'));
	children.forEach((c, k) => push(i(c, 4, `L.039 child[${k}]`)));

	// L.040: 12F6.2 (D-5); WRSM2000 carries the pan factors when absent (U-2).
	push(monthlyLine(module.aPanFactors ?? module.panFactors, 6, 2, 'L.040'));

	for (const line of module.trailingLines ?? []) push(line.text);
	return out.map((line) => `${line}\r\n`).join('');
}
