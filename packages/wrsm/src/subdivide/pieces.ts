/**
 * What the calibration and the split share: finding the module a plan
 * splits, its sibling pieces when it is itself a piece, and the fields whose
 * values depend on a piece's area, so `calibrateMap` runs the modules
 * `applySplit` will write.
 */

import { lookupFile } from '../network/modules.js';
import type { HughesParameters, Module, NetworkBundle, RunoffModule, SamiParameters, Subdivision, YearTable } from '../types.js';
import { fileRound, largestRemainder } from './areas.js';
import type { SplitPlan } from './contract.js';

/** At most this many pieces per quaternary (B8). */
export const MAX_PIECES = 8;

/** A plan or a network the split refuses, in plain language. */
export class SubdivisionError extends Error {
	override readonly name = 'SubdivisionError';
}

export function findRunoff(modules: readonly Module[], number: number): RunoffModule | undefined {
	return modules.find((m): m is RunoffModule => m.kind === 'RU' && m.number === number);
}

/** The module a plan splits; refuses anything but a runoff module that isn't an SFR child. */
export function plannedModule(bundle: NetworkBundle, plan: SplitPlan): RunoffModule {
	const { module: ref } = plan;
	const module = ref.type === 'RU' ? findRunoff(bundle.modules, ref.number) : undefined;
	if (!module) throw new SubdivisionError(`${ref.type} ${ref.number} is not a runoff module of this network`);
	const parent = bundle.modules.find((m) => m.kind === 'RU' && (m.sfrChildren ?? []).includes(module.number));
	if (parent) throw new SubdivisionError(`RU ${module.number} is an SFR child of RU ${parent.number}: split the parent, its children go with it`);
	return module;
}

/** The sidecar's entry for the quaternary, by code. */
export function subdivisionOf(bundle: NetworkBundle, quaternary: string): Subdivision | undefined {
	const all = bundle.sidecar?.subdivisions;
	return all && Object.hasOwn(all, quaternary) ? all[quaternary] : undefined;
}

/** A piece of the quaternary that this plan doesn't split, and its starting MAP. */
export interface Sibling {
	readonly module: RunoffModule;
	readonly gridMapMm: number;
}

/**
 * The quaternary's other pieces when the plan splits a piece again: one
 * factor scales every piece (D2), so they calibrate with it (R5-E7).
 * Refuses a plan past the 8 pieces of B8, one for a module the quaternary's
 * existing entry doesn't hold, one for a module another quaternary holds
 * (which would dodge D2's one factor and B8), and a second grid.
 */
export function siblingsOf(bundle: NetworkBundle, plan: SplitPlan): Sibling[] {
	const entry = subdivisionOf(bundle, plan.quaternary);
	if (plan.pieces.length < 2) throw new SubdivisionError('a split needs at least two pieces');
	if (plan.pieces.some((p) => !(p.polygonKm2 > 0))) throw new SubdivisionError('every piece needs an area above zero');
	for (const [code, other] of Object.entries(bundle.sidecar?.subdivisions ?? {})) {
		if (code !== plan.quaternary && (other.module.number === plan.module.number || other.pieces.some((p) => p.number === plan.module.number))) {
			throw new SubdivisionError(`RU ${plan.module.number} belongs to ${code}, not ${plan.quaternary}: split it under ${code}`);
		}
	}
	const others = entry?.pieces.filter((p) => p.number !== plan.module.number) ?? [];
	if (entry && others.length === entry.pieces.length) {
		throw new SubdivisionError(`${plan.quaternary} is already sub-divided and RU ${plan.module.number} is not one of its pieces`);
	}
	if (entry && (entry.grid.dataset !== plan.grid.dataset || entry.grid.cellDeg !== plan.grid.cellDeg)) {
		throw new SubdivisionError(`${plan.quaternary} was sub-divided on ${entry.grid.dataset} at ${entry.grid.cellDeg}°: every piece of a quaternary uses one grid`);
	}
	const count = plan.pieces.length + others.length;
	if (count > MAX_PIECES) throw new SubdivisionError(`this would make ${count} pieces in ${plan.quaternary}; a quaternary takes at most ${MAX_PIECES}`);
	return others.map((p) => {
		const module = findRunoff(bundle.modules, p.number);
		if (!module) throw new SubdivisionError(`the sidecar lists RU ${p.number} as a piece of ${plan.quaternary}, but the network has no such module`);
		return { module, gridMapMm: p.gridMapMm };
	});
}

/** Sami L.033 v4 EVAREA is `F9.2`, L.033 v1 HGRAD `F10.8`, L.037 abstraction `F5.3`; Hughes L.027 and L.029 `F8.2`. */
const EVAREA_DECIMALS = 2;
const HGRAD_DECIMALS = 8;
const SAMI_ABSTRACTION_DECIMALS = 3;
const HUGHES_ABSTRACTION_DECIMALS = 2;

/** A year table's values shared out, year by year, each year's total kept. One table per share. */
export function splitYearTable(table: YearTable, shares: readonly number[], decimals: number): YearTable[] {
	const rows = table.map((row) => largestRemainder(row.value, shares, decimals));
	return shares.map((_, i) => table.map((row, r) => ({ year: row.year, value: rows[r]![i]! })));
}

/**
 * A Sami block per piece (B7, decision R5-E1). Extensive: the abstraction
 * volumes (L.037, Mm³/a; TT 691 §7.4 TGWAbst) and the groundwater evaporation
 * area (L.033 v4, km²; "EVAREA/AREA", TT 691 p.49). The regional outflow is
 * the one term whose depth depends on the area itself: OUT = T·HG·Δt·W/AREA
 * with W = 4·√AREA (TT 690 p.87 eq. 8.7, W reconstructed in OQ-S11), so
 * OUT ∝ HGRAD/√AREA and a piece keeps the catchment's depth when HGRAD is
 * scaled by √(A_i/A). Without that a split would change the natural run
 * (invariant 6). Everything else in the block is a depth, rate or ratio
 * (docs/theory/sami.md §2.1) and is copied.
 */
export function samiPieces(module: RunoffModule, areasKm2: readonly number[]): SamiParameters[] | undefined {
	const { sami } = module;
	if (!sami) return undefined;
	const evaporation = largestRemainder(sami.gwEvaporationArea, areasKm2, EVAREA_DECIMALS);
	const abstractions = splitYearTable(sami.abstractions, areasKm2, SAMI_ABSTRACTION_DECIMALS);
	return areasKm2.map((area, i) => ({
		...sami,
		gwEvaporationArea: evaporation[i]!,
		maxHydraulicGradient: fileRound(sami.maxHydraulicGradient * Math.sqrt(area / module.areaKm2), HGRAD_DECIMALS),
		abstractions: abstractions[i]!
	}));
}

/** A Hughes block per piece: only its annual abstractions are volumes. Copied otherwise (the engine doesn't run Hughes yet, R2-2). */
export function hughesPieces(module: RunoffModule, areasKm2: readonly number[]): HughesParameters[] | undefined {
	const { hughes } = module;
	if (!hughes) return undefined;
	const upper = largestRemainder(hughes.upperAbstraction.annual, areasKm2, HUGHES_ABSTRACTION_DECIMALS);
	const riparian = largestRemainder(hughes.riparianAbstraction.annual, areasKm2, HUGHES_ABSTRACTION_DECIMALS);
	return areasKm2.map((_, i) => ({
		...hughes,
		upperAbstraction: { ...hughes.upperAbstraction, annual: upper[i]! },
		riparianAbstraction: { ...hughes.riparianAbstraction, annual: riparian[i]! }
	}));
}

/** The rainfall file a module reads, or a refusal. */
export function rainfallOf(bundle: NetworkBundle, module: RunoffModule) {
	const series = lookupFile(bundle.rainfall, module.rainfallFile);
	if (!series || series.rows.length === 0) throw new SubdivisionError(`RU ${module.number}: rainfall file ${module.rainfallFile} is not in the network`);
	return series;
}
