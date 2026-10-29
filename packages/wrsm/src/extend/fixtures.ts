/**
 * extend.md § Worked example as test fixtures (synthetic, zone `ZZA`). Test
 * support only: not exported from the package.
 */

import type { Monthly12, RainfallSeries } from '../types.js';
import type { ChirpsMonth, ChirpsMonthly } from './contract.js';

const row = (year: number, months: number[]) => ({ year, months: months as unknown as Monthly12 });

/** The `.RAN` of the worked example, 1979–1984 (% of model MAP). */
export const WORKED_RAN: RainfallSeries = {
	code: 'ZZA',
	rows: [
		row(1979, [6.1, 9.4, 11.2, 13.5, 12.8, 10.6, 7.3, 5.2, 3.1, 0.4, 1.9, 4.2]),
		row(1980, [5.8, 8.7, 10.1, 14.9, 13.2, 11.3, 6.9, 4.8, 2.7, 0.1, 1.6, 3.9]),
		row(1981, [7.2, 10.3, 12.6, 15.1, 11.9, 9.8, 8.1, 5.6, 3.4, 0.3, 2.2, 4.6]),
		row(1982, [4.9, 7.6, 9.3, 11.8, 10.7, 8.9, 5.7, 4.1, 2.2, 0.2, 1.3, 3.1]),
		row(1983, [6.6, 9.9, 11.7, 14.2, 13.6, 10.9, 7.6, 5.3, 3.0, 0.1, 2.0, 4.4]),
		row(1984, [5.4, 8.2, 10.4, 12.7, 12.1, 10.2, 6.6, 4.7, 2.8, 0.3, 1.7, 3.6])
	]
};

/** CHIRPS monthly totals of the worked example by hydrological year, October first (mm; `null` missing). */
export const WORKED_CHIRPS_MM: Readonly<Record<number, readonly (number | null)[]>> = {
	1981: [38, 55, 70, 86, 66, 52, 44, 30, 17, 0, 12, 25],
	1982: [27, 41, 52, 66, 60, 49, 31, 22, 11, 0, 7, 17],
	1983: [36, 54, 66, 80, 76, 60, 41, 28, 15, 0, 11, 24],
	1984: [30, 45, 59, 72, 68, 57, 36, 25, 14, 0, 9, 20],
	1985: [33, 48, 61, 77, 71, 55, 38, 27, 16, 2, 10, 22],
	1986: [29, 44, 57, 70, null, 53, 35, 24, 13, 0, 8, 19],
	1987: [35, 50, 64]
};

/**
 * The worked example on the wire: January 1981 to December 1987. January to
 * September 1981 (the partial hydrological year 1980, A2) get `partialMm`,
 * which must not affect anything.
 */
export function workedChirps(partialMm = 999): ChirpsMonthly {
	const months: ChirpsMonth[] = [];
	for (let month = 1; month <= 9; month++) months.push({ year: 1981, month, mm: partialMm });
	for (const [y, values] of Object.entries(WORKED_CHIRPS_MM)) {
		values.forEach((mm, k) => {
			const year = Number(y);
			months.push(k <= 2 ? { year, month: k + 10, mm } : { year: year + 1, month: k - 2, mm });
		});
	}
	months.sort((a, b) => a.year - b.year || a.month - b.month);
	return {
		months,
		cells: 41,
		weightRemovedPct: 0,
		areaKm2: 812.4,
		product: 'CHIRPS v3 rnl (final)',
		revision: 17,
		finalThrough: '1987-12-31',
		source: 's3'
	};
}

/** The worked example's 12 factors (4 decimals, extend.md § Step 5). */
export const WORKED_FACTORS = [0.833, 0.8359, 0.8066, 0.8013, 0.81, 0.8267, 0.8341, 0.8495, 0.9056, 1, 0.8359, 0.8266] as const;

/** The worked example's appended 1985 row. */
export const WORKED_1985 = [6.07, 8.86, 10.87, 13.63, 12.7, 10.04, 7.0, 5.07, 3.2, 0.44, 1.85, 4.02] as const;
