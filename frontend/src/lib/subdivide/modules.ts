/**
 * Step 1: which runoff modules a quaternary has. A network names quaternaries
 * only in its module names, so a module whose name holds the code is offered
 * first and every other module stays one choice away ("chosen by the user",
 * lib/map/contract.ts). SFR children split with their parent, never alone.
 */

import type { AreaGeometry, ModuleRef, NetworkBundle, QuaternaryCollection, QuaternaryFeature, RunoffModule, Subdivision } from '@pitman/wrsm';
import { hydroYearLabel } from '#lib/results/format.js';

const QUATERNARY_CODE = /(?:^|[^A-Z0-9])([A-Z]\d{2}[A-Z])(?![A-Z0-9])/;

/** The quaternary code in a module's name, upper-cased, if it holds one. */
export function quaternaryInName(name: string): string | undefined {
	return QUATERNARY_CODE.exec(name.toUpperCase())?.[1];
}

/** The quaternaries as the service answered. */
export type Loaded = { readonly state: 'loading' } | { readonly state: 'ok'; readonly collection: QuaternaryCollection } | { readonly state: 'failed'; readonly message: string };

/** A boundary the user brought, with the code they gave it. */
export interface Upload {
	readonly fileName: string;
	readonly geometry: AreaGeometry;
	readonly code: string;
}

export interface RunoffChoice {
	readonly ref: ModuleRef;
	readonly label: string;
	readonly areaKm2: number;
	readonly mapMm: number;
	readonly rainfallFile: string;
	readonly quaternary?: string;
	/** The module's SFR children, which split with it. */
	readonly sfrChildren: number;
}

function choice(m: RunoffModule): RunoffChoice {
	const name = m.name.trim();
	const quaternary = quaternaryInName(name);
	return {
		ref: { type: 'RU', number: m.number },
		label: `RU ${m.number}${name ? ` ${name}` : ''}`,
		areaKm2: m.areaKm2,
		mapMm: m.mapMm,
		rainfallFile: m.rainfallFile,
		...(quaternary !== undefined && { quaternary }),
		sfrChildren: m.sfrChildren?.length ?? 0
	};
}

/** Every runoff module that can be split, in `.NET` order (SFR children left out: they go with their parent). */
export function runoffChoices(bundle: NetworkBundle): RunoffChoice[] {
	const runoff = bundle.modules.filter((m): m is RunoffModule => m.kind === 'RU');
	const children = new Set(runoff.flatMap((m) => m.sfrChildren ?? []));
	const order = new Map(bundle.network.modules.map((entry, i) => [`${entry.type}${entry.number}`, i]));
	return runoff
		.filter((m) => !children.has(m.number))
		.sort((a, b) => (order.get(`RU${a.number}`) ?? 0) - (order.get(`RU${b.number}`) ?? 0))
		.map(choice);
}

/** The modules named for `code` first, then the rest. */
export function choicesFor(choices: readonly RunoffChoice[], code: string): { readonly named: readonly RunoffChoice[]; readonly others: readonly RunoffChoice[] } {
	return { named: choices.filter((c) => c.quaternary === code), others: choices.filter((c) => c.quaternary !== code) };
}

/** Codes this network's modules name, then the rest of the collection, each sorted. */
export function quaternaryGroups(collection: QuaternaryCollection, choices: readonly RunoffChoice[]): { readonly inNetwork: readonly string[]; readonly others: readonly string[] } {
	const named = new Set(choices.flatMap((c) => (c.quaternary === undefined ? [] : [c.quaternary])));
	const codes = [...new Set(collection.features.map((f) => f.properties.code))].sort();
	return { inNetwork: codes.filter((c) => named.has(c)), others: codes.filter((c) => !named.has(c)) };
}

export function featureOf(collection: QuaternaryCollection, code: string): QuaternaryFeature | undefined {
	return collection.features.find((f) => f.properties.code === code);
}

/** The recorded sub-division a module belongs to, as the original or as a piece. */
export function subdivisionOf(bundle: NetworkBundle, ref: ModuleRef): { readonly quaternary: string; readonly subdivision: Subdivision } | undefined {
	const found = Object.entries(bundle.sidecar?.subdivisions ?? {}).find(([, s]) => ref.type === 'RU' && (s.module.number === ref.number || s.pieces.some((p) => p.number === ref.number)));
	return found && { quaternary: found[0], subdivision: found[1] };
}

/** Why a module can't be split now, in words, or `null`. */
export function splitBlock(bundle: NetworkBundle, ref: ModuleRef, quaternary?: string): string | null {
	const done = subdivisionOf(bundle, ref);
	if (done !== undefined) return `${ref.type} ${ref.number} is already part of the sub-division of ${done.quaternary}. A split can’t be added to one that has been applied: go back to the zip saved before it and make all the splits together (up to 8 pieces).`;
	const applied = quaternary === undefined ? undefined : bundle.sidecar?.subdivisions?.[quaternary];
	if (applied === undefined) return null;
	return `${quaternary} is already sub-divided, and ${ref.type} ${ref.number} is not one of its pieces. One factor scales every piece of a quaternary, so another module can’t join it: choose another quaternary for ${ref.type} ${ref.number}, or go back to the zip saved before the split and make all the splits together.`;
}

/** One row of the "already sub-divided" table: where each final MAP and its target came from (rule 8). */
export interface DoneRow {
	readonly quaternary: string;
	readonly original: string;
	readonly pieces: string;
	readonly target: string;
	readonly status: string;
}

export function doneRows(bundle: NetworkBundle): DoneRow[] {
	return Object.entries(bundle.sidecar?.subdivisions ?? {}).map(([quaternary, s]) => {
		const c = s.calibration;
		return {
			quaternary,
			original: `RU ${s.module.number}`,
			pieces: s.pieces.map((p) => `RU ${p.number}: ${p.areaKm2.toFixed(1)} km², MAP ${Math.round(p.mapMm)} mm`).join('; '),
			target: `${c.target.marMm3.toFixed(3)} million m³/year (${c.target.source}), ${hydroYearLabel(c.period[0])} to ${hydroYearLabel(c.period[1])}`,
			status: `${c.status === 'converged' ? 'Converged' : 'Not converged: best factor used'}, factor ${c.factor.toFixed(4)}`
		};
	});
}
