/**
 * What the land-use screen works out from an answer and the network, kept
 * out of the components so it is tested alone: the fields by crop, the crop
 * mapping's starting point and what still needs a decision, the modules a row
 * can go to, and what the map draws. Writing a row is the engine's
 * (`applyIrrigatedAreas`, `applyDams`).
 */

import {
	irrigationCropTypes,
	type AreaGeometry,
	type CropField,
	type CropMapping,
	type DamRecord,
	type HydroYear,
	type IrrigationModule,
	type ModuleRef,
	type NetworkBundle,
	type ReservoirModule,
	type ValueSourceKind,
	type YearTable
} from '@pitman/wrsm';
import type { MapModule } from '#lib/map/contract.js';

/** The default row: the app works towards 2025 (D1, D4). */
export const DEFAULT_ROW_YEAR = 2025;
/** The years the screen takes for a row. */
export const ROW_YEARS = { from: 1900, to: 2100 } as const;

/** The fields of one crop, in hectares by what the layer says of irrigation. */
export interface CropRow {
	readonly crop: string;
	readonly fields: number;
	readonly totalHa: number;
	/** The layer says irrigated. */
	readonly irrigatedHa: number;
	/** The layer says dryland. */
	readonly dryHa: number;
	/** The layer doesn't say: the user marks the crop (D-8). */
	readonly unknownHa: number;
}

/** The fields grouped by crop, the largest first. */
export function cropRows(fields: readonly CropField[]): readonly CropRow[] {
	const rows = new Map<string, { crop: string; fields: number; totalHa: number; irrigatedHa: number; dryHa: number; unknownHa: number }>();
	for (const f of fields) {
		const row = rows.get(f.crop) ?? { crop: f.crop, fields: 0, totalHa: 0, irrigatedHa: 0, dryHa: 0, unknownHa: 0 };
		row.fields += 1;
		row.totalHa += f.areaHa;
		if (f.irrigated === true) row.irrigatedHa += f.areaHa;
		else if (f.irrigated === false) row.dryHa += f.areaHa;
		else row.unknownHa += f.areaHa;
		rows.set(f.crop, row);
	}
	return [...rows.values()].sort((a, b) => b.totalHa - a.totalHa || (a.crop < b.crop ? -1 : 1));
}

/** The hectares of a crop that count as irrigated, given whether the user marked it. */
export function countedHa(row: CropRow, marked: boolean): number {
	return row.irrigatedHa + (marked ? row.unknownHa : 0);
}

/** What the user chose for a crop: a crop type, `null` to leave it out, `undefined` when not yet decided. */
export type CropChoice = string | null | undefined;

/** Pitman's starting point before the user confirms: the mapping saved in the sidecar, a module's only crop type, or the type of the same name. Never a guess past that. */
export function startingChoice(crop: string, types: readonly string[], saved?: CropMapping): CropChoice {
	const earlier = saved && Object.hasOwn(saved, crop) ? saved[crop] : undefined;
	if (typeof earlier === 'string' && types.includes(earlier)) return earlier;
	if (types.length === 1) return types[0];
	const name = crop.trim().toLowerCase();
	return types.find((t) => t.trim().toLowerCase() === name);
}

/** The crops with irrigated hectares and no decision: Apply waits for these. */
export function undecidedCrops(rows: readonly CropRow[], choice: (crop: string) => CropChoice, marked: ReadonlySet<string>): readonly string[] {
	return rows.filter((r) => countedHa(r, marked.has(r.crop)) > 0 && choice(r.crop) === undefined).map((r) => r.crop);
}

/** The mapping as the engine takes it: every crop, with only those that count mapped, because only those were on screen to confirm. */
export function confirmedMapping(rows: readonly CropRow[], choice: (crop: string) => CropChoice, marked: ReadonlySet<string>): CropMapping {
	return Object.fromEntries(rows.map((r) => [r.crop, countedHa(r, marked.has(r.crop)) > 0 ? (choice(r.crop) ?? null) : null]));
}

export interface IrrigationChoice {
	readonly ref: ModuleRef;
	readonly label: string;
	readonly types: readonly string[];
	readonly rows: YearTable;
	/** Why the row can't be written here; `undefined` when it can. */
	readonly refused?: string;
}

/** The network's irrigation modules. WQT type 4 stays on the list, refused in words: it can be read but not written (R2-5). */
export function irrigationChoices(bundle: NetworkBundle): readonly IrrigationChoice[] {
	return bundle.modules
		.filter((m): m is IrrigationModule => m.kind === 'RR')
		.map((m) => ({
			ref: { type: 'RR', number: m.number },
			label: `RR ${m.number}, ${m.name.trim()}`,
			types: irrigationCropTypes(m),
			rows: m.areaKm2,
			...(m.layout === 'wqt4' ? { refused: `RR ${m.number} is a WQT type 4 file, which Pitman can read but not write. Change its row in WRSM2000.` } : {})
		}));
}

export interface ReservoirChoice {
	readonly ref: ModuleRef;
	readonly label: string;
	readonly rows: ReservoirModule['capacity'];
	/** Fed by one runoff module and nothing else: the farm-dam pattern's reservoir. */
	readonly farmDam: boolean;
}

/** The network's reservoirs, the ones that look like farm dams first (every reservoir stays on offer). */
export function reservoirChoices(bundle: NetworkBundle): readonly ReservoirChoice[] {
	const { modules, routes } = bundle.network;
	const fedByRunoffOnly = (m: ReservoirModule) => {
		const position = modules.findIndex((e) => e.type === 'RV' && e.number === m.number) + 1;
		const ups = routes.filter((r) => r.downstreamPosition === position).map((r) => modules[r.upstreamPosition - 1]);
		return ups.length === 1 && ups[0]?.type === 'RU';
	};
	const choices = bundle.modules
		.filter((m): m is ReservoirModule => m.kind === 'RV')
		.map((m) => ({ ref: { type: 'RV', number: m.number } as ModuleRef, label: `RV ${m.number}, ${m.name.trim()}`, rows: m.capacity, farmDam: fedByRunoffOnly(m) }));
	return [...choices.filter((c) => c.farmDam), ...choices.filter((c) => !c.farmDam)];
}

/** Whether a typed year can head a row. */
export function validYear(year: HydroYear | null): year is HydroYear {
	return year !== null && Number.isInteger(year) && year >= ROW_YEARS.from && year <= ROW_YEARS.to;
}

/** The fields as one shape for the map: it has no field layer yet, so they go as the `proposal`. `null` with none. */
export function fieldsShape(fields: readonly CropField[]): AreaGeometry | null {
	if (fields.length === 0) return null;
	const parts = fields.flatMap((f) => (f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates));
	return { type: 'MultiPolygon', coordinates: parts };
}

/** The matched dams as points on the map, named under the pointer. */
export function damMarkers(dams: readonly DamRecord[]): readonly MapModule[] {
	return dams.map((d) => ({ id: d.id, label: `Dam: ${damName(d)}`, lngLat: [d.lon, d.lat] }));
}

/** A dam's name: the matched source's note without the remark `matchDams` adds to it. */
export function damName(dam: DamRecord): string {
	return (dam.source.note ?? dam.id).replace(/: (area ×|no capacity).*$/, '');
}

/** Where a value came from, in words. */
export function sourceLabel(kind: ValueSourceKind, note?: string): string {
	const measured = note?.includes('area ×') === true;
	switch (kind) {
		case 'damRegister':
			return 'Register of dams';
		case 'capeFarmMapper':
			return measured ? 'Cape Farm Mapper area × 3 m' : 'Cape Farm Mapper';
		case 'surfaceWater':
			return 'Satellite area × 3 m';
		case 'manual':
			return 'Typed in';
		default:
			return kind;
	}
}
