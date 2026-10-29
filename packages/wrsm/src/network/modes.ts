/**
 * Run modes for runoff modules (decision D1; docs/theory/network.md §7).
 *
 * - historical: the module as its file gives it.
 * - presentDay(year): every development year table held at its value in
 *   `year` for the whole record, as TT 689 p.138 does by hand ("change the
 *   areas ... so that the start year and end year are for the current
 *   area").
 * - natural: the man-made data removed, as WRSM2000's "Simulate Naturalised
 *   outflows" box does: "the module will ignore all man-made module data such
 *   as Paved areas, Afforestation and Alien Vegetation" (TT 689 p.27), and
 *   with it the SFR children's effect (TT 689 p.13). Groundwater
 *   abstractions go too (D1: "no ... abstractions"; R3-N9).
 *
 * Reservoirs and channels apply the mode inside their simulators
 * (`ModuleRunContext.mode`); defined flows through `definedFlowSeries`.
 */

import { yearTableValue } from '../runoff/pitman.js';
import type { HydroYear, RunMode, RunoffModule, YearTable } from '../types.js';

/** A year table held at its value in `year` (one entry, so it is flat over every year; OQ-17 interpolation). An empty table stays empty. */
export function holdYearTable(table: YearTable, year: HydroYear): YearTable {
	return table.length === 0 ? table : [{ year, value: yearTableValue(table, year) }];
}

/**
 * The runoff module as the run mode sees it. Pure: returns a new object
 * (or the same one in historical mode) and never changes `module`.
 *
 * The result is for running only, not for writing back: in present-day
 * mode a held table has one year, in natural mode the land-use tables are
 * empty while their species and optimal-area lines stay.
 *
 * Held or removed: afforestation areas (L.006–L.008), alien vegetation
 * areas (L.011–L.013), paved fraction (L.016–L.018), Sami groundwater
 * abstractions (L.036–L.037). Natural mode also zeroes the Hughes annual
 * abstractions (L.027, L.029), which are constants and so need no holding.
 */
export function applyRunMode(module: RunoffModule, mode: RunMode): RunoffModule {
	if (mode.kind === 'historical') return module;
	const table = mode.kind === 'natural' ? (): YearTable => [] : (t: YearTable): YearTable => holdYearTable(t, mode.year);
	const next: { -readonly [K in keyof RunoffModule]: RunoffModule[K] } = {
		...module,
		afforestation: { ...module.afforestation, areaKm2: table(module.afforestation.areaKm2) }
	};
	if (module.alienVegetation) next.alienVegetation = { ...module.alienVegetation, areaKm2: table(module.alienVegetation.areaKm2) };
	if (module.paved) next.paved = { fraction: table(module.paved.fraction) };
	if (module.sami) next.sami = { ...module.sami, abstractions: table(module.sami.abstractions) };
	if (module.hughes && mode.kind === 'natural') {
		next.hughes = {
			...module.hughes,
			upperAbstraction: { ...module.hughes.upperAbstraction, annual: 0 },
			riparianAbstraction: { ...module.hughes.riparianAbstraction, annual: 0 }
		};
	}
	return next;
}
