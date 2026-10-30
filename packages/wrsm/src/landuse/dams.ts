/**
 * Farm dams for a year's row (issue #3 agent 7.4, data half; D4): candidates
 * from the register, Cape Farm Mapper and satellite surface water matched by
 * location, the precedence register > CFM > area × 3 m giving each dam's
 * capacity, and the sum written to the farm-dam reservoir. Decisions R7-C5,
 * R7-C6. Rounding follows R5-E3 (RV capacity and area, 0.01).
 */

import { fileRound } from '../subdivide/areas.js';
import type { DamRecord, HydroYear, IsoDate, ModuleRef, NetworkBundle, ReservoirModule, Sidecar, ValueSource, ValueSourceKind } from '../types.js';
import type { ApplyDams, DamCandidate, MatchDams } from './round7-contract.js';

/** RV L.005, L.006: decimals in the file (docs/formats.md §6). */
const RV_DECIMALS = 2;
/** Mean depth of D4's area × 3 m. km² × m = million m³. */
export const DAM_DEPTH_M = 3;
/** Under about 0.1 ha a satellite area is noise: no area-based volume (docs/data.md § Satellite surface water). */
export const MIN_DAM_AREA_KM2 = 0.001;
/** A dam's point differs between sources by about its own size, and most farm dams are under 300 m across (R7-C5). */
export const DEFAULT_MATCH_RADIUS_M = 150;

const EARTH_RADIUS_M = 6_371_008.8;
const SOURCE_ORDER = ['register', 'capeFarmMapper', 'surfaceWater'] as const;
const VALUE_KIND: Record<DamCandidate['source'], ValueSourceKind> = { register: 'damRegister', capeFarmMapper: 'capeFarmMapper', surfaceWater: 'surfaceWater' };

/** Metres between two points: equirectangular, ample for a radius of hundreds of metres. */
function distanceM(a: DamCandidate, b: DamCandidate): number {
	const rad = Math.PI / 180;
	const x = (b.lon - a.lon) * rad * Math.cos(((a.lat + b.lat) / 2) * rad);
	const y = (b.lat - a.lat) * rad;
	return Math.hypot(x, y) * EARTH_RADIUS_M;
}

/** One candidate's capacity, stated or from its area; `undefined` when it gives neither. */
function valueOf(c: DamCandidate, date: IsoDate): { capacityMm3: number; source: ValueSource; stated: boolean } | undefined {
	const label = c.name ?? c.id;
	const kind = VALUE_KIND[c.source];
	if (c.capacityMm3 !== undefined && c.capacityMm3 > 0) return { capacityMm3: c.capacityMm3, source: { kind, note: label, date }, stated: true };
	if (c.areaKm2 !== undefined && c.areaKm2 >= MIN_DAM_AREA_KM2) {
		return { capacityMm3: c.areaKm2 * DAM_DEPTH_M, source: { kind, note: `${label}: area × ${DAM_DEPTH_M} m`, date }, stated: false };
	}
	return undefined;
}

/** A matched dam's record: stated capacities first, then area × 3 m, each in source order (D4). */
function record(members: readonly DamCandidate[], date: IsoDate): DamRecord {
	const anchor = members[0]!;
	const values = members.flatMap((m) => valueOf(m, date) ?? []);
	const ordered = [...values.filter((v) => v.stated), ...values.filter((v) => !v.stated)];
	const used = ordered[0];
	// An area under the noise floor measures nothing, so the dam counts as having none (R7-C6).
	const areaKm2 = members.find((m) => m.areaKm2 !== undefined && m.areaKm2 >= MIN_DAM_AREA_KM2)?.areaKm2;
	const fallback: ValueSource = { kind: VALUE_KIND[anchor.source], note: `${anchor.name ?? anchor.id}: no capacity, and no area to measure one from`, date };
	return {
		id: anchor.id,
		lon: anchor.lon,
		lat: anchor.lat,
		capacityMm3: used?.capacityMm3 ?? 0,
		...(areaKm2 === undefined ? {} : { areaKm2 }),
		source: used?.source ?? fallback,
		...(ordered.length > 1 ? { alternatives: ordered.slice(1).map(({ capacityMm3, source }) => ({ capacityMm3, source })) } : {})
	};
}

/**
 * D4's matching. Each source's dams are distinct among themselves: a source
 * never lists one dam twice, so two register dams side by side stay two.
 * The sources go in precedence order, and each candidate joins the nearest
 * dam within the radius that this source hasn't reached, closest pairs first;
 * the rest become dams of their own. Distance is always to the dam's first
 * candidate, so a chain of near neighbours can't pull far points together.
 * The result doesn't depend on the candidates' order.
 */
export const matchDams: MatchDams = (candidates, options) => {
	const { matchRadiusM, fetchedOn } = options;
	if (!(matchRadiusM >= 0)) throw new RangeError(`the match radius is ${matchRadiusM} m`);
	for (const c of candidates) if (!Number.isFinite(c.lon) || !Number.isFinite(c.lat)) throw new RangeError(`dam ${c.id} has no position`);
	const dams: DamCandidate[][] = [];
	for (const source of SOURCE_ORDER) {
		const tier = candidates.filter((c) => c.source === source).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
		const pairs = tier.flatMap((candidate, c) =>
			dams.flatMap((members, d) => {
				const distance = distanceM(members[0]!, candidate);
				return distance <= matchRadiusM ? [{ c, d, distance }] : [];
			})
		);
		pairs.sort((a, b) => a.distance - b.distance || a.d - b.d || a.c - b.c);
		const placed = new Set<number>();
		const reached = new Set<number>();
		for (const { c, d } of pairs) {
			if (placed.has(c) || reached.has(d)) continue;
			placed.add(c);
			reached.add(d);
			dams[d]!.push(tier[c]!);
		}
		tier.forEach((candidate, c) => {
			if (!placed.has(c)) dams.push([candidate]);
		});
	}
	return dams.map((members) => record(members, fetchedOn)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
};

/** The dam with the user's capacity in force and the value it replaces kept among the alternatives (rule 8). A note is required. */
export function overrideDam(dam: DamRecord, capacityMm3: number, note: string, date: IsoDate): DamRecord {
	if (!Number.isFinite(capacityMm3) || capacityMm3 < 0) throw new RangeError(`a capacity of ${capacityMm3} million m³`);
	if (note.trim() === '') throw new RangeError('an override needs a note saying where the value came from');
	const replaced = dam.capacityMm3 > 0 ? [{ capacityMm3: dam.capacityMm3, source: dam.source }] : [];
	const alternatives = [...replaced, ...(dam.alternatives ?? [])];
	return { ...dam, capacityMm3, source: { kind: 'manual', note: note.trim(), date }, ...(alternatives.length > 0 ? { alternatives } : {}) };
}

/** A dam's surface area: as measured, else its capacity over D4's 3 m (R7-C6). */
export function damAreaKm2(dam: DamRecord): number {
	return dam.areaKm2 ?? dam.capacityMm3 / DAM_DEPTH_M;
}

/** The dams' row as the file holds it (RV L.005, L.006). */
export function damsRow(dams: readonly DamRecord[]): { readonly fullSupplyVolumeMm3: number; readonly fullSupplyAreaKm2: number } {
	return {
		fullSupplyVolumeMm3: fileRound(dams.reduce((sum, d) => sum + d.capacityMm3, 0), RV_DECIMALS),
		fullSupplyAreaKm2: fileRound(dams.reduce((sum, d) => sum + damAreaKm2(d), 0), RV_DECIMALS)
	};
}

/** The one runoff module whose routes feed the reservoir: the sub-catchment its dams lie in, which a split re-points (R5-E16). */
function feedingRunoff(bundle: NetworkBundle, reservoir: ReservoirModule): ModuleRef | undefined {
	const { modules, routes } = bundle.network;
	const position = modules.findIndex((e) => e.type === 'RV' && e.number === reservoir.number) + 1;
	if (position === 0) return undefined;
	const feeders = new Set(routes.filter((r) => r.downstreamPosition === position).flatMap((r) => (modules[r.upstreamPosition - 1]?.type === 'RU' ? [modules[r.upstreamPosition - 1]!.number] : [])));
	return feeders.size === 1 ? { type: 'RU', number: [...feeders][0]! } : undefined;
}

/**
 * The bundle with the reservoir's row for `year` set to the dams' sum (added
 * in year order, or replacing that year's row) and the sidecar's `dams`
 * holding each one under that row, so the list always backs the row: a new
 * list replaces that row's dams and no other's (R7-C6). A dam takes the runoff
 * module feeding the reservoir when there is one. A list summing to nothing is
 * refused: a capacity of 0 takes the reservoir out of that year.
 */
export function applyDams<B extends NetworkBundle>(bundle: B, reservoir: ModuleRef, year: HydroYear, dams: readonly DamRecord[]): B {
	const found = reservoir.type === 'RV' ? bundle.modules.find((m): m is ReservoirModule => m.kind === 'RV' && m.number === reservoir.number) : undefined;
	if (!found) throw new RangeError(`${reservoir.type} ${reservoir.number} is not a reservoir in this network`);
	if (!Number.isInteger(year) || year < 1000 || year > 9999) throw new RangeError(`${year} is not a year the file can hold`);
	if (dams.length === 0) throw new RangeError('there are no dams to sum');
	for (const d of dams) {
		if (!Number.isFinite(d.capacityMm3) || d.capacityMm3 < 0) throw new RangeError(`dam ${d.id} has a capacity of ${d.capacityMm3} million m³`);
		if (d.areaKm2 !== undefined && (!Number.isFinite(d.areaKm2) || d.areaKm2 < 0)) throw new RangeError(`dam ${d.id} has an area of ${d.areaKm2} km²`);
	}
	const row = damsRow(dams);
	if (row.fullSupplyVolumeMm3 === 0) throw new RangeError('the dams add up to no capacity the file can hold');
	const capacity = [...found.capacity.filter((r) => r.year !== year), { year, ...row }].sort((a, b) => a.year - b.year);
	const runoff = feedingRunoff(bundle, found);
	const ids = new Set(dams.map((d) => d.id));
	// A record from before rows were kept is replaced by its id.
	const kept = (bundle.sidecar?.dams ?? []).filter((d) => (d.row ? !(d.row.reservoir.number === reservoir.number && d.row.reservoir.type === reservoir.type && d.row.year === year) : !ids.has(d.id)));
	const held = dams.map((d) => ({ ...d, ...(runoff && !d.module ? { module: runoff } : {}), row: { reservoir, year } }));
	const base: Sidecar = bundle.sidecar ?? { schema: 'pitman-sidecar', schemaVersion: 1 };
	return { ...bundle, modules: bundle.modules.map((m) => (m === found ? { ...found, capacity } : m)), sidecar: { ...base, dams: [...kept, ...held] } };
}

// Held to the contract's generic signature at compile time.
applyDams satisfies ApplyDams;
