/**
 * Reservoir capacity by year and the area–storage curve (docs/theory/reservoir.md
 * §2.2 and §3.6; TT 690 p.10 eq. 2.3; TT 689 pp.91–92).
 */

import type { HydroYear, ReservoirCapacity, RunMessage, RunMode } from '../types.js';

/** Full supply volume and area for one hydrological year. */
export interface YearCapacity {
	/** CAP, full supply volume, million m³. */
	readonly capMm3: number;
	/** FSA, surface area at full supply, km². */
	readonly fsaKm2: number;
}

/**
 * R3-RV4: how a year between two capacity rows is filled. `linear`
 * (default) interpolates volume and area linearly in the year; `step` holds
 * the earlier row until the next one.
 */
export type CapacityBetweenRows = 'linear' | 'step';

/**
 * R3-RV5: a simulated year outside the capacity table in historical mode.
 * `error` (default, TT 689 p.91: the table must cover the simulation) or
 * `nearest` (hold the first or last row, with a warning).
 */
export type CapacityOutsideTable = 'error' | 'nearest';

/** A capacity-table problem, thrown with the module named by the caller. */
export class CapacityTableError extends Error {
	override readonly name = 'CapacityTableError';
}

/**
 * Checks a capacity table: at least one row, years strictly ascending,
 * volumes and areas finite and non-negative. Throws `CapacityTableError`.
 */
export function checkCapacityTable(table: readonly ReservoirCapacity[]): void {
	if (table.length === 0) throw new CapacityTableError('no capacity rows (L.003 NYR = 0)');
	table.forEach((row, k) => {
		if (!Number.isInteger(row.year)) throw new CapacityTableError(`capacity year ${row.year} is not a whole year`);
		if (k > 0 && row.year <= table[k - 1]!.year) {
			throw new CapacityTableError(`capacity years must ascend (L.004: ${table[k - 1]!.year} then ${row.year})`);
		}
		if (!Number.isFinite(row.fullSupplyVolumeMm3) || row.fullSupplyVolumeMm3 < 0) {
			throw new CapacityTableError(`negative or invalid full supply volume ${row.fullSupplyVolumeMm3} for ${row.year} (L.005)`);
		}
		if (!Number.isFinite(row.fullSupplyAreaKm2) || row.fullSupplyAreaKm2 < 0) {
			throw new CapacityTableError(`negative or invalid full supply area ${row.fullSupplyAreaKm2} for ${row.year} (L.006)`);
		}
	});
}

/**
 * Capacity in hydrological year `year` from the table (§3.6). `undefined`
 * when the year lies outside the table; the caller decides (R3-RV5).
 */
export function capacityInYear(table: readonly ReservoirCapacity[], year: HydroYear, between: CapacityBetweenRows): YearCapacity | undefined {
	const first = table[0];
	const last = table[table.length - 1];
	if (!first || !last || year < first.year || year > last.year) return undefined;
	for (let k = 0; k < table.length; k++) {
		const row = table[k]!;
		if (row.year === year) return { capMm3: row.fullSupplyVolumeMm3, fsaKm2: row.fullSupplyAreaKm2 };
		const next = table[k + 1];
		if (next && year > row.year && year < next.year) {
			if (between === 'step') return { capMm3: row.fullSupplyVolumeMm3, fsaKm2: row.fullSupplyAreaKm2 };
			const w = (year - row.year) / (next.year - row.year);
			return {
				capMm3: row.fullSupplyVolumeMm3 + w * (next.fullSupplyVolumeMm3 - row.fullSupplyVolumeMm3),
				fsaKm2: row.fullSupplyAreaKm2 + w * (next.fullSupplyAreaKm2 - row.fullSupplyAreaKm2)
			};
		}
	}
	return undefined;
}

/** The nearest end row of the table to `year`. */
function nearestRow(table: readonly ReservoirCapacity[], year: HydroYear): ReservoirCapacity {
	const first = table[0]!;
	const last = table[table.length - 1]!;
	return year < first.year ? first : last;
}

/**
 * Capacity for every simulated year, per run mode (D1, §5):
 * - historical: each year from the table (R3-RV4, R3-RV5);
 * - present day: every year holds the capacity of `mode.year`, or the
 *   nearest end row when the table doesn't reach it (an info message);
 * - natural: zero (the dam is removed).
 *
 * Throws `CapacityTableError` for a bad table or (R3-RV5 `error`) a year outside it.
 */
export function capacitySeries(
	table: readonly ReservoirCapacity[],
	mode: RunMode,
	startYear: HydroYear,
	endYear: HydroYear,
	options: { readonly between: CapacityBetweenRows; readonly outside: CapacityOutsideTable }
): { readonly years: readonly YearCapacity[]; readonly messages: readonly RunMessage[] } {
	const years: YearCapacity[] = [];
	const messages: RunMessage[] = [];
	if (mode.kind === 'natural') {
		for (let y = startYear; y <= endYear; y++) years.push({ capMm3: 0, fsaKm2: 0 });
		return { years, messages };
	}
	checkCapacityTable(table);
	if (mode.kind === 'presentDay') {
		let held = capacityInYear(table, mode.year, options.between);
		if (!held) {
			const row = nearestRow(table, mode.year);
			held = { capMm3: row.fullSupplyVolumeMm3, fsaKm2: row.fullSupplyAreaKm2 };
			messages.push({ level: 'info', text: `capacity table has no ${mode.year}; present day uses its ${row.year} row` });
		}
		for (let y = startYear; y <= endYear; y++) years.push(held);
		return { years, messages };
	}
	const outside: HydroYear[] = [];
	for (let y = startYear; y <= endYear; y++) {
		const c = capacityInYear(table, y, options.between);
		if (c) {
			years.push(c);
			continue;
		}
		if (options.outside === 'error') {
			throw new CapacityTableError(
				`capacity table (${table[0]!.year}–${table[table.length - 1]!.year}) does not cover ${y}; the first row must be in or before the first simulated year and the last in or after the last (TT 689 p.91)`
			);
		}
		const row = nearestRow(table, y);
		years.push({ capMm3: row.fullSupplyVolumeMm3, fsaKm2: row.fullSupplyAreaKm2 });
		outside.push(y);
	}
	if (outside.length > 0) {
		messages.push({
			level: 'warning',
			text: `capacity table does not cover ${outside.length} simulated year(s) (${outside[0]}…${outside[outside.length - 1]}); the nearest row is held`
		});
	}
	return { years, messages };
}

/**
 * Surface area for a storage, km² (TT 690 p.10 eq. 2.3): A = a·S^b with
 * a = FSA / CAP^b, so the curve passes through (CAP, FSA). Zero when the
 * reservoir doesn't exist (CAP = 0) or is empty.
 */
export function surfaceArea(storageMm3: number, capacity: YearCapacity, power: number): number {
	if (capacity.capMm3 <= 0 || storageMm3 <= 0) return 0;
	const a = capacity.fsaKm2 / capacity.capMm3 ** power;
	return a * storageMm3 ** power;
}
