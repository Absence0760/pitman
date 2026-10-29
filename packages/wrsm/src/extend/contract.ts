/**
 * Round 4 contract for method A (docs/theory/extend.md), written by the
 * orchestrator before the round so three agents can build against it in
 * parallel: the backend's `POST /api/chirps/monthly` (4.2) returns
 * `ChirpsMonthly`, the engine's `src/extend/rain.ts` (4.3) implements
 * `FitRainfallExtension` / `ApplyRainfallExtension`, and the extension screen
 * (4.4) shows `ExtensionFit` and calls both. Signatures change here first,
 * by the orchestrator.
 */

import type { HydroYear, Monthly12, RainfallExtension, RainfallSeries, RunMessage, Twelve } from '../types.js';

// ---------------------------------------------------------------------------
// The wire: POST /api/chirps/monthly (docs/data.md § CHIRPS, extend.md §§ Steps 1–3)
// ---------------------------------------------------------------------------

/** A GeoJSON Polygon or MultiPolygon in WGS84 longitude/latitude. */
export type AreaGeometry =
	| { readonly type: 'Polygon'; readonly coordinates: readonly (readonly (readonly [number, number])[])[] }
	| { readonly type: 'MultiPolygon'; readonly coordinates: readonly (readonly (readonly (readonly [number, number])[])[])[] };

/** Request body of `POST /api/chirps/monthly`. */
export interface ChirpsMonthlyRequest {
	readonly area: AreaGeometry;
}

/** One calendar month of the area mean (extend.md § Step 3). */
export interface ChirpsMonth {
	/** Calendar year. */
	readonly year: number;
	/** Calendar month, 1 = January. */
	readonly month: number;
	/** Area-weighted mean monthly total, mm; `null` when valid cells carry < 90 % of the weight. */
	readonly mm: number | null;
}

/** Response of `POST /api/chirps/monthly`. */
export interface ChirpsMonthly {
	/** Every calendar month from January 1981 to `finalThrough`'s month, in order, none skipped. */
	readonly months: readonly ChirpsMonth[];
	/** Cells used (land cells the area touches, after removing all-NaN cells). */
	readonly cells: number;
	/** Share of the area's weight removed as sea / no-data cells, %. */
	readonly weightRemovedPct: number;
	/** Geodesic area of the request's geometry, km². */
	readonly areaKm2: number;
	/** Product name as the sidecar records it, e.g. "CHIRPS v3 rnl (final)". */
	readonly product: string;
	/** The copy's manifest `revision` (moves only when values change). */
	readonly revision: number;
	/** The copy's last final day, `YYYY-MM-DD` (end of the contiguous months held). */
	readonly finalThrough: string;
	/** Which store answered: IC-WBT's copy in AWS, or the local synthetic copy (local-first). */
	readonly source: 's3' | 'local';
}

// ---------------------------------------------------------------------------
// The method: packages/wrsm/src/extend/rain.ts (extend.md §§ Steps 4–8)
// ---------------------------------------------------------------------------

/** Why a factor is what it is (extend.md § Step 5 dry months, short overlap). */
export type FactorFlag = 'computed' | 'dryBoth' | 'chirpsDry' | 'noOverlapMonths' | 'shortOverlap';

/** One calendar month's factor and the overlap numbers behind it. */
export interface FactorFit {
	/** The computed factor `f_k` (1 when it can't be estimated, see `flag`). */
	readonly computed: number;
	readonly flag: FactorFlag;
	/** Plain-language note for the screen ('' when nothing to say). */
	readonly note: string;
	/** Overlap years used for this month (`|O_k|`). */
	readonly years: number;
	/** Overlap means of `r` (the file's % MAP) and `p` (CHIRPS % of its MAP). */
	readonly meanFilePct: number;
	readonly meanChirpsPct: number;
}

/** Fit numbers before (`p`) and after (`f·p`) correction (extend.md § Fit diagnostics). */
export interface FitStatistics {
	readonly monthlyR2: number;
	readonly monthlyNse: number;
	readonly annualR2: number;
	/** Per month, `100·(Σp − Σr)/Σr`, October first; `null` where `Σr` is 0. */
	readonly monthlyBiasPct: Twelve<number | null>;
	readonly annualBiasPct: number;
}

/** What `fitRainfallExtension` returns: everything the screen shows before the user applies. */
export interface ExtensionFit {
	/** CHIRPS MAP (`MAP_c`, mm) and the complete hydrological years it averages. */
	readonly chirpsMapMm: number;
	readonly chirpsMapYears: { readonly startYear: HydroYear; readonly endYear: HydroYear };
	/** CHIRPS as % of `MAP_c` by hydrological year, October first; `null` = missing month. */
	readonly chirpsPct: readonly { readonly year: HydroYear; readonly months: Twelve<number | null> }[];
	/** The overlap used (D5): `window` says whether the user narrowed it. */
	readonly overlap: { readonly startYear: HydroYear; readonly endYear: HydroYear; readonly window: 'default' | 'user' };
	readonly factors: Twelve<FactorFit>;
	/** Fit statistics with the computed factors (`after`) and without (`before`). */
	readonly before: FitStatistics;
	readonly after: FitStatistics;
	/**
	 * Years that would be appended with these factors: from the file's last
	 * year + 1 to `lastYear`, or `null` when there is nothing to append.
	 * `stoppedAt` names the first missing month that stopped it, if any.
	 */
	readonly appendable: { readonly firstYear: HydroYear; readonly lastYear: HydroYear } | null;
	readonly stoppedAt: { readonly year: HydroYear; readonly month: number } | null;
	/** Warnings and refusals in plain language (short overlap, coast, few cells, …). */
	readonly messages: readonly RunMessage[];
}

export interface FitOptions {
	/** D5: narrow the overlap to these hydrological years (inclusive). Default: the whole overlap. */
	readonly overlap?: { readonly startYear: HydroYear; readonly endYear: HydroYear };
}

/** How the engine treats a factor value the user typed (extend.md § Step 6). */
export type FactorCheck = 'ok' | 'warn' | 'confirmZero' | 'refused';

/** Where the extended area and data came from, for the sidecar (rule 8, extend.md § Step 8). */
export interface ExtensionProvenance {
	/** The `.RAN` file name as the network names it. */
	readonly file: string;
	/** Quaternary codes the area was built from (may be empty for an uploaded or drawn area). */
	readonly quaternaries: readonly string[];
	/** When the CHIRPS series was fetched, ISO date. */
	readonly accessed: string;
	/** Edit notes by month index (0 = October). */
	readonly factorNotes?: Readonly<Record<number, string>>;
}

/** What `applyRainfallExtension` returns. The original rows are never changed. */
export interface ExtensionResult {
	readonly series: RainfallSeries;
	/** The sidecar entry for this file. */
	readonly extension: RainfallExtension;
}

/**
 * Fit CHIRPS to a `.RAN` series (steps 4–5) and report what would be
 * appended. Throws an `Error` with a plain-language message when the method
 * refuses (no overlap, the file already reaches the present is *not* a
 * refusal: `appendable` is then `null`).
 */
export type FitRainfallExtension = (ran: RainfallSeries, chirps: ChirpsMonthly, options?: FitOptions) => ExtensionFit;

/**
 * Append the CHIRPS-derived years with `factors` (step 7; every factor must
 * pass `checkFactor` as not `'refused'`) and build the sidecar entry (step 8).
 */
export type ApplyRainfallExtension = (
	ran: RainfallSeries,
	chirps: ChirpsMonthly,
	fit: ExtensionFit,
	factors: Monthly12,
	provenance: ExtensionProvenance
) => ExtensionResult;
