/**
 * A synthetic `ChirpsMonthly` (the `POST /api/chirps/monthly` response) for
 * tests, the extension screen and the e2e test (issue #3 rule 2: no real data).
 * Seeded, so the same options always give the same series.
 */

import { seededRandom } from '../synthetic/synthetic.js';
import type { ChirpsMonth, ChirpsMonthly } from './contract.js';

export interface SyntheticChirpsOptions {
	/** PRNG seed. Default 1. */
	readonly seed?: number;
	/** First calendar month, `YYYY-MM`. Default `1981-01` (CHIRPS's start). */
	readonly from?: string;
	/** The copy's last final day, `YYYY-MM-DD`; the series runs to its month. Default `2026-09-30`. */
	readonly finalThrough?: string;
	/** Long-term mean annual total, mm. Default 450. */
	readonly mapMm?: number;
	/** Calendar months to report missing (`null`), as `YYYY-MM`. */
	readonly missing?: readonly string[];
	/** Share of the weight removed as sea / no-data cells, %. Default 0. */
	readonly weightRemovedPct?: number;
	/** Cells used. Default 41. */
	readonly cells?: number;
	/** Area, km². Default 812.4. */
	readonly areaKm2?: number;
	readonly source?: ChirpsMonthly['source'];
	readonly revision?: number;
}

/**
 * Share of the annual total per calendar month, %, January first: a
 * summer-rainfall pattern like the synthetic network's (dry June to August,
 * July almost dry). Sums to 100.
 */
const CALENDAR_SEASON = [16, 15, 12, 8, 5, 3, 1, 2, 5, 8, 11, 14] as const;

function parseMonth(text: string, what: string): { year: number; month: number } {
	const m = /^(\d{4})-(\d{2})/.exec(text);
	if (m === null) throw new RangeError(`${what} '${text}' is not YYYY-MM`);
	const month = Number(m[2]);
	if (month < 1 || month > 12) throw new RangeError(`${what} '${text}' has no month ${month}`);
	return { year: Number(m[1]), month };
}

/**
 * A full-record monthly series: each month is the season's share of
 * `mapMm`, scaled by a wet/dry-year factor and monthly noise, rounded to
 * 0.1 mm as an area mean of daily values would be reported.
 */
export function syntheticChirpsMonthly(options: SyntheticChirpsOptions = {}): ChirpsMonthly {
	const { seed = 1, from = '1981-01', finalThrough = '2026-09-30', mapMm = 450, missing = [] } = options;
	const start = parseMonth(from, 'from');
	const end = parseMonth(finalThrough, 'finalThrough');
	const random = seededRandom(seed);
	const gaps = new Set(missing);
	const months: ChirpsMonth[] = [];
	let yearFactor = 1;
	for (let year = start.year, month = start.month; year < end.year || (year === end.year && month <= end.month); ) {
		if (month === 10 || months.length === 0) yearFactor = 0.6 + 0.8 * random();
		const noise = 0.3 + 1.4 * random();
		const key = `${year}-${String(month).padStart(2, '0')}`;
		const mm = Math.round(((CALENDAR_SEASON[month - 1] as number) / 100) * mapMm * yearFactor * noise * 10) / 10;
		months.push({ year, month, mm: gaps.has(key) ? null : mm });
		month++;
		if (month > 12) {
			month = 1;
			year++;
		}
	}
	return {
		months,
		cells: options.cells ?? 41,
		weightRemovedPct: options.weightRemovedPct ?? 0,
		areaKm2: options.areaKm2 ?? 812.4,
		product: 'CHIRPS v3 rnl (final)',
		revision: options.revision ?? 1,
		finalThrough,
		source: options.source ?? 'local'
	};
}
