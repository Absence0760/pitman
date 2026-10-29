/**
 * Paved (impervious) area outside the Pitman core (spec: docs/theory/alien.md
 * § Paved area).
 *
 * The core (`src/runoff/pitman.ts`) takes the impervious fraction AI per
 * month and computes impervious runoff AI·P before interception (TT 690 p.3
 * §1.5 and p.5 §1.9; OQ-17 … OQ-19). What the core can't know, because it
 * runs one module on its own, lives here:
 *
 * - the per-month AI in each run mode (D1; TT 689 p.27, p.142);
 * - a parent's AI when SFR children take part of its area month by month
 *   (TT 689 p.140 "Active area"), R6-P1;
 * - a child with paved data, which TT 689 p.140 forbids, R6-P2;
 * - the special-area check: afforestation + alien vegetation + paved area
 *   never more than the catchment (TT 689 pp.127, 128, 142; TT 691 p.63
 *   RU_SPECIAL_AREA), R6-P3.
 */

import type { HydroYear, RunMessage, RunMode, RunoffModule } from '../types.js';
import { yearTableValue } from '../runoff/pitman.js';

/**
 * R6-P1: how the paved fraction applies when a parent's active area is
 * smaller than its AREA. `conserveArea` (default): the paved km² stay
 * AI × AREA, so the fraction of the active area is AI × AREA / active.
 * `asFraction`: AI applies to whatever area runs.
 */
export type ActiveAreaPavedRule = 'conserveArea' | 'asFraction';

/** Paved fraction per month (12 per hydrological year, October first) and any messages. */
export interface PavedFractionSeries {
	readonly fraction: number[];
	readonly messages: RunMessage[];
}

/**
 * AI per month over `startYear` … `endYear`: 0 in natural mode (TT 689 p.27),
 * the table's value in `mode.year` in present-day mode (D1), the year's value
 * in historical mode (linear between listed years, flat beyond, OQ-17). A
 * child's paved data is ignored with a warning (R6-P2; TT 689 p.140 "A Child
 * catchment may not contain paved areas"). A value outside 0–1 is an error
 * and that month's fraction is clamped to 0–1.
 */
export function pavedFractionByMonth(module: RunoffModule, mode: RunMode, startYear: HydroYear, endYear: HydroYear, opts: { readonly isChild?: boolean } = {}): PavedFractionSeries {
	const ref = { type: 'RU', number: module.number } as const;
	const messages: RunMessage[] = [];
	const table = module.paved?.fraction ?? [];
	const off = mode.kind === 'natural' || table.length === 0 || opts.isChild === true;
	if (opts.isChild && table.length > 0) {
		messages.push({ level: 'warning', module: ref, text: `RU ${module.number}: an SFR child may not have paved areas (TT 689 p.140); its paved data is ignored, put it in the parent` });
	}
	const fraction: number[] = [];
	for (let y = startYear; y <= endYear; y++) {
		let ai = off ? 0 : yearTableValue(table, mode.kind === 'presentDay' ? mode.year : y);
		if (!(ai >= 0 && ai <= 1)) {
			messages.push({ level: 'error', module: ref, at: { year: y, month: 0 }, text: `RU ${module.number}: paved fraction ${ai} in ${y} is outside 0–1 (L.018)` });
			ai = Math.min(1, Math.max(0, Number.isFinite(ai) ? ai : 0));
		}
		for (let m = 0; m < 12; m++) fraction.push(ai);
	}
	return { fraction, messages };
}

/**
 * A parent's impervious fraction of its active area (R6-P1). TT 691 p.40
 * keeps paved data "as proportion of the catchment"; TT 689 p.140 shrinks the
 * parent's area by the active child areas each month. With `conserveArea`,
 * AI_active = min(1, AI × AREA / activeArea); a zero active area gives 0.
 */
export function activeAreaPavedFraction(ai: number, areaKm2: number, activeAreaKm2: number, rule: ActiveAreaPavedRule = 'conserveArea'): number {
	if (rule === 'asFraction') return ai;
	if (!(activeAreaKm2 > 0)) return 0;
	return Math.min(1, (ai * areaKm2) / activeAreaKm2);
}

/**
 * R6-P3: afforestation + alien vegetation + paved + SFR children's areas in
 * hydrological year `year`, km², against the module's AREA. TT 689 p.127:
 * "The total area covered by Afforestation, Alien Vegetation and Paved area
 * may also not exceed the total area of the catchment"; TT 691 p.63
 * RU_SPECIAL_AREA issues "an error message when the special area is greater
 * than the total catchment". `childAreasKm2` are the active areas of the
 * module's children that year (a parent; TT 689 p.140). In present-day mode
 * the tables are read at `mode.year`, whatever `year` says; natural mode has
 * nothing to check.
 */
export function specialAreaMessages(module: RunoffModule, year: HydroYear, childAreasKm2: readonly number[] = [], mode: RunMode = { kind: 'historical' }): RunMessage[] {
	// Natural mode has no special areas (TT 689 p.27); present day holds every table at mode.year (D1).
	if (mode.kind === 'natural') return [];
	if (mode.kind === 'presentDay') year = mode.year;
	const forest = yearTableValue(module.afforestation.areaKm2, year);
	const alien = module.alienVegetation ? yearTableValue(module.alienVegetation.areaKm2, year) : 0;
	const paved = module.paved ? yearTableValue(module.paved.fraction, year) * module.areaKm2 : 0;
	const children = childAreasKm2.reduce((a, b) => a + b, 0);
	const total = forest + alien + paved + children;
	if (total <= module.areaKm2 * (1 + 1e-9)) return [];
	return [{
		level: 'error',
		module: { type: 'RU', number: module.number },
		at: { year, month: 0 },
		text: `RU ${module.number}: special areas in ${year} (afforestation ${forest}, alien vegetation ${alien}, paved ${paved}, SFR children ${children} km²) add up to ${total} km², more than the module's ${module.areaKm2} km² (TT 689 p.127)`
	}];
}

/**
 * Per-year messages of one kind (`specialAreaMessages` run year by year)
 * collapsed to the first, with the count of the other years, so a module
 * over its area for the whole run gives one message, not one per year.
 */
export function collapseYears(messages: readonly RunMessage[]): RunMessage[] {
	if (messages.length <= 1) return [...messages];
	const [first] = messages;
	return [{ ...first!, text: `${first!.text}; also in ${messages.length - 1} more year(s)` }];
}
