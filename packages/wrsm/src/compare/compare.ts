/**
 * Comparison of a simulated monthly series against a reference one, the
 * metrics issue #3 judges the rebuild by (Round 2: |MAR diff| ≤ 1 % and
 * NSE ≥ 0.99, see `expectations.ts`).
 *
 * Only whole hydrological years present in both series are compared; MAR
 * is the mean of their annual totals (the sum of the twelve months, not the
 * .ANS column-14 figure, which carries its own rounding). Flows are million
 * m³ per month, so MAR is million m³/a.
 */

import type { AnswerFile, HydroYear, MonthlySeries, SeriesUnit } from '../types.js';

/** A month of the record: hydrological year and month (0 = October). */
export interface YearMonth {
	readonly year: HydroYear;
	readonly month: number;
}

/** Options for `compareSeries`. */
export interface CompareOptions {
	/**
	 * A month diverges when |simulated − reference| exceeds this, in the
	 * series' unit. Default 0.01: one unit in the last place .ANS files write
	 * (two decimals), so rounding alone never counts as divergence.
	 */
	readonly tolerance?: number;
}

/** The default divergence tolerance (see `CompareOptions.tolerance`). */
export const DEFAULT_TOLERANCE = 0.01;

/**
 * Slack for binary floating point in the tolerance test, so a written
 * difference of exactly 0.01 (0.0100000000002 after subtraction) is not
 * reported as divergence.
 */
const FLOAT_SLACK = 1e-9;

/** The result of comparing two series over their common years. */
export interface SeriesComparison {
	/** Common whole hydrological years, inclusive. */
	readonly overlap: { readonly startYear: HydroYear; readonly endYear: HydroYear };
	/** Mean annual total of the simulated series over the overlap, million m³/a. */
	readonly marSimulated: number;
	/** Mean annual total of the reference series over the overlap, million m³/a. */
	readonly marReference: number;
	/**
	 * (simulated − reference) / reference × 100, %. `null` when the reference
	 * MAR is 0 and the simulated one is not (0 when both are 0).
	 */
	readonly marPctDiff: number | null;
	/**
	 * Nash–Sutcliffe efficiency of the monthly values, 1 − Σ(s − r)² / Σ(r − r̄)².
	 * `null` when the reference has zero variance (NSE is undefined).
	 */
	readonly nse: number | null;
	/** Largest |simulated − reference| over the overlap, in the series' unit. */
	readonly maxAbsDiff: number;
	/** The first month at which `maxAbsDiff` occurs. */
	readonly maxAbsDiffAt: YearMonth;
	/** The first month with |simulated − reference| > tolerance; `null` when none. */
	readonly firstDivergingMonth: YearMonth | null;
}

/**
 * `types.ts` has both 'Mm3' ("per month for flows") and 'Mm3PerMonth' for
 * a monthly flow volume; they are the same quantity here.
 */
function unitClass(unit: SeriesUnit): string {
	return unit === 'Mm3PerMonth' ? 'Mm3' : unit;
}

/** Number of whole years in a series. */
function yearCount(series: MonthlySeries): number {
	return Math.floor(series.values.length / 12);
}

/**
 * Compare `simulated` against `reference` over their common whole years.
 * Returns `null` when the two have no year in common. Throws when the units
 * differ.
 */
export function compareSeries(
	simulated: MonthlySeries,
	reference: MonthlySeries,
	options: CompareOptions = {}
): SeriesComparison | null {
	if (unitClass(simulated.unit) !== unitClass(reference.unit)) {
		throw new Error(`cannot compare a series in ${simulated.unit} with one in ${reference.unit}`);
	}
	const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
	const startYear = Math.max(simulated.startYear, reference.startYear);
	const endYear = Math.min(simulated.startYear + yearCount(simulated), reference.startYear + yearCount(reference)) - 1;
	if (endYear < startYear) return null;

	const years = endYear - startYear + 1;
	const simOffset = 12 * (startYear - simulated.startYear);
	const refOffset = 12 * (startYear - reference.startYear);
	const n = 12 * years;

	let simTotal = 0;
	let refTotal = 0;
	for (let i = 0; i < n; i++) {
		simTotal += simulated.values[simOffset + i]!;
		refTotal += reference.values[refOffset + i]!;
	}
	const refMean = refTotal / n;

	let sse = 0;
	let variance = 0;
	let maxAbsDiff = -1;
	let maxAt = 0;
	let firstDiverging = -1;
	for (let i = 0; i < n; i++) {
		const s = simulated.values[simOffset + i]!;
		const r = reference.values[refOffset + i]!;
		const diff = Math.abs(s - r);
		sse += (s - r) ** 2;
		variance += (r - refMean) ** 2;
		if (diff > maxAbsDiff) {
			maxAbsDiff = diff;
			maxAt = i;
		}
		if (firstDiverging < 0 && diff > tolerance + FLOAT_SLACK) firstDiverging = i;
	}

	const marSimulated = simTotal / years;
	const marReference = refTotal / years;
	const at = (i: number): YearMonth => ({ year: startYear + Math.floor(i / 12), month: i % 12 });
	return {
		overlap: { startYear, endYear },
		marSimulated,
		marReference,
		marPctDiff:
			marReference !== 0 ? ((marSimulated - marReference) / marReference) * 100 : marSimulated === 0 ? 0 : null,
		nse: variance > 0 ? 1 - sse / variance : null,
		maxAbsDiff,
		maxAbsDiffAt: at(maxAt),
		firstDivergingMonth: firstDiverging >= 0 ? at(firstDiverging) : null
	};
}

/**
 * The monthly values of an answer file as a series (million m³). Throws
 * when its years are not consecutive: WRSM2000 writes one row per simulated
 * year, so a gap means a damaged file.
 */
export function answerToSeries(file: AnswerFile): MonthlySeries {
	const first = file.rows[0];
	const values: number[] = [];
	file.rows.forEach((row, i) => {
		if (row.year !== first!.year + i) {
			throw new Error(`${file.kind}${file.number}: year ${row.year} follows ${file.rows[i - 1]!.year}`);
		}
		values.push(...row.months);
	});
	return { startYear: first?.year ?? 0, values, unit: 'Mm3PerMonth' };
}

/** Compare two answer files (`compareSeries` on their monthly values). */
export function compareAnswers(
	simulated: AnswerFile,
	reference: AnswerFile,
	options: CompareOptions = {}
): SeriesComparison | null {
	return compareSeries(answerToSeries(simulated), answerToSeries(reference), options);
}
