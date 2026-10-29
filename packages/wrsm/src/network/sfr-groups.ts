/**
 * SFR parent/child groups in the network run (TT 689 p.135: "When a Parent
 * Module is run, it first instructs all of its Child Modules to run their
 * simulation. The position of the Child Module in the Network is therefore
 * immaterial"; p.140). The group itself is `runSfrGroup` (`landuse/sfr.ts`,
 * agent 6.3); this file gives it the runoff model and turns its result into
 * route flows and diagnostics. Spec: docs/theory/afforestation.md §4–6,
 * docs/theory/network.md §2.3.
 */

import { activeAreaPavedFraction, pavedFractionByMonth } from '../landuse/paved.js';
import {
	activeAreaByYear,
	activeAreaTable,
	runSfrGroup,
	sfrKind,
	type ChildTargetModel,
	type SfrGroupResult,
	type SfrOptions,
	type SfrRun,
	type SfrSimulator
} from '../landuse/sfr.js';
import { runRunoffModule, type RunRunoffOptions } from '../runoff/pitman.js';
import type { HydroYear, MonthlySeries, NetworkBundle, RainfallSeries, RunMode, RunoffDiagnostics, RunoffModule } from '../types.js';
import { lookupFile } from './modules.js';
import { applyRunMode } from './modes.js';

/** Each SFR child's parent (L.038–L.039 on the parent; a child doesn't name it, TT 691 §7.4.2). The first parent in module order wins (validation warns). */
export function sfrParents(bundle: NetworkBundle): Map<number, RunoffModule> {
	const parents = new Map<number, RunoffModule>();
	for (const m of bundle.modules) {
		if (m.kind !== 'RU') continue;
		for (const child of m.sfrChildren ?? []) if (!parents.has(child)) parents.set(child, m);
	}
	return parents;
}

/**
 * The module as the SFR simulator runs it: its own afforestation and alien
 * vegetation absent (a child's land use acts through its parameters) and no
 * SFR children (`SfrSimulator`, `landuse/sfr.ts`).
 */
export function bareModule(module: RunoffModule): RunoffModule {
	const next: { -readonly [K in keyof RunoffModule]: RunoffModule[K] } = {
		...module,
		afforestation: { ...module.afforestation, areaKm2: [] },
		sfrChildren: []
	};
	if (module.alienVegetation) next.alienVegetation = { ...module.alienVegetation, areaKm2: [] };
	return next;
}

/**
 * A Sami block run on `areaKm2` instead of the area it was written for:
 * the groundwater evaporation area keeps its share of the catchment
 * (B28_GWEvapAreaFactor = EVAREA/AREA, TT 691 p.49), so a child or a
 * reduced parent doesn't get the whole parent's riparian strip (R6-R5).
 */
export function samiOnArea(module: RunoffModule, ownerAreaKm2: number): RunoffModule {
	if (!module.sami || !(ownerAreaKm2 > 0) || module.areaKm2 === ownerAreaKm2) return module;
	return { ...module, sami: { ...module.sami, gwEvaporationArea: (module.sami.gwEvaporationArea * module.areaKm2) / ownerAreaKm2 } };
}

/**
 * The runoff model `runSfrGroup` drives: classic, Hughes or Sami, generated
 * runoff before RTIN and the L.020 split, no reductions. Every member of a
 * group carries the parent's Sami block (`inheritFromParent`), written for
 * `ownerAreaKm2` (R6-R5). `parentImpervious`, when given, is the parent's
 * own AI per run month on the area it runs on (R6-P1); a child's paved data
 * was already dropped (`inheritFromParent`, R6-P2).
 */
export function sfrSimulator(
	rainfall: (fileName: string) => RainfallSeries | undefined,
	options: Omit<RunRunoffOptions, 'reductions' | 'parent'>,
	group?: { readonly parentNumber: number; readonly ownerAreaKm2: number; readonly parentImpervious?: readonly number[] }
): SfrSimulator {
	return (module) => {
		const ran = rainfall(module.rainfallFile);
		if (!ran) throw new Error(`RU ${module.number}: rainfall file ${module.rainfallFile} is not in the network`);
		const run = group ? samiOnArea(module, group.ownerAreaKm2) : module;
		const impervious = group && module.number === group.parentNumber ? group.parentImpervious : undefined;
		const result = runRunoffModule(bareModule(run), ran, { ...options, reductions: [], ...(impervious ? { imperviousFraction: impervious } : {}) });
		return { outflow: result.outflow, diagnostics: result.diagnostics, messages: result.messages };
	};
}

/** One member's run and its area per hydrological year (the run is for the largest of them, R6-F16). */
interface Component {
	readonly run: SfrRun | null;
	readonly areaKm2ByYear: readonly number[];
}

const MM_KEYS = ['soilMoistureMm', 'aquiferStorageMm', 'rechargeMm'] as const;
const FLOW_KEYS = ['surfaceRunoff', 'groundwaterOutflow', 'pavedFlow', 'interflow'] as const;

/**
 * Diagnostics of a group member, or of the parent as a whole: depths (Pitman
 * S, GW storage, recharge) weighted by each member's area in the year
 * ("weighted Pitman S", `TS_AvGWStorage`: TT 689 pp.13–14, TT 691 p.51);
 * flows (interflow, groundwater outflow, surface, paved) summed after each
 * run is scaled to the year's area. `netRunoff` is the group's own figure.
 */
export function groupDiagnostics(components: readonly Component[], netRunoff: MonthlySeries): RunoffDiagnostics {
	const { startYear } = netRunoff;
	const n = netRunoff.values.length;
	const out: { -readonly [K in keyof RunoffDiagnostics]: RunoffDiagnostics[K] } = { netRunoff };
	const live = components.filter((c) => c.run?.diagnostics);
	for (const key of FLOW_KEYS) {
		const parts = live.filter((c) => c.run!.diagnostics![key]);
		if (parts.length === 0) continue;
		const values = new Array<number>(n).fill(0);
		for (const c of parts) {
			const aRef = Math.max(0, ...c.areaKm2ByYear);
			c.run!.diagnostics![key]!.values.forEach((v, i) => (values[i]! += aRef > 0 ? (v * c.areaKm2ByYear[Math.floor(i / 12)]!) / aRef : 0));
		}
		out[key] = { startYear, values, unit: 'Mm3' };
	}
	for (const key of MM_KEYS) {
		const parts = live.filter((c) => c.run!.diagnostics![key]);
		if (parts.length === 0) continue;
		const values = new Array<number>(n).fill(0);
		for (let i = 0; i < n; i++) {
			let w = 0;
			let s = 0;
			for (const c of parts) {
				const a = c.areaKm2ByYear[Math.floor(i / 12)]!;
				w += a;
				s += a * c.run!.diagnostics![key]!.values[i]!;
			}
			values[i] = w > 0 ? s / w : 0;
		}
		out[key] = { startYear, values, unit: 'mm' };
	}
	return out;
}

/** What the network needs from a group: the parent's and each child's generated runoff and diagnostics. */
export interface PlacedGroup {
	readonly result: SfrGroupResult;
	/** By module number: generated runoff before RTIN and the split, and diagnostics. */
	readonly members: ReadonlyMap<number, { readonly outflow: MonthlySeries; readonly diagnostics: RunoffDiagnostics }>;
}

/** Run one parent's group (modules taken from `bundle`, run mode applied). */
export function runGroup(
	bundle: NetworkBundle,
	parent: RunoffModule,
	mode: RunMode,
	startYear: HydroYear,
	endYear: HydroYear,
	runoff: Omit<RunRunoffOptions, 'reductions' | 'parent' | 'startYear' | 'endYear' | 'mode'>,
	sfr: { readonly options?: Partial<SfrOptions>; readonly targets?: { readonly forest?: ChildTargetModel; readonly alien?: ChildTargetModel } }
): PlacedGroup {
	const children = (parent.sfrChildren ?? [])
		.map((n) => bundle.modules.find((m): m is RunoffModule => m.kind === 'RU' && m.number === n))
		.filter((m): m is RunoffModule => m !== undefined)
		.map((m) => applyRunMode(m, mode));
	const appliedParent = applyRunMode(parent, mode);
	// R6-P1: the parent's AI is of its whole AREA; on the area left after the children's active areas it is min(1, AI·AREA/active).
	const active = activeAreaByYear([], mode, startYear, endYear).map((_, y) => {
		let a = parent.areaKm2;
		for (const c of children) a -= activeAreaByYear(activeAreaTable(c, sfrKind(c)), mode, startYear, endYear)[y]!;
		return Math.max(0, a);
	});
	const paved = pavedFractionByMonth(appliedParent, mode, startYear, endYear);
	const parentImpervious = paved.fraction.map((ai, i) => activeAreaPavedFraction(ai, parent.areaKm2, active[Math.floor(i / 12)]!));
	const simulate = sfrSimulator((f) => lookupFile(bundle.rainfall, f), { ...runoff, startYear, endYear, mode }, {
		parentNumber: parent.number,
		ownerAreaKm2: parent.areaKm2,
		parentImpervious
	});
	const result = runSfrGroup(
		{ parent: appliedParent, children, mode, startYear, endYear, simulate, ...(sfr.targets ? { targets: sfr.targets } : {}) },
		sfr.options
	);
	const members = new Map<number, { outflow: MonthlySeries; diagnostics: RunoffDiagnostics }>();
	const parentComponent: Component = { run: result.parentRun, areaKm2ByYear: result.parentAreaKm2ByYear };
	const childComponents = result.children.map((c) => ({ run: c.run, areaKm2ByYear: c.areaKm2ByYear }));
	members.set(parent.number, { outflow: result.outflowMm3, diagnostics: groupDiagnostics([parentComponent, ...childComponents], result.outflowMm3) });
	result.children.forEach((c, i) => members.set(c.number, { outflow: c.outflowMm3, diagnostics: groupDiagnostics([childComponents[i]!], c.outflowMm3) }));
	return { result: paved.messages.length > 0 ? { ...result, messages: [...paved.messages, ...result.messages] } : result, members };
}
