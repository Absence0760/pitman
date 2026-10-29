/**
 * The steps of extending one `.RAN`, as plain functions the screen calls:
 * fit (with the D5 window), preview (the engine's own apply, not a copy of
 * it), and the window's choices. Each returns a result or a plain-language
 * error, so the component only holds state.
 */

import type { ChirpsMonthly, ExtensionFit, ExtensionProvenance, ExtensionResult, HydroYear, Monthly12, MonthlyRow, RainfallSeries } from '@pitman/wrsm';
import type { ExtensionEngine } from './engine.js';

export type Outcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

function failure(error: unknown): { ok: false; error: string } {
	const message = error instanceof Error ? error.message : String(error);
	return { ok: false, error: message || 'The extension method failed without saying why.' };
}

export interface YearRange {
	readonly startYear: HydroYear;
	readonly endYear: HydroYear;
}

/** Fit CHIRPS to the file, over `window` when the user narrowed the overlap (D5). */
export function fitExtension(engine: ExtensionEngine, ran: RainfallSeries, chirps: ChirpsMonthly, window?: YearRange): Outcome<ExtensionFit> {
	try {
		return { ok: true, value: engine.fit(ran, chirps, window === undefined ? {} : { overlap: window }) };
	} catch (error) {
		return failure(error);
	}
}

/** Years the window's ends can take: the whole overlap's years. */
export function windowYears(whole: YearRange): HydroYear[] {
	const years: HydroYear[] = [];
	for (let y = whole.startYear; y <= whole.endYear; y++) years.push(y);
	return years;
}

/** Check a window against the whole overlap; `undefined` when it is the whole overlap (the default). */
export function checkWindow(start: HydroYear, end: HydroYear, whole: YearRange): Outcome<YearRange | undefined> {
	if (!Number.isInteger(start) || !Number.isInteger(end)) return { ok: false, error: 'Choose the first and last years of the overlap.' };
	if (start > end) return { ok: false, error: 'The first year must not be after the last year.' };
	if (start < whole.startYear || end > whole.endYear) return { ok: false, error: 'The window must lie inside the overlap.' };
	if (start === whole.startYear && end === whole.endYear) return { ok: true, value: undefined };
	return { ok: true, value: { startYear: start, endYear: end } };
}

export interface Preview {
	readonly result: ExtensionResult;
	/** The rows the apply adds, after the original record. */
	readonly appended: readonly MonthlyRow[];
}

/** What the apply would produce, from the engine itself. */
export function previewExtension(
	engine: ExtensionEngine,
	ran: RainfallSeries,
	chirps: ChirpsMonthly,
	fit: ExtensionFit,
	factors: Monthly12,
	provenance: ExtensionProvenance
): Outcome<Preview> {
	try {
		const result = engine.apply(ran, chirps, fit, factors, provenance);
		const last = ran.rows[ran.rows.length - 1]?.year ?? -Infinity;
		return { ok: true, value: { result, appended: result.series.rows.filter((r) => r.year > last) } };
	} catch (error) {
		return failure(error);
	}
}

/** A row's annual total, % of MAP. */
export function rowTotal(row: MonthlyRow): number {
	return row.months.reduce((s, v) => s + v, 0);
}

/** The CHIRPS record's last hydrological year when it is partial: how many of its months the copy holds (it is never appended). */
export function partialYear(chirps: ChirpsMonthly): { readonly year: HydroYear; readonly months: number } | null {
	const last = chirps.months[chirps.months.length - 1];
	if (last === undefined) return null;
	const year = last.month >= 10 ? last.year : last.year - 1;
	const months = last.month >= 10 ? last.month - 9 : last.month + 3;
	return months === 12 ? null : { year, months };
}

/** CHIRPS months missing inside the overlap (each drops that year from its month's factor only, extend.md § Edge cases). */
export function missingInOverlap(fit: ExtensionFit): { readonly year: HydroYear; readonly month: number }[] {
	const missing: { year: HydroYear; month: number }[] = [];
	for (const y of fit.chirpsPct) {
		if (y.year < fit.overlap.startYear || y.year > fit.overlap.endYear) continue;
		y.months.forEach((v, month) => {
			if (v === null) missing.push({ year: y.year, month });
		});
	}
	return missing;
}
