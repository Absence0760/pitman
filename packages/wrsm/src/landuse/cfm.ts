/**
 * Irrigated areas from a crop census (issue #3 agent 7.3, D3, D-8): the
 * fields of `POST /cfm/land-use` summed per the irrigation module's crop type,
 * and the module's row for a year written from them. Decisions R7-C1 to R7-C4.
 *
 * Rounding follows R5-E3: a module holds its values at the file's precision
 * (RR area 0.01 km², CPF 0.01 %), so what is previewed is what is saved.
 */

import { fileRound, largestRemainder } from '../subdivide/areas.js';
import type { HydroYear, IrrigationModule, ModuleRef, NetworkBundle, Sidecar, ValueSource, ValueTarget } from '../types.js';
import type { ApplyIrrigatedAreas, CropField, CropMapping, IrrigatedArea, LandUseResponse, SumIrrigatedAreas } from './round7-contract.js';

/** RR L.006 and L.020 CPF: decimals in the file (docs/formats.md §8). */
const AREA_DECIMALS = 2;
const PERCENT_DECIMALS = 2;

/** The crop type of a module with no crop table: what `upgradeIrrigation` writes for it (docs/formats.md, L.020). */
export const COMPOSITE_CROP = 'composite';

/**
 * `POST /cfm/land-use`'s answer as sent: the contract plus what the service
 * has to say about it (fields it could not read, a layer not configured).
 * Additive (R7-C7); the screen shows each as a warning.
 */
export interface LandUseAnswer extends LandUseResponse {
	readonly warnings?: readonly string[];
}

/** The crop types a module's fields can map to: its crop table, or the composite crop when it has none. */
export function irrigationCropTypes(module: IrrigationModule): readonly string[] {
	const crops = module.layout === 'pitman' ? [] : module.crops;
	return crops.length === 0 ? [COMPOSITE_CROP] : [...new Set(crops.map((c) => c.description))];
}

/** Whether a field counts as irrigated: the layer's word when it has one, else the user's mark on its crop (D-8). */
export function fieldIrrigated(field: CropField, markedIrrigated: ReadonlySet<string>): boolean {
	return field.irrigated ?? markedIrrigated.has(field.crop);
}

/**
 * Irrigated fields summed per mapped crop, in km², sorted by crop. A crop
 * mapped to `null` is left out; an irrigated crop with no entry at all is an
 * error, because dropping it quietly would understate the row.
 */
export const sumIrrigatedAreas: SumIrrigatedAreas = (fields, mapping, markedIrrigated) => {
	const marked = new Set(markedIrrigated);
	const totals = new Map<string, number>();
	for (const field of fields) {
		if (!fieldIrrigated(field, marked)) continue;
		if (!Number.isFinite(field.areaHa) || field.areaHa < 0) throw new RangeError(`field ${field.id} has an area of ${field.areaHa} ha`);
		// `hasOwn`: a crop is the layer's text, so `constructor` must not find Object's.
		if (!Object.hasOwn(mapping, field.crop)) throw new RangeError(`irrigated crop "${field.crop}" has no mapping: choose a crop type or leave it out`);
		const crop = mapping[field.crop];
		if (crop === null || crop === undefined) continue;
		totals.set(crop, (totals.get(crop) ?? 0) + field.areaHa / 100);
	}
	return [...totals].map(([crop, areaKm2]) => ({ crop, areaKm2 })).sort((a, b) => (a.crop < b.crop ? -1 : a.crop > b.crop ? 1 : 0));
};

/** The areas' total as the file holds it (RR L.006). */
export function irrigatedRowKm2(areas: readonly IrrigatedArea[]): number {
	return fileRound(areas.reduce((sum, a) => sum + a.areaKm2, 0), AREA_DECIMALS);
}

function findIrrigation(bundle: NetworkBundle, ref: ModuleRef): IrrigationModule {
	const module = ref.type === 'RR' ? bundle.modules.find((m): m is IrrigationModule => m.kind === 'RR' && m.number === ref.number) : undefined;
	if (!module) throw new RangeError(`${ref.type} ${ref.number} is not an irrigation module in this network`);
	return module;
}

/** The module's crop table with each CPF from the areas' shares, adding to 100 in file units; crops the fields don't reach go to 0. */
function withCropShares(module: Exclude<IrrigationModule, { layout: 'pitman' }>, areas: readonly IrrigatedArea[]) {
	const total = areas.reduce((sum, a) => sum + a.areaKm2, 0);
	if (!(total > 0) || module.crops.length === 0) return module.crops;
	const seen = new Set<string>();
	// A description repeated in the table takes its share once, on its first row.
	const shares = module.crops.map((c) => {
		if (seen.has(c.description)) return 0;
		seen.add(c.description);
		return areas.find((a) => a.crop === c.description)?.areaKm2 ?? 0;
	});
	const percents = largestRemainder(100, shares, PERCENT_DECIMALS);
	return module.crops.map((c, i) => ({ ...c, percent: percents[i]! }));
}

const sameTarget = (a: ValueTarget, b: ValueTarget) =>
	a.module?.type === b.module?.type && a.module?.number === b.module?.number && a.field === b.field && a.year === b.year && a.month === b.month && a.file === b.file;

/** The sidecar's `values` with each entry replacing any on the same target. */
function upsertValues(values: Sidecar['values'], entries: NonNullable<Sidecar['values']>): NonNullable<Sidecar['values']> {
	return [...(values ?? []).filter((v) => !entries.some((e) => sameTarget(e.target, v.target))), ...entries];
}

/**
 * The bundle with the module's area row for `year` set to the areas' total
 * (added in year order, or replacing that year's row) and, for a module with
 * a crop table, its CPF percentages set to the areas' shares (R7-C1). The
 * sidecar records the fetch, the confirmed mapping and each value's source;
 * `source.date` is the fetch date and `source.note` the dataset.
 */
export function applyIrrigatedAreas<B extends NetworkBundle>(bundle: B, module: ModuleRef, year: HydroYear, areas: readonly IrrigatedArea[], source: ValueSource, mapping: CropMapping): B {
	const found = findIrrigation(bundle, module);
	if (found.layout === 'wqt4') throw new RangeError(`RR ${found.number} is WQT type 4 (file version 42), which Pitman reads but can't write (R2-5): change its row in WRSM2000`);
	if (!Number.isInteger(year) || year < 1000 || year > 9999) throw new RangeError(`${year} is not a year the file can hold`);
	if (source.date === undefined) throw new RangeError('the source has no fetch date');
	const types = irrigationCropTypes(found);
	for (const a of areas) {
		if (!types.includes(a.crop)) throw new RangeError(`RR ${found.number} has no crop type "${a.crop}"`);
		if (!Number.isFinite(a.areaKm2) || a.areaKm2 < 0) throw new RangeError(`${a.crop} has an area of ${a.areaKm2} km²`);
	}
	const row = { year, value: irrigatedRowKm2(areas) };
	const areaKm2 = [...found.areaKm2.filter((r) => r.year !== year), row].sort((a, b) => a.year - b.year);
	let next: IrrigationModule = { ...found, areaKm2 };
	const entries: NonNullable<Sidecar['values']>[number][] = [{ target: { module, field: 'areaKm2', year }, source }];
	if (found.layout !== 'pitman') {
		const crops = withCropShares(found, areas);
		next = { ...found, areaKm2, crops };
		if (crops.some((c, i) => c.percent !== found.crops[i]!.percent)) {
			const before = found.crops.map((c) => `${c.description} ${c.percent} %`).join(', ');
			entries.push({ target: { module, field: 'crops.percent' }, source: { ...source, note: `${source.note ?? 'census'}; was ${before}` } });
		}
	}
	const base: Sidecar = bundle.sidecar ?? { schema: 'pitman-sidecar', schemaVersion: 1 };
	// The mapping is by census crop for the whole network: a crop confirmed again replaces its entry, one left out drops it.
	const cropMapping = Object.fromEntries(Object.entries({ ...base.capeFarmMapper?.cropMapping, ...mapping }).filter((e): e is [string, string] => e[1] !== null));
	const sidecar: Sidecar = {
		...base,
		capeFarmMapper: { fetchedOn: source.date, ...(source.note === undefined ? {} : { dataset: source.note }), cropMapping },
		values: upsertValues(base.values, entries)
	};
	return { ...bundle, modules: bundle.modules.map((m) => (m === found ? next : m)), sidecar };
}

// Held to the contract's generic signature at compile time.
applyIrrigatedAreas satisfies ApplyIrrigatedAreas;
