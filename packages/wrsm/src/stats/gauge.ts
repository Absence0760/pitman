/**
 * Simulated against observed flow at a gauge (docs/theory/statistics.md).
 *
 * A gauge is a route with an observed-flow file (.NET L.009–L.011, TT 691
 * §12.6). WRSM2000's statistics screen sets the period to the gauge's
 * period of record when the route has one, and shows the statistics of the
 * flows "observed in this period" beside the simulated ones (TT 689
 * §6.1.18 p.60). The manuals do not say how missing or incomplete observed
 * months are treated, so:
 *
 * - A negative observed value is **missing** (docs/formats.md §11.4, U-16)
 *   and that month is never compared.
 * - A month flagged `+` is **incomplete** (TT 689 §2.3.4 p.8 "patching
 *   codes"; docs/formats.md §11.4). It is kept by default and can be left
 *   out (R3-S1).
 * - The annual statistics need whole hydrological years, so a year enters
 *   them only when all 12 of its months are usable; the simulated
 *   statistics use **the same years**, so like is compared with like (R3-S1).
 */

import type { HydroYear, Monthly12, MonthlyRow, MonthlySeries, ObservedFlow } from '../types.js';
import { flowStatistics, type FlowStatistics, type FlowStatisticsOptions } from './flow.js';

export interface PairingOptions {
	/** Use months flagged `+` (incomplete). Default true (R3-S1). */
	readonly includeIncomplete?: boolean;
	/** Limit to hydrological years from `startYear` to `endYear` (inclusive). */
	readonly startYear?: HydroYear;
	readonly endYear?: HydroYear;
}

/** One month with both a simulated and a usable observed value, million m³. */
export interface PairedMonth {
	readonly year: HydroYear;
	/** 0 = October. */
	readonly month: number;
	readonly simulated: number;
	readonly observed: number;
	/** The observed value carried a `+`. */
	readonly incomplete: boolean;
}

export interface GaugePairing {
	/** Every usable month, in time order. */
	readonly months: readonly PairedMonth[];
	/** Years whose 12 months are all usable: the years the annual statistics use. */
	readonly completeYears: readonly HydroYear[];
	readonly simulatedYears: readonly MonthlyRow[];
	readonly observedYears: readonly MonthlyRow[];
	/** First and last observed year inside the simulation and the period; `null` when none. */
	readonly period: { readonly startYear: HydroYear; readonly endYear: HydroYear } | null;
	/** Months left out, by reason. */
	readonly dropped: {
		readonly missing: number;
		readonly incomplete: number;
		/** Observed months outside the simulated record or the chosen period. */
		readonly outside: number;
	};
}

/** Pair a simulated route series with the gauge's observed flows. */
export function pairAtGauge(simulated: MonthlySeries, observed: ObservedFlow, options: PairingOptions = {}): GaugePairing {
	const includeIncomplete = options.includeIncomplete ?? true;
	const simYears = simulated.values.length / 12;
	const simEnd = simulated.startYear + simYears - 1;
	const months: PairedMonth[] = [];
	const completeYears: HydroYear[] = [];
	const simulatedYears: MonthlyRow[] = [];
	const observedYears: MonthlyRow[] = [];
	let missing = 0;
	let incomplete = 0;
	let outside = 0;
	let first: HydroYear | null = null;
	let last: HydroYear | null = null;

	for (const row of observed.rows) {
		const inside =
			row.year >= simulated.startYear &&
			row.year <= simEnd &&
			(options.startYear === undefined || row.year >= options.startYear) &&
			(options.endYear === undefined || row.year <= options.endYear);
		if (!inside) {
			outside += 12;
			continue;
		}
		first ??= row.year;
		last = row.year;
		const offset = 12 * (row.year - simulated.startYear);
		const sim = simulated.values.slice(offset, offset + 12) as unknown as Monthly12;
		let usable = 0;
		row.months.forEach((value, k) => {
			const flagged = row.incomplete[k] === true;
			if (!(value >= 0)) missing++;
			else if (flagged && !includeIncomplete) incomplete++;
			else {
				usable++;
				months.push({ year: row.year, month: k, simulated: sim[k] as number, observed: value, incomplete: flagged });
			}
		});
		if (usable === 12) {
			completeYears.push(row.year);
			simulatedYears.push({ year: row.year, months: sim });
			observedYears.push({ year: row.year, months: row.months });
		}
	}
	return {
		months,
		completeYears,
		simulatedYears,
		observedYears,
		period: first === null || last === null ? null : { startYear: first, endYear: last },
		dropped: { missing, incomplete, outside }
	};
}

/**
 * The observed flows laid on a route's months: `values[12 * i + m]` is
 * month m of year `startYear + i`, `null` where the file has no row or the
 * value is missing (negative).
 */
export function observedOnSeries(
	observed: ObservedFlow,
	startYear: HydroYear,
	years: number
): { readonly values: readonly (number | null)[]; readonly incomplete: readonly boolean[] } {
	const values = new Array<number | null>(12 * years).fill(null);
	const incomplete = new Array<boolean>(12 * years).fill(false);
	for (const row of observed.rows) {
		const i = row.year - startYear;
		if (i < 0 || i >= years) continue;
		row.months.forEach((v, k) => {
			values[12 * i + k] = v >= 0 ? v : null;
			incomplete[12 * i + k] = v >= 0 && row.incomplete[k] === true;
		});
	}
	return { values, incomplete };
}

/** The keys of the WR2012 statistics, in the order WRSM2000 lists them (TT 689 pp.61–62). */
export const WR2012_STATISTICS = ['marMm3', 'meanLog', 'sdMm3', 'logSd', 'seasonalIndex'] as const;
export type Wr2012Statistic = (typeof WR2012_STATISTICS)[number];

/**
 * The calibration guidelines of TT 689 §10.1 p.177, largest acceptable
 * |error| in %: MAR and mean (log) < 4 %, standard deviations (natural and
 * log) < 6 %, seasonal index < 8 %. The manual calls them guidelines, not
 * firm criteria.
 */
export const WR2012_FIT_GUIDELINES: Readonly<Record<Wr2012Statistic, number>> = {
	marMm3: 4,
	meanLog: 4,
	sdMm3: 6,
	logSd: 6,
	seasonalIndex: 8
};

/** (simulated − observed) / |observed| × 100; `null` when either is missing or observed is 0 (R3-S8). */
export function percentError(simulated: number | null, observed: number | null): number | null {
	if (simulated === null || observed === null || observed === 0) return null;
	return ((simulated - observed) / Math.abs(observed)) * 100;
}

export interface StatisticComparison {
	readonly statistic: Wr2012Statistic;
	readonly simulated: number | null;
	readonly observed: number | null;
	readonly errorPercent: number | null;
	/** TT 689 p.177 guideline, %. */
	readonly guidelinePercent: number;
	/** |error| below the guideline; `null` when there is no error to judge. */
	readonly withinGuideline: boolean | null;
}

export interface GaugeStatistics {
	readonly pairing: GaugePairing;
	readonly simulated: FlowStatistics | null;
	readonly observed: FlowStatistics | null;
	readonly comparison: readonly StatisticComparison[];
}

/** The five statistics of simulated and observed flows over the gauge's complete years, with the % errors. */
export function gaugeStatistics(
	simulated: MonthlySeries,
	observed: ObservedFlow,
	options: PairingOptions & FlowStatisticsOptions = {}
): GaugeStatistics {
	const pairing = pairAtGauge(simulated, observed, options);
	const sim = flowStatistics(pairing.simulatedYears, options);
	const obs = flowStatistics(pairing.observedYears, options);
	const comparison = WR2012_STATISTICS.map((statistic): StatisticComparison => {
		const s = sim?.[statistic] ?? null;
		const o = obs?.[statistic] ?? null;
		const errorPercent = percentError(s, o);
		const guidelinePercent = WR2012_FIT_GUIDELINES[statistic];
		return {
			statistic,
			simulated: s,
			observed: o,
			errorPercent,
			guidelinePercent,
			withinGuideline: errorPercent === null ? null : Math.abs(errorPercent) < guidelinePercent
		};
	});
	return { pairing, simulated: sim, observed: obs, comparison };
}
