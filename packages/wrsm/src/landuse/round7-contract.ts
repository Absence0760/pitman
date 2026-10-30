/**
 * Round 7 contract for the land-use data (agents 7.3, 7.4), written by the
 * orchestrator before the round so the backend and the screens can be built
 * in parallel. The Cape Farm Mapper layer's real fields are unknown until the
 * operator's token exists (docs/data.md § Cape Farm Mapper, questions 1–7), so
 * this is what Pitman needs, not what the layer holds: the backend maps the
 * layer onto it in one place. Signatures change here first, by the orchestrator.
 */

import type { AreaGeometry } from '../extend/contract.js';
import type { DamRecord, HydroYear, IsoDate, ModuleRef, NetworkBundle, ValueSource } from '../types.js';

// ---------------------------------------------------------------------------
// The wire: POST /cfm/land-use (routes are relative to the API base)
// ---------------------------------------------------------------------------

export interface LandUseRequest {
	/** The (sub-)catchment. Geometry only (issue #3 rule 7). */
	readonly area: AreaGeometry;
}

/** One field inside the area, clipped to it. */
export interface CropField {
	readonly id: string;
	/** The layer's crop name, as it says it. */
	readonly crop: string;
	/** `null` when the layer doesn't say: the user marks crops irrigated (docs/data.md, default of question 6). */
	readonly irrigated: boolean | null;
	/** Geodesic, recomputed from the clipped polygon, never the layer's `Shape_Area`. */
	readonly areaHa: number;
	readonly geometry: AreaGeometry;
}

/** One dam as a source gives it, before matching (D4). */
export interface DamCandidate {
	readonly id: string;
	readonly source: 'register' | 'capeFarmMapper' | 'surfaceWater';
	readonly lon: number;
	readonly lat: number;
	readonly capacityMm3?: number;
	readonly areaKm2?: number;
	readonly name?: string;
}

export interface LandUseResponse {
	readonly fields: readonly CropField[];
	readonly dams: readonly DamCandidate[];
	/** Dataset, as the screen and the sidecar credit it (rule 8). */
	readonly dataset: string;
	/** The census year the fields describe, which is the year a written row carries. */
	readonly surveyYear: HydroYear;
	readonly fetchedOn: IsoDate;
	/** Which source answered: the real proxy, or the local synthetic one (local-first). */
	readonly source: 'cfm' | 'local';
}

// ---------------------------------------------------------------------------
// The method: packages/wrsm/src/landuse/ (pure)
// ---------------------------------------------------------------------------

/** The user's confirmed mapping: a layer crop → the irrigation module's crop type, `null` to leave it out. */
export type CropMapping = Readonly<Record<string, string | null>>;

export interface IrrigatedArea {
	/** The irrigation module's crop type. */
	readonly crop: string;
	readonly areaKm2: number;
}

/** Irrigated fields summed per mapped crop. */
export type SumIrrigatedAreas = (fields: readonly CropField[], mapping: CropMapping, markedIrrigated: readonly string[]) => readonly IrrigatedArea[];

/** The bundle with the irrigation module's row for `year` written and the sidecar's `capeFarmMapper` entry recorded. */
export type ApplyIrrigatedAreas<B extends NetworkBundle = NetworkBundle> = (bundle: B, module: ModuleRef, year: HydroYear, areas: readonly IrrigatedArea[], source: ValueSource, mapping: CropMapping) => B;

/** D4: match by location and de-duplicate; the precedence register > CFM > area × 3 m gives each dam's `DamRecord`. */
export type MatchDams = (candidates: readonly DamCandidate[], options: { readonly matchRadiusM: number; readonly fetchedOn: IsoDate }) => readonly DamRecord[];

/** Sum the dams into the farm-dam module's row for `year`; the sidecar's `dams` keep each one and its source. */
export type ApplyDams<B extends NetworkBundle = NetworkBundle> = (bundle: B, reservoir: ModuleRef, year: HydroYear, dams: readonly DamRecord[]) => B;

/** One cell of a year table, edited on screen, with its source (rule 8). */
export interface TableEdit {
	/** `row` is the table's property name: `areaKm2`, or `fraction` for paved (R7-T1). */
	readonly target: { readonly module: ModuleRef; readonly table: 'afforestation' | 'alienVegetation' | 'paved'; readonly row: string };
	readonly year: HydroYear;
	/** `null` removes the row. */
	readonly value: number | null;
	readonly source: ValueSource;
}

/** The bundle with the edits written and each recorded in `sidecar.values`. */
export type ApplyTableEdits<B extends NetworkBundle = NetworkBundle> = (bundle: B, edits: readonly TableEdit[]) => B;
