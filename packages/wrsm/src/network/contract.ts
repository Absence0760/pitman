/**
 * Round 3 contract between the network runner (`src/network/`) and the
 * module simulators (`src/reservoir/`, `src/channel/`). Written by the
 * orchestrator before the round so the agents can build against it in
 * parallel; signatures change here first, by the orchestrator.
 *
 * Modules are solved **one at a time over the whole record, in `.NET`
 * order** (decision R3-1, provisional): TT 689 §6.1.16 describes a
 * "sequence error" when "a particular module expects inflows from an
 * upstream module but that upstream module has not yet been solved", so by
 * the time a module is solved, every route flowing into it is a complete
 * series.
 */

import type {
	ChannelModule,
	DemandSeries,
	HydroYear,
	MonthlyRow,
	MonthlySeries,
	RainfallSeries,
	ReservoirModule,
	RunMessage,
	RunMode
} from '../types.js';

/** What every module simulator is told about the run. */
export interface ModuleRunContext {
	readonly mode: RunMode;
	/** First and last hydrological year simulated (`.NET` L.012). Every series covers exactly these years. */
	readonly startYear: HydroYear;
	readonly endYear: HydroYear;
	/** A `.RAN` file by the name a module file gives (case-insensitive); `undefined` when the bundle lacks it. */
	rainfall(fileName: string): RainfallSeries | undefined;
	/** A demand or defined-flow file by name (case-insensitive); `undefined` when the bundle lacks it. */
	flowFile(fileName: string): DemandSeries | undefined;
}

/**
 * Monthly flow per route, million m³/month (unit `'Mm3'`), keyed by route
 * number, each covering `startYear`–`endYear` (12 values per year).
 */
export type RouteFlows = Readonly<Record<number, MonthlySeries>>;

/** What a module simulator returns. */
export interface ModuleRunResult {
	/**
	 * Flow on every outflow route the module controls (spill, principal
	 * outflow, drafts, diversions, ...), keyed by route number. A route the
	 * module names but sends nothing down is present with zeros.
	 */
	readonly outflows: RouteFlows;
	/** End-of-month storage, million m³ (reservoir storage; wetland storage for a channel reach). */
	readonly storage?: MonthlySeries;
	readonly messages: readonly RunMessage[];
}

/**
 * Simulates one reservoir module (TT 690 ch.2). `inflows` holds the
 * simulated flow on each of the module's inflow routes that has an upstream
 * module; a route with a defined-flow file is read from `ctx.flowFile` by
 * the simulator. Mode handling (D1) is the simulator's: natural mode removes
 * the dam (inflow passes to the spill route, drafts are zero).
 *
 * `demands` is the route's "demand stream" (TT 689 p.84): what each irrigation
 * module drawing on this one asks of its abstraction route, keyed by route
 * number. The simulator supplies what it can and the route's flow is the
 * "supply stream"; the runner hands that back to the irrigation module (R7-I2).
 */
export type ReservoirSimulator = (module: ReservoirModule, inflows: RouteFlows, ctx: ModuleRunContext, demands?: RouteFlows) => ModuleRunResult;

/** Simulates one channel reach (TT 689 / TT 691 §12.2, TT 690 ch.9–10). Same conventions as `ReservoirSimulator`. */
export type ChannelSimulator = (module: ChannelModule, inflows: RouteFlows, ctx: ModuleRunContext, demands?: RouteFlows) => ModuleRunResult;

/** The simulators the network runner calls, injected so each can be tested and replaced on its own. */
export interface ModuleSimulators {
	readonly reservoir: ReservoirSimulator;
	readonly channel: ChannelSimulator;
}

/**
 * A month's supply failure above this is "major", at or below it "minor",
 * million m³ (TT 691 p.80 for reservoirs, §7.7.1 pp.86–87 CRFAIL for channel
 * reaches; R3-RV10, OQ-CR14). Shared by the reservoir and channel simulators.
 */
export const MAJOR_FAILURE_MM3 = 0.009;

/** Number of months in `startYear`–`endYear`. */
export function monthCount(startYear: HydroYear, endYear: HydroYear): number {
	return 12 * (endYear - startYear + 1);
}

/** A series of zeros over the run. */
export function zeroSeries(startYear: HydroYear, endYear: HydroYear): MonthlySeries {
	return { startYear, values: new Array<number>(monthCount(startYear, endYear)).fill(0), unit: 'Mm3' };
}

/**
 * A defined-flow or demand file as a series over the run, per mode (D1).
 *
 * - `historical`: each simulated year takes the file's row for that year.
 *   A year the file lacks is an error (no manual rule for filling it).
 * - `presentDay`: every year takes the row for `mode.year`; when the file
 *   has no such row, the nearest year it has (its last row for a later
 *   year, its first for an earlier one), reported as an info message.
 * - `natural`: zeros. A defined flow is development (an abstraction or a
 *   transfer), so natural mode removes it; a caller that treats a defined
 *   inflow as natural reads the file in `historical` mode instead.
 *
 * Throws an `Error` naming the file and the missing year.
 */
export function definedFlowSeries(
	file: DemandSeries,
	mode: RunMode,
	startYear: HydroYear,
	endYear: HydroYear
): { readonly series: MonthlySeries; readonly messages: readonly RunMessage[] } {
	if (mode.kind === 'natural') return { series: zeroSeries(startYear, endYear), messages: [] };
	if (file.rows.length === 0) throw new Error(`${file.fileName}: no rows`);
	const byYear = new Map<number, MonthlyRow>(file.rows.map((row) => [row.year, row]));
	const messages: RunMessage[] = [];
	let fixed: MonthlyRow | undefined;
	if (mode.kind === 'presentDay') {
		fixed = byYear.get(mode.year);
		if (!fixed) {
			const first = file.rows[0]!;
			const last = file.rows[file.rows.length - 1]!;
			fixed = mode.year > last.year ? last : first;
			messages.push({ level: 'info', text: `${file.fileName}: no ${mode.year} row; present day uses ${fixed.year}` });
		}
	}
	const values: number[] = [];
	for (let year = startYear; year <= endYear; year++) {
		const row = fixed ?? byYear.get(year);
		if (!row) throw new Error(`${file.fileName}: no row for ${year} (run is ${startYear}–${endYear})`);
		values.push(...row.months);
	}
	return { series: { startYear, values, unit: 'Mm3' }, messages };
}
