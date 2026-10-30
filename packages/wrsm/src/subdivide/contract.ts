/**
 * Round 5 contract for method B (docs/theory/subdivide.md), written by the
 * orchestrator before the round so the agents can build against it in
 * parallel: the backend's delineation and data routes (5.1, 5.2) answer the
 * wire types, the engine's `src/subdivide/**` (5.3, 5.4) implements the
 * function types, and the wizard (5.5) calls both. Signatures change here
 * first, by the orchestrator.
 */

import type { AreaGeometry } from '../extend/contract.js';
import type { HydroYear, ModuleRef, NetworkBundle } from '../types.js';

// ---------------------------------------------------------------------------
// The wire (routes are relative to the API base, decision R4-I4)
// ---------------------------------------------------------------------------

/** One quaternary: a feature of `GET /quaternaries` (docs/data.md § Quaternaries; synthetic `Z01A`… locally). */
export interface QuaternaryFeature {
	readonly type: 'Feature';
	readonly properties: { readonly code: string; readonly mapMm?: number; readonly areaKm2?: number };
	readonly geometry: AreaGeometry;
}

export interface QuaternaryCollection {
	readonly type: 'FeatureCollection';
	readonly features: readonly QuaternaryFeature[];
	/** Where the boundaries came from, as the screen and the sidecar credit them. */
	readonly source: string;
}

/** `POST /map-grid/cells` `{ bbox }`: the finest grid's values over a box, for the map layer and the MAP-zone threshold. */
export interface MapGridCellsRequest {
	/** `[west, south, east, north]`, degrees. */
	readonly bbox: readonly [number, number, number, number];
}

export interface MapGridCells {
	readonly dataset: string;
	readonly source: string;
	readonly cellDeg: number;
	/** Centre of the first value's cell (north-west corner of the block). */
	readonly originLon: number;
	readonly originLat: number;
	readonly cols: number;
	readonly rows: number;
	/** `rows × cols`, north to south, west to east; `null` = no value. */
	readonly values: readonly (number | null)[];
}

/** `GET /channels?bbox=w,s,e,n`: the DEM's terrain channels, drawn while the tributary tool is on. */
export interface ChannelCollection {
	readonly type: 'FeatureCollection';
	readonly features: readonly {
		readonly type: 'Feature';
		readonly properties: Record<string, unknown>;
		readonly geometry: { readonly type: 'LineString' | 'MultiLineString'; readonly coordinates: unknown };
	}[];
}

/** `POST /delineate`. */
export interface DelineateRequest {
	/** The click, `[lon, lat]`. */
	readonly point: readonly [number, number];
	/** The piece being split (the quaternary, or a piece of it). */
	readonly within: AreaGeometry;
}

/** IC-WBT's refusal codes, kept (subdivide.md § Hydrological split, step 2). */
export type DelineateRefusal = 'outside' | 'no_data' | 'off_channel' | 'too_small' | 'too_large' | 'larger_channel' | 'whole_quaternary';

export interface DemProvenance {
	readonly label: string;
	readonly fingerprint: string;
	readonly zoom: number;
}

export interface DelineateResponse {
	readonly tributary: AreaGeometry;
	/** `within − tributary`; may be a MultiPolygon. */
	readonly remainder: AreaGeometry;
	/** Geodesic polygon areas, km²; they add up to `area(within)`. */
	readonly tributaryKm2: number;
	readonly remainderKm2: number;
	/** The part of the catchment outside `within`, dropped and reported. */
	readonly outsideKm2: number;
	readonly outsidePct: number;
	/** Above 20 % `outsidePct`: the spec's sentence, else `null`. */
	readonly warning: string | null;
	/** How far the click moved to reach the channel, m. */
	readonly snapM: number;
	readonly dem: DemProvenance;
}

// ---------------------------------------------------------------------------
// The method: packages/wrsm/src/subdivide/
// ---------------------------------------------------------------------------

export type PieceRole = 'tributary' | 'zone' | 'remainder' | 'rest';

/** One piece of the quaternary before it is applied to the network. */
export interface PiecePlan {
	readonly role: PieceRole;
	readonly geometry: AreaGeometry;
	/** Geodesic polygon area, km². */
	readonly polygonKm2: number;
	/** `MAP⁰_i`, the chosen grid's mean over the piece, mm; typed by the user when the grid doesn't cover it. */
	readonly gridMapMm: number;
	readonly mapSource: 'grid' | 'typed';
	/**
	 * What of the land use lies in this piece, each a share (0–1) of the split
	 * module's total, adding to 1 over the pieces. Needed for a table whose
	 * `SplitPlan.shares` basis is `location`; `irrigation` is used when every
	 * piece gives it, else irrigated area goes by area share (subdivide.md
	 * §§ Fields, Routes). `damArea` defaults to `damCapacity`.
	 */
	readonly locationShares?: {
		readonly afforestation?: number;
		readonly alien?: number;
		readonly damCapacity?: number;
		readonly damArea?: number;
		readonly irrigation?: number;
	};
}

export type SplitRecord =
	| { readonly kind: 'tributary'; readonly click: readonly [number, number]; readonly snapM: number; readonly dem: DemProvenance; readonly outsideQuaternaryPct: number }
	| { readonly kind: 'zone-drawn' }
	| { readonly kind: 'zone-threshold'; readonly thresholdMm: number; readonly side: 'high' | 'low' };

/** How an SFR child or a piece of farm dams is shared out (subdivide.md §§ SFR, Routes). */
export type ShareBasis = 'area' | 'location';

export interface SplitPlan {
	/** The quaternary's code. */
	readonly quaternary: string;
	/** The runoff module split. */
	readonly module: ModuleRef;
	/** In order; 2 to 8 (B8). */
	readonly pieces: readonly PiecePlan[];
	readonly splits: readonly SplitRecord[];
	readonly grid: { readonly dataset: string; readonly cellDeg: number; readonly source: string };
	/** Series for a tributary, side by side for MAP zones (subdivide.md § Routes). */
	readonly layout: 'series' | 'sideBySide';
	readonly shares: { readonly afforestation: ShareBasis; readonly alien: ShareBasis; readonly dams: ShareBasis };
}

/** `A_i`, scaled to the module and rounded so they sum exactly (subdivide.md § Areas). */
export interface PieceAreas {
	readonly areasKm2: readonly number[];
	/** `A_module / Σ polygon km²`. */
	readonly scale: number;
	/** The sentence to show when `scale` is outside [0.95, 1.05], else `null`. */
	readonly warning: string | null;
}

export type ScalePieceAreas = (moduleKm2: number, polygonKm2: readonly number[]) => PieceAreas;

/** What the rewired network would look like, for the wizard's review step. */
export interface SplitPreview {
	readonly pieces: readonly { readonly role: PieceRole; readonly module: ModuleRef; readonly areaKm2: number; readonly outlet: boolean }[];
	/** New modules and routes, and rewiring the user must confirm, in plain language. */
	readonly changes: readonly string[];
	readonly messages: readonly string[];
}

export type PreviewSplit = (bundle: NetworkBundle, plan: SplitPlan) => SplitPreview;

export type IterationStep = 'start' | 'ratio' | 'secant' | 'bisect' | 'clamped';

/** One evaluation of `MAR(s)` (subdivide.md § The log). */
export interface CalibrationIteration {
	readonly n: number;
	readonly s: number;
	readonly maps: readonly number[];
	readonly marMm3: number;
	readonly errorPct: number;
	readonly step: IterationStep;
}

export interface CalibrationTarget {
	readonly marMm3: number;
	/** Rule 8: a hand-entered citation, or "natural MAR of the unsplit module (no WR2012 value entered)". */
	readonly source: string;
}

export interface CalibrationResult {
	readonly status: 'converged' | 'not_converged' | 'refused';
	/** Why, in plain language, unless `converged`. */
	readonly message: string | null;
	readonly iterations: readonly CalibrationIteration[];
	/** The accepted iteration, or the best one (smallest `|e|`); `null` only when refused. */
	readonly best: CalibrationIteration | null;
	/** The rounded MAPs and the MAR recomputed with them. */
	readonly finalMapsMm: readonly number[];
	readonly finalMarMm3: number | null;
	readonly period: { readonly startYear: HydroYear; readonly endYear: HydroYear };
}

/**
 * The D2 loop. Pure, runs only the pieces' runoff modules, over the `.RAN`
 * years before extension. Never throws for a method failure: that is
 * `status`.
 */
export type CalibrateMap = (bundle: NetworkBundle, plan: SplitPlan, target: CalibrationTarget) => CalibrationResult;

/** The unsplit module's natural MAR over the same period: the cross-check and the fallback target (D2a). */
export type UnsplitNaturalMar = (bundle: NetworkBundle, module: ModuleRef) => { readonly marMm3: number; readonly period: { readonly startYear: HydroYear; readonly endYear: HydroYear } };

export interface ApplySplitOptions {
	readonly calibration: CalibrationResult;
	readonly target: CalibrationTarget;
	readonly crossCheck: CalibrationTarget;
	/** "Use the best factor" on a calibration that didn't converge: recorded as such. */
	readonly acceptNotConverged?: boolean;
}

/** The bundle with the module split and rewired and the sidecar's `subdivisions` entry written. Throws with a plain-language message if an invariant fails. */
export type ApplySplit<B extends NetworkBundle = NetworkBundle> = (bundle: B, plan: SplitPlan, options: ApplySplitOptions) => B;

/** The MAP-zone geometry (zones.ts). */
export type ZoneFromThreshold = (cells: MapGridCells, within: AreaGeometry, thresholdMm: number, side: 'high' | 'low') => AreaGeometry | null;

/** `Z ∩ Q` and `Q − Z`, with geodesic areas; throws with the spec's message when either piece is under 1 km². */
export type SplitByZone = (within: AreaGeometry, zone: AreaGeometry) => {
	readonly zone: AreaGeometry;
	readonly rest: AreaGeometry;
	readonly zoneKm2: number;
	readonly restKm2: number;
};
