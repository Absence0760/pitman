/**
 * Generating a demand file from its `DemandSpec` (docs/formats.md §12):
 * annual volume A_Y for each hydrological year Y, times each month's share,
 * October first. WRSM2000 has no growth parameter, so growth lives here and
 * the file only ever holds monthly volumes.
 *
 * Rows hold what the file will hold: each month goes through the writer's
 * own rounding (`F7.2` of the float32 value, §2), so a run of the working
 * copy equals a run of the saved zip, and the preview shows the file's
 * values, not values the file can't keep (R7-X1).
 */

import { formatF } from '../io/series.js';
import { yearTableValue } from '../runoff/pitman.js';
import type { DemandSeries, DemandSpec, HydroYear, Monthly12, MonthlyRow, Network, YearTable } from '../types.js';

/** §12: past this share of the year's volume, rounding to 0.01 million m³ a month matters. */
export const DEMAND_ROUNDING_LIMIT_PERCENT = 0.5;

/** The most the 12 shares may miss 100 by: what still shows as 100.00. */
export const DEMAND_SHARE_TOLERANCE = 0.005;

/** The growth table in year order. */
export function sortedGrowth(growth: YearTable): YearTable {
	return [...growth].sort((a, b) => a.year - b.year);
}

/**
 * The annual volume in hydrological year `year`, million m³: the growth table,
 * linear between its years and flat beyond them. `annualVolumeMm3` alone when
 * the table is empty.
 */
export function demandVolumeIn(spec: DemandSpec, year: HydroYear): number {
	return spec.growth.length === 0 ? spec.annualVolumeMm3 : yearTableValue(sortedGrowth(spec.growth), year);
}

/**
 * The years a file must hold: the run's (a defined flow must cover the
 * simulation period, TT 689 p.150), and on to the growth table's last year,
 * so a present-day run at that year finds its row even when the network stops
 * short of it (R3-2). A longer file is fine (§11.1).
 */
export function demandFileYears(spec: DemandSpec, network: Pick<Network, 'startYear' | 'endYear'>): { readonly firstYear: HydroYear; readonly lastYear: HydroYear } {
	return { firstYear: network.startYear, lastYear: Math.max(network.endYear, ...spec.growth.map((g) => g.year)) };
}

/**
 * One row per year, each month as the file will hold it. The shares are taken
 * relative to their own sum, so 12 × 8.3333 still gives the whole annual
 * volume. Throws `RangeError` when a month doesn't fit `F7.2`.
 */
export function generateDemandRows(spec: DemandSpec, firstYear: HydroYear, lastYear: HydroYear, fileName = 'demand'): MonthlyRow[] {
	const total = spec.monthlyDistributionPercent.reduce((a, b) => a + b, 0);
	if (!(total > 0)) throw new RangeError(`${fileName}: the monthly shares add up to ${total}`);
	const rows: MonthlyRow[] = [];
	for (let year = firstYear; year <= lastYear; year++) {
		const annual = demandVolumeIn(spec, year);
		const months = spec.monthlyDistributionPercent.map((share, k) =>
			Number(formatF((annual * share) / total, 7, 2, `${fileName} year ${year} month ${k + 1}`))
		) as unknown as Monthly12;
		rows.push({ year, months });
	}
	return rows;
}

/** The file for `spec` over the given years, in `4X,I4,12F8.2` (§11.3): no totals, no footer. */
export function generateDemandSeries(spec: DemandSpec, options: { readonly fileName: string; readonly firstYear: HydroYear; readonly lastYear: HydroYear }): DemandSeries {
	const { fileName, firstYear, lastYear } = options;
	return { fileName, rows: generateDemandRows(spec, firstYear, lastYear, fileName), hasTotals: false, hasAverage: false };
}

/** What rounding did to one year (§12: reported per year). */
export interface DemandYearCheck {
	readonly year: HydroYear;
	/** A_Y as the spec gives it, million m³. */
	readonly askedMm3: number;
	/** The sum of the file's 12 months, million m³. */
	readonly writtenMm3: number;
	/** Written − asked, as a % of asked; 0 when nothing was asked. */
	readonly differencePercent: number;
}

/** Asked against written, per row. */
export function demandYearChecks(spec: DemandSpec, rows: readonly MonthlyRow[]): DemandYearCheck[] {
	return rows.map((row) => {
		const askedMm3 = demandVolumeIn(spec, row.year);
		const writtenMm3 = row.months.reduce((a, b) => a + b, 0);
		return { year: row.year, askedMm3, writtenMm3, differencePercent: askedMm3 === 0 ? 0 : ((writtenMm3 - askedMm3) / askedMm3) * 100 };
	});
}

/** Whether `rows` are what `spec` generates: false once the file was changed outside Pitman. */
export function specGenerates(spec: DemandSpec, rows: readonly MonthlyRow[]): boolean {
	try {
		return rows.every((row) => generateDemandRows(spec, row.year, row.year)[0]?.months.every((v, k) => v === row.months[k]));
	} catch {
		return false;
	}
}

/**
 * Why a spec can't be generated, each in a few words; empty when it can. The
 * screen says these field by field first; this is the engine's own guard.
 */
export function demandSpecProblems(spec: DemandSpec): string[] {
	const problems: string[] = [];
	const shares = spec.monthlyDistributionPercent;
	if (shares.length !== 12) problems.push(`the monthly distribution has ${shares.length} values, not 12`);
	if (shares.some((v) => !Number.isFinite(v) || v < 0)) problems.push('a monthly share is negative or not a number');
	const sum = shares.reduce((a, b) => a + b, 0);
	if (Math.abs(sum - 100) >= DEMAND_SHARE_TOLERANCE) problems.push(`the monthly shares add up to ${sum.toFixed(2)} %, not 100 %`);
	if (!Number.isFinite(spec.annualVolumeMm3) || spec.annualVolumeMm3 < 0) problems.push('the annual volume is negative or not a number');
	if (spec.growth.some((g) => !Number.isFinite(g.value) || g.value < 0)) problems.push('a growth volume is negative or not a number');
	const years = spec.growth.map((g) => g.year);
	if (years.some((y) => !Number.isInteger(y))) problems.push('a growth year is not a whole year');
	if (new Set(years).size !== years.length) problems.push('a growth year is listed twice');
	const volumes = spec.growth.length === 0 ? [spec.annualVolumeMm3] : spec.growth.map((g) => g.value);
	if (!volumes.some((v) => v > 0)) problems.push('the demand is zero in every year');
	return problems;
}
