/**
 * Reader and writer for the irrigation module file, `<net>RR<n>.DAT`
 * (TT 691 §12.4 pp.158–176; docs/formats.md §8).
 *
 * Layouts, decided from L.001 v3 (the file version) and the file's length:
 * - no version: the WRSM90 original, L.001–L.011 with no model-type line
 *   (docs/formats.md §8.2) → `layout: 'pitman'`, `fileVersion: 0`;
 * - version 32 ending at L.012: the manual's "original WRSM/Pitman method"
 *   example (TT 691 pp.158–159) → `layout: 'pitman'`. Never observed;
 * - version 32 with L.013–L.030: WQT / WQT-SAPWAT → `layout: 'wqt'`. Every
 *   real versioned file, whatever its model type (D-8);
 * - version 42: WQT type 4, L.001–L.040 (TT 691 pp.162–176) → `layout:
 *   'wqt4'`. Manual only, never observed (U-11).
 *
 * The writer writes version 32 only (docs/decisions.md, Formats): a
 * `pitman` module is upgraded with `upgradeIrrigation`, and a `wqt4`
 * module is refused (docs/formats.md §8.1 "never write it").
 */

import type { FieldCursor } from './tokens.js';
import { ModuleLines, int, joinLines, minimal, quoted, readCount, readTwelve } from './module-file.js';
import type {
	InterpolatedYearTable,
	IrrigationCore,
	IrrigationCrop,
	IrrigationModelType,
	IrrigationModule,
	IrrigationPitmanLayout,
	IrrigationWqtLayout,
	Monthly12,
	YearTable
} from '../types.js';

/** The only versioned layouts known: v32 (WRSM + WQT, revision 2) and v42 (WQT type 4). */
const WQT_VERSION = 32;
const WQT4_VERSION = 42;

/** Read an irrigation file. Throws a `WrsmParseError` naming the file, line and field. */
export function readIrrigation(text: string, fileName: string): IrrigationModule {
	const lines = new ModuleLines(text, fileName);

	const l1 = lines.next('L.001');
	const number = l1.integer('L.001 NRREN');
	const name = l1.string('L.001 RRNAM');
	const versionToken = l1.peek() === undefined ? undefined : l1.numberToken('L.001 version');
	l1.end('L.001');
	if (versionToken !== undefined && (!versionToken.integer || (versionToken.value !== WQT_VERSION && versionToken.value !== WQT4_VERSION))) {
		throw l1.error(`irrigation file version '${versionToken.text}' is not supported (known: none, 32, 42)`, 'L.001 version', versionToken);
	}
	const fileVersion = versionToken?.value ?? 0;

	// The unversioned WRSM90 file has no model-type line (docs/formats.md §8.2).
	let modelType: IrrigationModelType = 1;
	if (fileVersion !== 0) {
		const l2 = lines.next('L.002');
		const token = l2.peek();
		const model = l2.integer('L.002 MODEL');
		l2.end('L.002');
		if (model < 1 || model > 4) throw l2.error(`model type ${model} is not 1–4`, 'L.002 MODEL', token);
		modelType = model as IrrigationModelType;
	}

	const l3 = lines.next('L.003');
	const mapMm = l3.number('L.003 RRMAP');
	const rainfallFile = l3.string('L.003 rainfall file');
	const drought = l3.peek() === undefined ? undefined : flag(l3, 'L.003 DROUGHT_APPLICABLE');
	// D-10: 16 real files leave the clipping flag out.
	const clipping = l3.peek() === undefined ? undefined : flag(l3, 'L.003 CurtailByClipping');
	l3.end('L.003');

	// D-12: with NYR = 0 the year and area lines are absent.
	const areaKm2 = readTable(lines, countLine(lines, 'L.004', 'L.004 NYR'), 'L.005', 'L.006', 'area');
	const pIndex = readTwelve(lines.next('L.007'), 'L.007 PINDEX');
	const panMm = readTwelve(lines.next('L.008'), 'L.008 APAN');
	const panFactors = readTwelve(lines.next('L.009'), 'L.009 APF');
	const l10 = lines.next('L.010');
	const maxAnnualAllocationMm = l10.number('L.010 PERM');
	const effectiveRainfallFactors = readTwelve(l10, 'L.010 EFFP');
	const abstractionRoute = endInteger(lines.next('L.011'), 'L.011 NRRARN');
	const l12 = lines.next('L.012');
	const returnFlowRoute = l12.integer('L.012 NRRRRN');
	const returnFlowPercent = l12.number('L.012 RRPERC');
	l12.end('L.012');

	const core: IrrigationCore = {
		kind: 'RR',
		number,
		name,
		fileVersion,
		modelType,
		mapMm,
		rainfallFile,
		areaKm2,
		pIndex,
		panMm,
		panFactors,
		maxAnnualAllocationMm,
		effectiveRainfallFactors,
		abstractionRoute,
		returnFlowRoute,
		returnFlowPercent
	};

	if (fileVersion === 0 || (fileVersion === WQT_VERSION && lines.atEnd)) {
		if (drought !== undefined) throw l3.error('the file ends at L.012, but L.003 carries the WQT flags', 'L.003 DROUGHT_APPLICABLE');
		const trailingLines = lines.rest();
		return { ...core, layout: 'pitman', ...(trailingLines.length > 0 && { trailingLines }) };
	}
	if (drought === undefined) throw l3.error('a WQT file (more than 12 lines) needs the drought flag', 'L.003 DROUGHT_APPLICABLE');

	const l13 = lines.next('L.013');
	const areaInterpolation = l13.integer('L.013 KA+1');
	const maxAllocationMm3PerYear = l13.number('L.013 RRMA');
	const allocationPoints = l13.integer('L.013 NPMA');
	const allocationInterpolation = l13.integer('L.013 KMA+1');
	const runoffModule = l13.integer('L.013 IRRSW');
	l13.end('L.013');

	const l14 = lines.next('L.014');
	const canalSeepageToReturn = l14.number('L.014 TLSQRF');
	const netReturnFlows = flag(l14, 'L.014 NETRETFLOWS');
	l14.end('L.014');

	const l15 = lines.next('L.015');
	const p = l15.numbers('L.015', 10) as [number, number, number, number, number, number, number, number, number, number];
	l15.end('L.015');
	const l16 = lines.next('L.016');
	const s = l16.numbers('L.016', 6) as [number, number, number, number, number, number];
	l16.end('L.016');
	const rainfallFactors = readTwelve(lines.next('L.017'), 'L.017 RRERF');
	const aPanFactors = readTwelve(lines.next('L.018'), 'L.018 APFWQ');

	const cropCount = countLine(lines, 'L.019', 'L.019 NCPS');
	const crops: IrrigationCrop[] = [];
	for (let k = 0; k < cropCount; k++) {
		const c = lines.next('L.020');
		const factors = c.numbers('L.020 crop factor', 12) as unknown as Monthly12;
		const percent = c.number('L.020 CPF');
		const description = c.string('L.020 crop');
		c.end('L.020');
		crops.push({ factors, percent, description });
	}

	const l21 = lines.next('L.021');
	const effectiveRainfallLimits: [number, number] = [l21.number('L.021 RRERL1'), l21.number('L.021 RRERL2')];
	l21.end('L.021');

	const allocation = readInterpolated(lines, 'L.022', 'L.023', 'L.024', 'allocation');
	const returnFlowGrowth = readInterpolated(lines, 'L.025', 'L.026', 'L.027', 'return-flow growth');
	const efficiency = readInterpolated(lines, 'L.028', 'L.029', 'L.030', 'efficiency');

	const wqt = {
		...core,
		droughtReduction: drought,
		...(clipping !== undefined && { curtailByClipping: clipping }),
		areaInterpolation,
		maxAllocationMm3PerYear,
		allocationPoints,
		allocationInterpolation,
		runoffModule,
		canalSeepageToReturn,
		netReturnFlows,
		canalFlowLoss: p[0],
		canalSaltLoss: p[1],
		efficiencyFactor: p[2],
		returnFlowFactor: p[3],
		returnFlowUpperZone: p[4],
		returnFlowLowerZone: p[5],
		saltParameters: [p[6], p[7], p[8], p[9]] as const,
		initialSaltLoad: [s[0], s[1]] as const,
		soilMoistureCapacityUpperMm: s[2],
		soilMoistureCapacityLowerMm: s[3],
		soilMoistureTargetMm: s[4],
		soilMoistureInitialMm: s[5],
		rainfallFactors,
		aPanFactors,
		crops,
		effectiveRainfallLimits,
		allocation,
		returnFlowGrowth,
		efficiency
	};

	if (fileVersion === WQT_VERSION) {
		const trailingLines = lines.rest();
		return { ...wqt, layout: 'wqt', ...(trailingLines.length > 0 && { trailingLines }) };
	}

	// v42, TT 691 pp.162–176. Never observed (U-11): read per the manual's example.
	const minRainfallFactors = readTwelve(lines.next('L.031'), 'L.031 RRERFT4');
	const maxRainfallFactors = readTwelve(lines.next('L.032'), 'L.032 RRERFMT4');
	const capacity = readInterpolated(lines, 'L.033', 'L.034', 'L.035', 'capacity');
	const canalTransmissionLoss = endNumber(lines.next('L.036'), 'L.036 RRTLPET4');
	const deepSeatedGroundwater = endNumber(lines.next('L.037'), 'L.037 RRPDLT4');
	const maxUpperZoneStorageMm = endNumber(lines.next('L.038'), 'L.038 RRHMAXT4');
	const minUpperZoneStorageMm = endNumber(lines.next('L.039'), 'L.039 RRHMINT4');
	const canalEndSpill = endNumber(lines.next('L.040'), 'L.040 RRPENDT4');
	const trailingLines = lines.rest();
	return {
		...wqt,
		layout: 'wqt4',
		minRainfallFactors,
		maxRainfallFactors,
		capacity,
		canalTransmissionLoss,
		deepSeatedGroundwater,
		maxUpperZoneStorageMm,
		minUpperZoneStorageMm,
		canalEndSpill,
		...(trailingLines.length > 0 && { trailingLines })
	};
}

/** A 0/1 flag written as an integer. */
function flag(cursor: FieldCursor, field: string): boolean {
	const token = cursor.numberToken(field);
	if (!token.integer || (token.value !== 0 && token.value !== 1)) throw cursor.error(`expected 0 or 1, found '${token.text}'`, field, token);
	return token.value === 1;
}

/** A line holding a single count. */
function countLine(lines: ModuleLines, lineType: string, field: string): number {
	const cursor = lines.next(lineType);
	const count = readCount(cursor, field);
	cursor.end(lineType);
	return count;
}

function endInteger(cursor: FieldCursor, field: string): number {
	const value = cursor.integer(field);
	cursor.end(field);
	return value;
}

function endNumber(cursor: FieldCursor, field: string): number {
	const value = cursor.number(field);
	cursor.end(field);
	return value;
}

/** `count` years on one line, `count` values on the next; both lines absent when `count` is 0. */
function readTable(lines: ModuleLines, count: number, yearType: string, valueType: string, what: string): YearTable {
	if (count === 0) return [];
	const y = lines.next(yearType);
	const years: number[] = [];
	for (let k = 0; k < count; k++) years.push(y.integer(`${yearType} year[${k}]`));
	y.end(yearType);
	const v = lines.next(valueType);
	const values = v.numbers(`${valueType} ${what}`, count);
	v.end(valueType);
	return years.map((year, k) => ({ year, value: values[k] as number }));
}

/** A count-and-interpolation line, then a year table (RR L.022–L.030, L.033–L.035). */
function readInterpolated(lines: ModuleLines, countType: string, yearType: string, valueType: string, what: string): InterpolatedYearTable {
	const c = lines.next(countType);
	const count = readCount(c, `${countType} count`);
	const interpolation = c.integer(`${countType} interpolation`);
	c.end(countType);
	return { interpolation, values: readTable(lines, count, yearType, valueType, what) };
}

/**
 * Upgrade an original-layout (WRSM90 or 12-line) module to the v32 WQT
 * layout, as docs/formats.md §8.2 asks. The model type stays 1 (Pitman),
 * so the run is unchanged. The WQT lines take the defaults of the manual's
 * WQT examples (TT 691 pp.162–163): crop `'composite'` at 100 % with the
 * L.009 factors, no allocation, return-flow or efficiency tables. The
 * runoff module the block lies in is unknown, so `runoffModule` is 0.
 */
export function upgradeIrrigation(m: IrrigationPitmanLayout): IrrigationWqtLayout {
	const { layout: _layout, trailingLines: _trailing, ...core } = m;
	const ones = Array.from({ length: 12 }, () => 1) as unknown as Monthly12;
	const none: InterpolatedYearTable = { interpolation: 1, values: [] };
	return {
		...core,
		layout: 'wqt',
		fileVersion: WQT_VERSION,
		droughtReduction: false,
		curtailByClipping: false,
		areaInterpolation: 1,
		maxAllocationMm3PerYear: 0,
		allocationPoints: 0,
		allocationInterpolation: 1,
		runoffModule: 0,
		canalSeepageToReturn: 0,
		netReturnFlows: true,
		canalFlowLoss: 0,
		canalSaltLoss: 0,
		efficiencyFactor: 0.85,
		returnFlowFactor: 0.02,
		returnFlowUpperZone: 0.75,
		returnFlowLowerZone: 0.15,
		saltParameters: [0, 0, 0, 0],
		initialSaltLoad: [0, 0],
		soilMoistureCapacityUpperMm: 400,
		soilMoistureCapacityLowerMm: 1000,
		soilMoistureTargetMm: 250,
		soilMoistureInitialMm: 250,
		rainfallFactors: ones,
		aPanFactors: m.panFactors,
		crops: [{ factors: m.panFactors, percent: 100, description: 'composite' }],
		effectiveRainfallLimits: [100, 0],
		allocation: none,
		returnFlowGrowth: none,
		efficiency: none
	};
}

/**
 * Write an irrigation file as version 32 in WRSM2000's own layout
 * (docs/formats.md §8.1): minimal-width values, single-spaced, CRLF line
 * endings. A `pitman` module is upgraded first (`upgradeIrrigation`); a
 * `wqt4` module is an error, since the v42 layout is unverified (U-11).
 */
export function writeIrrigation(m: IrrigationModule): string {
	if (m.layout === 'wqt4') {
		throw new Error(`RR ${m.number}: writing WQT type 4 (file version 42) is not supported (docs/formats.md §8.1, U-11)`);
	}
	const w = m.layout === 'pitman' ? upgradeIrrigation(m) : m;

	const out: string[] = [];
	const list = (values: readonly number[], decimals: number, field: string) =>
		values.map((v, k) => minimal(v, decimals, `${field}[${k}]`)).join(' ');
	const table = (t: YearTable, decimals: number, yearType: string, valueType: string) => {
		if (t.length === 0) return;
		out.push(t.map((e, k) => int(e.year, `${yearType} year[${k}]`)).join(' '));
		out.push(list(t.map((e) => e.value), decimals, valueType));
	};
	const interpolated = (t: InterpolatedYearTable, countType: string, yearType: string, valueType: string) => {
		out.push(`${t.values.length} ${int(t.interpolation, `${countType} interpolation`)}`);
		table(t.values, 3, yearType, valueType);
	};
	const bit = (b: boolean) => (b ? '1' : '0');

	out.push(` ${int(w.number, 'L.001 NRREN')}  ${quoted(w.name, 'L.001 RRNAM')} ${WQT_VERSION}`);
	out.push(` ${int(w.modelType, 'L.002 MODEL')}`);
	const clip = w.curtailByClipping === undefined ? '' : ` ${bit(w.curtailByClipping)}`;
	out.push(`${minimal(w.mapMm, 2, 'L.003 RRMAP')}  ${quoted(w.rainfallFile, 'L.003 rainfall file')} ${bit(w.droughtReduction)}${clip}`);
	out.push(String(w.areaKm2.length));
	table(w.areaKm2, 2, 'L.005', 'L.006 area');
	out.push(list(w.pIndex, 2, 'L.007 PINDEX'));
	out.push(list(w.panMm, 2, 'L.008 APAN'));
	out.push(list(w.panFactors, 2, 'L.009 APF'));
	out.push(`${minimal(w.maxAnnualAllocationMm, 3, 'L.010 PERM')} ${list(w.effectiveRainfallFactors, 4, 'L.010 EFFP')}`);
	out.push(int(w.abstractionRoute, 'L.011 NRRARN'));
	out.push(`${int(w.returnFlowRoute, 'L.012 NRRRRN')} ${minimal(w.returnFlowPercent, 2, 'L.012 RRPERC')}`);
	out.push(
		[
			int(w.areaInterpolation, 'L.013 KA+1'),
			minimal(w.maxAllocationMm3PerYear, 2, 'L.013 RRMA'),
			int(w.allocationPoints, 'L.013 NPMA'),
			int(w.allocationInterpolation, 'L.013 KMA+1'),
			int(w.runoffModule, 'L.013 IRRSW')
		].join(' ')
	);
	out.push(`${minimal(w.canalSeepageToReturn, 3, 'L.014 TLSQRF')} ${bit(w.netReturnFlows)}`);
	out.push(
		list(
			[
				w.canalFlowLoss,
				w.canalSaltLoss,
				w.efficiencyFactor,
				w.returnFlowFactor,
				w.returnFlowUpperZone,
				w.returnFlowLowerZone,
				...w.saltParameters
			],
			4,
			'L.015'
		)
	);
	out.push(
		list(
			[
				...w.initialSaltLoad,
				w.soilMoistureCapacityUpperMm,
				w.soilMoistureCapacityLowerMm,
				w.soilMoistureTargetMm,
				w.soilMoistureInitialMm
			],
			3,
			'L.016'
		)
	);
	out.push(list(w.rainfallFactors, 3, 'L.017 RRERF'));
	out.push(list(w.aPanFactors, 3, 'L.018 APFWQ'));
	out.push(String(w.crops.length));
	for (const c of w.crops) {
		out.push(`${list(c.factors, 3, 'L.020 crop factor')} ${minimal(c.percent, 2, 'L.020 CPF')} ${quoted(c.description, 'L.020 crop')}`);
	}
	out.push(list(w.effectiveRainfallLimits, 3, 'L.021'));
	interpolated(w.allocation, 'L.022', 'L.023', 'L.024');
	interpolated(w.returnFlowGrowth, 'L.025', 'L.026', 'L.027');
	interpolated(w.efficiency, 'L.028', 'L.029', 'L.030');
	for (const line of w.trailingLines ?? []) out.push(line.text);
	return joinLines(out);
}
