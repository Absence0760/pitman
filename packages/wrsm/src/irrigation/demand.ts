/**
 * Irrigation demand (agent 7.1; docs/theory/irrigation.md §3–§6): what an RR
 * module asks of its abstraction route, every month of the run.
 *
 * L.002 picks the method:
 *
 *   1 Pitman        TT 690 ch.3 pp.11, eqs. 3.1–3.3
 *   2 WQT           TT 690 ch.4 pp.12–15, eqs. 4.1–4.8; §5.2 pp.27 for the limits
 *   3 WQT-SAPWAT    TT 690 ch.5 pp.26–29, eqs. 5.1–5.9
 *   4 WQT type 4    TT 690 §6.6.1–6.6.5 pp.34–42, eqs. 6.17–6.29
 *
 * Demand depends on rainfall, the module's data and the run mode, **never on
 * the supply**. That is what lets the network solve an RR in two passes
 * (R7-I2): the same series goes to the supplier and to `supply.ts`.
 *
 * Every choice the manuals leave open has an ID (R7-I…) in the spec and, where
 * it is cheap, a field of `IrrigationOptions`.
 */

import { yearTableValue } from '../runoff/pitman.js';
import type {
	HydroYear,
	InterpolatedYearTable,
	IrrigationCrop,
	IrrigationModelType,
	IrrigationModule,
	IrrigationWqt4Layout,
	IrrigationWqtLayout,
	Monthly12,
	MonthlySeries,
	RainfallSeries,
	RunMessage,
	RunMode,
	YearTable
} from '../types.js';

/** The provisional choices worth switching, each an R7-I… in docs/decisions.md. */
export interface IrrigationOptions {
	/**
	 * R7-I4: a WQT allocation (RRMA, or a year-table value) of 0 or less.
	 * `noLimit` (default): no allocation is set. `noWater`: eq. 4.8 as printed,
	 * so the block demands nothing.
	 */
	readonly zeroAllocation: 'noLimit' | 'noWater';
	/**
	 * R7-I5: where a negative crop demand is cut off. `perCrop` (default, TT 690
	 * p.12: "positive value only" under the Σ); `total` (p.35: "If DIN is less
	 * than zero, then DIN is set to zero").
	 */
	readonly cropDemandClip: 'perCrop' | 'total';
}

export const DEFAULT_IRRIGATION_OPTIONS: IrrigationOptions = {
	zeroAllocation: 'noLimit', // R7-I4
	cropDemandClip: 'perCrop' // R7-I5
};

/** Above this an ET(crop) no longer raises the SAPWAT effective rainfall (TT 690 p.28 eq. 5.7; TT 691 p.209 item 75), mm/month. */
export const SAPWAT_MAX_ET_MM = 75;

/** A crop on less than this share of the area is ignored (TT 689 p.96), %. */
const MIN_CROP_PERCENT = 0.01;

/** Invalid irrigation data or inputs. The message names the module. */
export class IrrigationRunError extends Error {
	override readonly name = 'IrrigationRunError';
}

/** An RR's demand over the run; each array has 12 values per year, October first. */
export interface IrrigationDemand {
	/** The method in force (L.002, after R7-I1). */
	readonly modelType: IrrigationModelType;
	readonly startYear: HydroYear;
	/** Rainfall on the block, RRMAP × % MAP / 100, mm. */
	readonly rainMm: readonly number[];
	/** Unit demand, mm: N (eq. 3.2) for type 1; DIN after the drought factor for the others. */
	readonly unitDemandMm: readonly number[];
	/** DF (eq. 5.8, 6.21); 1 when the option is off. */
	readonly droughtFactor: readonly number[];
	/** Crop demand before rain, mm: G (eq. 3.1) for type 1, TCD otherwise (p.17). */
	readonly cropDemandMm: readonly number[];
	/** PEL, A-pan × the method's pan factor (L.018 for types 2–3, L.009 for type 4), mm. */
	readonly openWaterEvaporationMm: readonly number[];
	/** AREA / AIRR: the block's area in force, km². */
	readonly areaKm2: readonly number[];
	/** AREAT: the area the allocation leaves irrigable (eq. 4.8), km². Equal to `areaKm2` for type 4. */
	readonly targetAreaKm2: readonly number[];
	/** EFI or RRIE as a proportion (R7-I6). */
	readonly efficiency: readonly number[];
	/** RF or RRLF as a proportion, growth included (R7-I6). */
	readonly returnFlowFactor: readonly number[];
	/** Gross demand at the source, QIG (eq. 4.6, 6.23–6.29) or V (eq. 3.3), million m³/month. */
	readonly gross: MonthlySeries;
	readonly messages: readonly RunMessage[];
}

/** Months of the hydrological year. */
const MONTH_NAMES = ['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'] as const;

/**
 * A year table's value in `year`: `code` 1 linear, 2 exponential, 3 the
 * value of the latest row at or before `year` (U-14, stored as `K + 1`). Flat
 * beyond the table (OQ-17). Exponential needs two positive ends; otherwise
 * that stretch is linear.
 */
export function interpolateYearTable(table: YearTable, year: HydroYear, code: number): number {
	if (code === 3) {
		let value = table[0]?.value ?? 0;
		for (const row of table) if (row.year <= year) value = row.value;
		return value;
	}
	if (code === 2) {
		for (let i = 1; i < table.length; i++) {
			const lo = table[i - 1]!;
			const hi = table[i]!;
			if (year > lo.year && year < hi.year && lo.value > 0 && hi.value > 0) {
				return lo.value * (hi.value / lo.value) ** ((year - lo.year) / (hi.year - lo.year));
			}
		}
	}
	return yearTableValue(table, year);
}

/**
 * The block's area in hydrological year `year` in `mode` (D1): the table's value
 * in that year, held at `mode.year` in present day, 0 in natural. Always linear
 * for the Pitman method (TT 689 p.83); L.013 v1 otherwise. Flat beyond the table.
 */
export function irrigatedAreaKm2(module: IrrigationModule, mode: RunMode, year: HydroYear): number {
	if (mode.kind === 'natural') return 0;
	const code = module.layout === 'pitman' || module.modelType === 1 ? 1 : module.areaInterpolation;
	return interpolateYearTable(module.areaKm2, mode.kind === 'presentDay' ? mode.year : year, code);
}

/** Effective rainfall with RRERF and limits: TT 690 eqs. 5.3–5.6 as corrected, 6.18a–c and 6.19a. `max` is 1 for WQT, RRERFM for type 4. */
export function effectiveRainfall(rain: number, factor: number, max: number, upperLimit: number, lowerLimit: number): number {
	if (rain >= upperLimit) return factor * rain; // eq. 5.4, 6.18c
	if (rain <= lowerLimit) return max * rain; // eq. 5.6, 6.18a
	// eq. 6.18b; TT 689 p.97. Eq. 5.5 is misprinted (spec errata E-5).
	return (factor + ((max - factor) * (upperLimit - rain)) / (upperLimit - lowerLimit)) * rain;
}

/**
 * The SAPWAT effective rainfall (TT 690 p.28 eq. 5.7, p.37 eq. 6.19b), ET
 * capped at 75 mm. R7-I8: kept within 0 … rain, and 0 when ET is 0 (the
 * quadratic has no meaning there, and no demand either).
 */
export function sapwatEffectiveRainfall(rain: number, etMm: number): number {
	if (!(etMm > 0)) return 0;
	const et = Math.min(etMm, SAPWAT_MAX_ET_MM);
	const er = et * ((-0.001 * rain * rain) / et + (0.025 * rain * rain) / (et * et) + 0.0016 * rain + (0.6 * rain) / et);
	return Math.min(rain, Math.max(0, er));
}

/** DF (TT 690 p.28 eq. 5.8; p.39 eq. 6.21a): the wetter of month and year against their means, 0 … 1. A month with no mean rain counts 0 (R7-I9). */
export function droughtFactor(rain: number, meanMonthRain: number, annualRain: number, meanAnnualRain: number): number {
	const month = meanMonthRain > 0 ? rain / meanMonthRain : 0;
	const year = meanAnnualRain > 0 ? annualRain / meanAnnualRain : 1;
	return Math.min(1, Math.max(0, Math.max(month, year)));
}

/** DIN from crop, pan and effective rainfall (TT 690 eqs. 4.1, 5.1, 6.17a). */
export function unitCropDemand(crops: readonly IrrigationCrop[], panMm: number, m: number, er: number, clip: IrrigationOptions['cropDemandClip']): number {
	let din = 0;
	for (const crop of crops) {
		if (crop.percent < MIN_CROP_PERCENT) continue;
		const net = (crop.percent * (panMm * crop.factors[m]! - er)) / 100;
		din += clip === 'perCrop' ? Math.max(0, net) : net;
	}
	return Math.max(0, din);
}

/** Total crop demand TCD (TT 690 p.17): pan × crop factor, weighted by area. */
export function totalCropDemand(crops: readonly IrrigationCrop[], panMm: number, m: number): number {
	let tcd = 0;
	for (const crop of crops) if (crop.percent >= MIN_CROP_PERCENT) tcd += (crop.percent * panMm * crop.factors[m]!) / 100;
	return tcd;
}

/** A value the manuals print both as a proportion and as a percentage (R7-I6). */
export function proportion(value: number): number {
	return value > 1 ? value / 100 : value;
}

/** The mean month and year of a rainfall file over all its rows, mm (TT 690 eq. 6.26: "whole record"). */
function meanRainfall(rainfall: RainfallSeries, mapMm: number): { readonly monthMm: Monthly12; readonly yearMm: number } {
	const sum = new Array<number>(12).fill(0);
	for (const row of rainfall.rows) row.months.forEach((pc, m) => (sum[m]! += (pc / 100) * mapMm));
	const count = Math.max(1, rainfall.rows.length);
	const monthMm = sum.map((v) => v / count) as unknown as Monthly12;
	return { monthMm, yearMm: sum.reduce((s, v) => s + v, 0) / count };
}

/**
 * The method in force. A 12-line layout has only the Pitman data whatever
 * L.002 says; a v32 file claiming type 4 lacks L.031–L.040 and can't run (R7-I1).
 */
export function irrigationMethod(module: IrrigationModule, fail: (text: string) => never): IrrigationModelType {
	if (module.layout === 'pitman') return 1;
	if (module.modelType === 4 && module.layout !== 'wqt4') return fail('model type 4 (L.002) needs a version 42 file; L.031–L.040 are missing');
	return module.modelType;
}

interface Series {
	readonly rainMm: number[];
	readonly unit: number[];
	readonly df: number[];
	readonly crop: number[];
	readonly pel: number[];
	readonly area: number[];
	readonly target: number[];
	readonly efficiency: number[];
	readonly returnFactor: number[];
	readonly gross: number[];
}

/**
 * The demand of one RR over `startYear`–`endYear` in `mode` (D1): historical
 * takes each year's tables, present day holds them at `mode.year`, natural
 * has no irrigation. Throws `IrrigationRunError` naming the module.
 */
export function irrigationDemand(
	module: IrrigationModule,
	rainfall: RainfallSeries | undefined,
	mode: RunMode,
	startYear: HydroYear,
	endYear: HydroYear,
	options: Partial<IrrigationOptions> = {}
): IrrigationDemand {
	const opts: IrrigationOptions = { ...DEFAULT_IRRIGATION_OPTIONS, ...options };
	const label = `RR ${module.number}${module.name.trim() ? ` (${module.name.trim()})` : ''}`;
	const fail = (text: string): never => {
		throw new IrrigationRunError(`${label}: ${text}`);
	};
	const ref = { type: 'RR', number: module.number } as const;
	const messages: RunMessage[] = [];
	const note = (level: RunMessage['level'], text: string) => messages.push({ level, module: ref, text });

	const method = irrigationMethod(module, fail);
	if (!Number.isFinite(module.mapMm) || module.mapMm < 0) fail(`MAP (L.003) must be non-negative, got ${module.mapMm}`);
	module.panMm.forEach((v, m) => {
		if (!Number.isFinite(v) || v < 0) fail(`pan evaporation for ${MONTH_NAMES[m]} (L.008) must be non-negative, got ${v}`);
	});

	const natural = mode.kind === 'natural';
	const yearFor = (y: HydroYear): HydroYear => (mode.kind === 'presentDay' ? mode.year : y);

	const rows = new Map((rainfall?.rows ?? []).map((row) => [row.year, row.months]));
	if (!natural && !rainfall) fail(`rainfall file '${module.rainfallFile}' (L.003) is not in the network`);
	if (!natural && module.areaKm2.length === 0) note('warning', `${label}: no irrigated-area table (L.004 is 0), so it irrigates nothing`);
	if (mode.kind === 'historical' && module.areaKm2.length > 0 && (module.areaKm2[0]!.year > startYear || module.areaKm2[module.areaKm2.length - 1]!.year < endYear)) {
		// TT 689 p.82: the pairs should span the simulation; the program checks. Flat beyond them (OQ-17).
		note('warning', `${label}: irrigated-area years ${module.areaKm2[0]!.year}–${module.areaKm2[module.areaKm2.length - 1]!.year} don't cover the run ${startYear}–${endYear}; held flat beyond them (TT 689 p.82)`);
	}

	const s: Series = { rainMm: [], unit: [], df: [], crop: [], pel: [], area: [], target: [], efficiency: [], returnFactor: [], gross: [] };
	const means = !natural && rainfall ? meanRainfall(rainfall, module.mapMm) : { monthMm: new Array<number>(12).fill(0) as unknown as Monthly12, yearMm: 0 };

	for (let y = startYear; y <= endYear; y++) {
		const months = natural ? new Array<number>(12).fill(0) : (rows.get(y) ?? fail(`rainfall file '${module.rainfallFile}' has no year ${y}`));
		const rain = months.map((pc, m) => {
			if (!Number.isFinite(pc) || pc < 0) fail(`rainfall file '${module.rainfallFile}' has a negative or invalid value (${pc}) in ${MONTH_NAMES[m]} ${y}`);
			return (pc / 100) * module.mapMm; // TT 690 §1.3
		});
		const area = irrigatedAreaKm2(module, mode, y);
		if (!(area >= 0)) fail(`irrigated area ${area} in ${y} must be non-negative (L.006)`);
		const year = { rain, area, y };
		const annual =
			method === 1
				? pitmanYear(module, year)
				: method === 4
					? wqt4Year(module as IrrigationWqt4Layout, year, means, yearFor(y), opts, fail)
					: wqtYear(module as IrrigationWqtLayout, method, year, means, yearFor(y), opts, fail);
		for (const key of Object.keys(s) as (keyof Series)[]) s[key].push(...annual[key]);
	}

	if (method !== 1 && module.layout !== 'pitman') {
		if (!natural) wqtDataNotes(module, method, note, label);
		const cut = s.area.reduce((n, a, t) => (a > 0 && (s.target[t] ?? a) < a - 1e-12 ? n + 1 : n), 0);
		if (cut > 0) note('info', `${label}: the allocation limits irrigation in ${Math.ceil(cut / 12)} year(s) (TT 690 eq. 4.8)`);
	}

	return {
		modelType: method,
		startYear,
		rainMm: s.rainMm,
		unitDemandMm: s.unit,
		droughtFactor: s.df,
		cropDemandMm: s.crop,
		openWaterEvaporationMm: s.pel,
		areaKm2: s.area,
		targetAreaKm2: s.target,
		efficiency: s.efficiency,
		returnFlowFactor: s.returnFactor,
		gross: { startYear, values: s.gross, unit: 'Mm3' },
		messages
	};
}

function wqtDataNotes(module: IrrigationWqtLayout | IrrigationWqt4Layout, method: IrrigationModelType, note: (level: RunMessage['level'], text: string) => void, label: string): void {
	if (module.efficiencyFactor > 1) note('info', `${label}: efficiency ${module.efficiencyFactor} (L.015) read as a percentage (R7-I6)`);
	if (module.returnFlowFactor > 1) note('info', `${label}: return-flow factor ${module.returnFlowFactor} (L.015) read as a percentage (R7-I6)`);
	if (method === 4 && module.layout === 'wqt4' && module.rainfallFactors.some((v, m) => v > module.maxRainfallFactors[m]!)) {
		// TT 690 p.37: 0 < RRERF ≤ RRERFM ≤ 1. TT 691 pp.172–174's own example breaks it.
		note('warning', `${label}: a minimum rainfall factor (L.017) is above its maximum (L.032); used as they stand (TT 690 p.37, R7-I14)`);
	}
}

interface YearInput {
	readonly rain: readonly number[];
	readonly area: number;
	readonly y: HydroYear;
}

type YearResult = Series;

/** TT 690 ch.3 p.11, with PERM (TT 689 p.95). L.003's flag picks proportional or clipped curtailment. */
function pitmanYear(module: IrrigationModule, { rain, area }: YearInput): YearResult {
	const clip = module.layout !== 'pitman' && module.curtailByClipping === true;
	const gross: number[] = [];
	const net: number[] = [];
	const crop: number[] = [];
	let depth = 0;
	for (let m = 0; m < 12; m++) {
		const g = module.panMm[m]! * module.panFactors[m]!; // eq. 3.1
		const n = Math.max(g - rain[m]! * module.effectiveRainfallFactors[m]!, 0); // eq. 3.2
		crop.push(g);
		net.push(n);
		gross.push(0.001 * n * area * module.pIndex[m]!); // eq. 3.3
		depth += n * module.pIndex[m]!;
	}
	const perm = module.maxAnnualAllocationMm;
	if (!(perm > 0)) gross.fill(0); // TT 689 p.95: "As long as this figure is 0 … no abstractions whatsoever"
	else if (depth > perm) {
		if (clip) gross.forEach((v, m) => (gross[m] = Math.min(v, (0.001 * area * perm) / 12)));
		else gross.forEach((v, m) => (gross[m] = (v * perm) / depth));
	}
	const twelve = (v: number) => new Array<number>(12).fill(v);
	return { rainMm: [...rain], unit: net, df: twelve(1), crop, pel: twelve(0), area: twelve(area), target: twelve(area), efficiency: twelve(1), returnFactor: twelve(0), gross };
}

/** The year-varying WQT factors: base × growth for types 2–3; the table's values for type 4 (TT 689 p.98, p.102). */
function wqtFactors(module: IrrigationWqtLayout | IrrigationWqt4Layout, type4: boolean, year: HydroYear, fail: (t: string) => never): { efficiency: number; returnFactor: number } {
	const at = (t: InterpolatedYearTable, fallback: number) => (t.values.length === 0 ? fallback : interpolateYearTable(t.values, year, t.interpolation));
	const base = proportion(module.efficiencyFactor);
	const efficiency = type4 ? (module.efficiency.values.length > 0 ? proportion(at(module.efficiency, base)) : base) : base * at(module.efficiency, 1);
	if (!(efficiency > 0)) return fail(`irrigation efficiency ${efficiency} must be positive (L.015, L.030): a block can't apply water at no efficiency`);
	return { efficiency: Math.min(1, efficiency), returnFactor: proportion(module.returnFlowFactor) * at(module.returnFlowGrowth, 1) };
}

/** The annual allocation in force, or `null` when none limits the block (R7-I4). */
function allocationIn(module: IrrigationWqtLayout | IrrigationWqt4Layout, type4: boolean, year: HydroYear, opts: IrrigationOptions): number | null {
	const t = module.allocation;
	const has = t.values.length > 0;
	const value = interpolateYearTable(t.values, year, t.interpolation);
	const all = type4 && has ? value : module.maxAllocationMm3PerYear * (has ? value : 1);
	return all > 0 ? all : opts.zeroAllocation === 'noWater' ? 0 : null;
}

/** TT 690 ch.4 (type 2) and ch.5 (type 3), eqs. 4.1–4.8, 5.1–5.9. */
function wqtYear(module: IrrigationWqtLayout, method: IrrigationModelType, { rain, area }: YearInput, means: ReturnType<typeof meanRainfall>, year: HydroYear, opts: IrrigationOptions, fail: (t: string) => never): YearResult {
	const loss = module.canalFlowLoss;
	if (!(loss >= 0 && loss < 1)) fail(`transfer-canal loss ${loss} (L.015) must be 0 ≤ TLPQ < 1`);
	const { efficiency, returnFactor } = wqtFactors(module, false, year, fail);
	const annualRain = rain.reduce((s, v) => s + v, 0);
	const sapwat = method === 3;
	const first = module.crops[0];
	if (sapwat && !first) fail('WQT-SAPWAT needs one crop line with its monthly ET (L.020)');
	const [upper, lower] = module.effectiveRainfallLimits;

	const unit: number[] = [];
	const crop: number[] = [];
	const pel: number[] = [];
	const df: number[] = [];
	const full: number[] = [];
	for (let m = 0; m < 12; m++) {
		const r = rain[m]!;
		const f = module.droughtReduction ? droughtFactor(r, means.monthMm[m]!, annualRain, means.yearMm) : 1;
		let din: number;
		let tcd: number;
		if (sapwat) {
			tcd = first!.factors[m]!; // TT 689 p.96: the first row is the ET; Table 5.1: PE = ET(crop), CF = 1, CPF = 100 %
			din = Math.max(0, tcd - sapwatEffectiveRainfall(r, tcd)); // eqs. 5.1–5.2, 5.7
		} else {
			tcd = totalCropDemand(module.crops, module.panMm[m]!, m);
			const er = effectiveRainfall(r, module.rainfallFactors[m]!, 1, upper, lower); // eqs. 5.3–5.6
			din = unitCropDemand(module.crops, module.panMm[m]!, m, er, opts.cropDemandClip); // eq. 4.1
		}
		df.push(f);
		din *= f; // eq. 5.9
		unit.push(din);
		crop.push(tcd);
		pel.push(module.panMm[m]! * module.aPanFactors[m]!);
		full.push(((din * area) / 1000 / efficiency) * (1 / (1 - loss))); // eq. 4.6
	}

	// The annual allocation (eq. 4.8), or the clip of TT 691 p.161 L.003 v4.
	const all = allocationIn(module, false, year, opts);
	const aqig = full.reduce((s, v) => s + v, 0);
	let gross = full;
	let target = new Array<number>(12).fill(area);
	if (all !== null && aqig > all) {
		if (module.curtailByClipping === true) {
			gross = full.map((v) => Math.min(v, all / 12)); // R7-I10
			target = full.map((v, m) => (v > 0 ? (area * gross[m]!) / v : area));
		} else {
			const scale = all / aqig;
			gross = full.map((v) => v * scale);
			target = target.map((v) => v * scale); // AREAT = AREA × ALL / AQIG
		}
	}
	const twelve = (v: number) => new Array<number>(12).fill(v);
	return { rainMm: [...rain], unit, df, crop, pel, area: twelve(area), target, efficiency: twelve(efficiency), returnFactor: twelve(returnFactor), gross };
}

/** DIN of WQT type 4 (eqs. 6.17a, 6.18a–c, 6.19a), the same with RAINM for DINM (p.41). */
function wqt4Din(module: IrrigationWqt4Layout, r: number, m: number, opts: IrrigationOptions): number {
	const [upper, lower] = module.effectiveRainfallLimits;
	const er = effectiveRainfall(r, module.rainfallFactors[m]!, module.maxRainfallFactors[m]!, upper, lower);
	return unitCropDemand(module.crops, module.panMm[m]!, m, er, opts.cropDemandClip);
}

/** TT 690 §6.6.1–6.6.5 pp.34–42, eqs. 6.17–6.29. */
function wqt4Year(module: IrrigationWqt4Layout, { rain, area }: YearInput, means: ReturnType<typeof meanRainfall>, year: HydroYear, opts: IrrigationOptions, fail: (t: string) => never): YearResult {
	const loss = module.canalFlowLoss;
	if (!(loss >= 0 && loss < 1)) fail(`transfer-canal loss ${loss} (L.015) must be 0 ≤ RRTLPQ < 1`);
	const { efficiency, returnFactor } = wqtFactors(module, true, year, fail);
	const annualRain = rain.reduce((s, v) => s + v, 0);
	// R7-I15: a capacity of 0 is the manual's default (TT 689 p.175) and means no limit.
	const capT = module.capacity;
	const capacity = capT.values.length > 0 ? interpolateYearTable(capT.values, year, capT.interpolation) : 0;
	const all = allocationIn(module, true, year, opts);

	const dinm = means.monthMm.map((r, m) => wqt4Din(module, r, m, opts));
	const sum = dinm.reduce((s, v) => s + v, 0);
	const dfac = dinm.map((v) => (sum > 0 ? v / sum : 1 / 12)); // eq. 6.25

	const unit: number[] = [];
	const crop: number[] = [];
	const pel: number[] = [];
	const df: number[] = [];
	const gross: number[] = [];
	let accaloc = 0; // eq. 6.28a
	for (let m = 0; m < 12; m++) {
		const r = rain[m]!;
		const f = module.droughtReduction ? droughtFactor(r, means.monthMm[m]!, annualRain, module.mapMm) : 1; // eqs. 6.21a–b
		const din = wqt4Din(module, r, m, opts);
		const qid = (area * din) / 1000 / efficiency; // eq. 6.20
		let qig = (qid * f) / (1 - loss); // eqs. 6.22–6.23
		if (capacity > 0 && qig > capacity) qig = capacity; // eq. 6.24
		if (all !== null) {
			// eqs. 6.27–6.29, charged with the demand (R7-I3).
			const available = dfac[m]! * all + accaloc;
			qig = Math.min(qig, available);
			accaloc = available - qig;
		}
		df.push(f);
		unit.push(din * f);
		crop.push(totalCropDemand(module.crops, module.panMm[m]!, m));
		pel.push(module.panMm[m]! * module.panFactors[m]!); // L.009 for type 4 (TT 691 p.171)
		gross.push(qig);
	}
	const twelve = (v: number) => new Array<number>(12).fill(v);
	return { rainMm: [...rain], unit, df, crop, pel, area: twelve(area), target: twelve(area), efficiency: twelve(efficiency), returnFactor: twelve(returnFactor), gross };
}
