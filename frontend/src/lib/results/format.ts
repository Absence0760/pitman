/**
 * Labels and number formats for the results screen. Units follow the engine:
 * flows in million m³ per month, hydrological years October–September
 * (year Y = October Y to September Y + 1, docs/formats.md U-19).
 */

import type { HydroYear, RunMode } from '@pitman/wrsm';

/** Month names in hydrological-year order (index 0 = October). */
export const HYDRO_MONTHS = ['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'] as const;

export const FLOW_UNIT = 'million m³/month';
export const ANNUAL_FLOW_UNIT = 'million m³/year';
export const STORAGE_UNIT = 'million m³';

/** The name of a run mode as the screen shows it. */
export function runLabel(mode: RunMode): string {
	switch (mode.kind) {
		case 'presentDay':
			return `Present day (${mode.year})`;
		case 'natural':
			return 'Natural';
		case 'historical':
			return 'Historical';
	}
}

/** A short file-name-safe tag for a run mode. */
export function runSlug(mode: RunMode): string {
	return mode.kind === 'presentDay' ? `present-${mode.year}` : mode.kind;
}

/** `1990/91` for hydrological year 1990 (October 1990 to September 1991). */
export function hydroYearLabel(year: HydroYear): string {
	return `${year}/${String((year + 1) % 100).padStart(2, '0')}`;
}

/** The calendar year of month m (0 = October) of hydrological year `year`. */
export function calendarYear(year: HydroYear, month: number): number {
	return month < 3 ? year : year + 1;
}

/** `Oct 1990` for month 0 of hydrological year 1990, `Jan 1991` for month 3. */
export function monthLabel(year: HydroYear, month: number): string {
	return `${HYDRO_MONTHS[month]} ${calendarYear(year, month)}`;
}

/** A number with fixed decimals, or an em dash for no value. */
export function formatNumber(value: number | null | undefined, decimals = 2): string {
	if (value === null || value === undefined || !Number.isFinite(value)) return '—';
	const s = value.toFixed(decimals);
	// Avoid "-0.00".
	return /^-0\.?0*$/.test(s) ? s.slice(1) : s;
}
