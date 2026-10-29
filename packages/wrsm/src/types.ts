/**
 * The typed contract for the WRSM/Pitman rebuild.
 *
 * Every later round builds on these types: readers turn WRSM2000 text files
 * into them, the engine runs on them, writers turn them back into files.
 *
 * Sources (cited per field):
 * - TT 691/16, WRSM/Pitman Programmer's Code Manual: ch.12 file structure
 *   (§12.1 runoff L.001–L.040, §12.2 channel, §12.3 reservoir, §12.4
 *   irrigation, §12.6 network, §12.7 rainfall) and the class data records
 *   (§7.3 Route_Type, §7.4 Runoff_Type, §7.5 Irrig_Type, §7.6 Dam_Type).
 * - TT 689/16, User Manual: §2.3 file naming, §4.5 answer files, §4.6 demand
 *   files.
 * - Issue #3 (methods A and B, rule 8) for the run modes and the sidecar.
 *
 * Conventions:
 * - "L.0nn" is a TT 691 ch.12 line type of the file the type comes from.
 *   "v1", "v2" after it are the variable numbers on that line.
 * - Monthly arrays are hydrological-year order: index 0 = October,
 *   index 11 = September (TT 691 §12.1 L.004 "starting in October").
 * - Units are in the field name where it is unambiguous (`areaKm2`, `mapMm`,
 *   `volumeMm3` = million m³) and in the comment otherwise. "unit not stated"
 *   means TT 691 does not give one; docs/formats.md (agent 1.4) settles it.
 * - Everything is readonly. The engine never mutates its inputs.
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Exactly twelve values, October first (TT 691 §12.1 L.004). */
export type Twelve<T> = readonly [T, T, T, T, T, T, T, T, T, T, T, T];

/** Twelve monthly numbers, October first. */
export type Monthly12 = Twelve<number>;

/**
 * A hydrological year label: the calendar year in which its October falls,
 * so `1920` is October 1920 to September 1921. .RAN, .obs and .ANS rows are
 * labelled this way (TT 691 §12.7.2; rows start in October).
 */
export type HydroYear = number;

/** One year/value pair, the Fortran `YearValue_Type` (TT 691 §7.4). */
export interface YearValue {
	readonly year: HydroYear;
	readonly value: number;
}

/**
 * A table of year/value pairs, stored as "N, then N years, then N values"
 * (e.g. RU L.006–L.008). The model interpolates between the years
 * (docs/theory, Round 6). Years ascend.
 */
export type YearTable = readonly YearValue[];

/**
 * A module type code as it appears in the .NET module list (L.008) and in
 * module file names (TT 689 §2.3.1): RU runoff, RR irrigation, RV
 * reservoir, CR channel reach, MM mine.
 */
export type ModuleTypeCode = 'RU' | 'RR' | 'RV' | 'CR' | 'MM';

/**
 * A module's identity. Numbers are unique only within a type: a network can
 * hold both reservoir 23 and channel reach 23 (TT 689 §2.3.1 naming).
 */
export interface ModuleRef {
	readonly type: ModuleTypeCode;
	/** External (user-defined) module number, 1–4 digits (TT 689 §2.3.1). */
	readonly number: number;
}

/** A source line kept verbatim so a writer can reproduce it. */
export interface RawLine {
	/** 1-based line number in the file it was read from. */
	readonly line: number;
	/** The line's text without its line ending. */
	readonly text: string;
}

// ---------------------------------------------------------------------------
// Network file (.NET), TT 691 §12.6
// ---------------------------------------------------------------------------

/** One entry of the .NET module list (L.008), e.g. `12RUY`. */
export interface NetworkModuleEntry {
	/** L.008: module number. */
	readonly number: number;
	/** L.008: type code. */
	readonly type: ModuleTypeCode;
	/** L.008: trailing Y (solve) or N (skip). */
	readonly solve: boolean;
}

/** An observation point: a route with an observed-flow file (L.009–L.011). */
export interface Gauge {
	/** L.010 v1: route number of the observation point. */
	readonly route: number;
	/**
	 * L.010 v2: gauge label in quotes, padded with spaces in real files.
	 * Not described in TT 691 §12.6 but present in its example and in real
	 * files; `''` when the file has none.
	 */
	readonly label: string;
	/** L.011: observed-flow file name (in the input directory). */
	readonly observedFile: string;
}

/**
 * A route: a lossless link from one module to another (TT 691 §7.3).
 *
 * The endpoints are **positions in the .NET module list** (1-based, L.008
 * order), not module numbers: TT 691 §12.6 L.014 says "the source module
 * number as it appears in the list of line type 8's". 0 means the route
 * starts or ends outside the network.
 */
export interface Route {
	/** L.014 v1: external route number. */
	readonly number: number;
	/** L.014 v2: 1-based position in `Network.modules` of the upstream (tail) module, 0 = none. */
	readonly upstreamPosition: number;
	/** L.014 v3: 1-based position in `Network.modules` of the downstream (head) module, 0 = none. */
	readonly downstreamPosition: number;
	/** L.014 v4: route cost, a reserved dummy (always 0 per TT 691). */
	readonly cost: number;
}

/** One summary-file request (L.016). */
export interface SummaryLine {
	/** L.016 v1: 'RT' for a route or 'RV' for a reservoir. */
	readonly kind: 'RT' | 'RV';
	/** L.016 v2: route or reservoir number. */
	readonly number: number;
	/** L.016 v3: quantity code, 'Q' in every known file. */
	readonly quantity: string;
}

/** The parsed .NET file (TT 691 §12.6). */
export interface Network {
	/** L.001 v1: network code, 1–3 characters; the prefix of every module file name. */
	readonly code: string;
	/** L.001 v2: network file storage version. */
	readonly fileVersion: number;
	/** L.002: input directory as written (a Windows path, may contain spaces, unquoted). */
	readonly inputDirectory: string;
	/** L.003: output directory as written. */
	readonly outputDirectory: string;
	/**
	 * Round 2 addition: the blank-padded width of the L.002 and L.003 lines
	 * when it is not WRSM2000's 287 columns (a hand-edited file keeps its old
	 * padding; docs/formats.md §4, U-6). Absent means 287. The directories
	 * above are stored without the padding.
	 */
	readonly directoryLineWidths?: { readonly input: number; readonly output: number };
	/** L.004: debug indicator, 'N', 'D' or 'Y' (obsolete, kept for round-trip). */
	readonly debug: string;
	/** L.005: debug period in months; present only when `debug` is 'D' or 'Y'. */
	readonly debugPeriod?: { readonly start: number; readonly end: number };
	/** L.006: write a .SUM summary file (Y/N). */
	readonly summaryFile: boolean;
	/** L.007 count + L.008 list, in solve order. */
	readonly modules: readonly NetworkModuleEntry[];
	/** L.009 count + L.010/L.011 pairs. */
	readonly gauges: readonly Gauge[];
	/** L.012 v1: first hydrological year to simulate. */
	readonly startYear: HydroYear;
	/** L.012 v2: last hydrological year to simulate (at most 150 years, TT 691 §12.6). */
	readonly endYear: HydroYear;
	/** L.013 count + L.014 list. */
	readonly routes: readonly Route[];
	/** L.015 count + L.016 list. */
	readonly summaryLines: readonly SummaryLine[];
}

// ---------------------------------------------------------------------------
// Runoff module (RU .DAT), TT 691 §12.1 and §7.4
// ---------------------------------------------------------------------------

/**
 * RU file versions documented by TT 691 §12.1 (0 when L.001 has no
 * version). Version 8 adds a daily rainfall file name (TT 691 §11.15) and
 * is out of scope: a reader returns it as an `UnparsedModule`.
 */
export type RunoffFileVersion = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

/**
 * One set of Pitman parameters (TT 691 §7.4: POW … R, plus FF). A runoff
 * file holds one set per groundwater model: classic (L.003), Hughes (L.023)
 * and Sami (L.035) (`A_POW(NGWMODELS)` etc.); the model in use selects one.
 */
export interface PitmanParameters {
	/** v1: power of the soil moisture / subsurface flow equation (dimensionless). */
	readonly POW: number;
	/** v2: soil moisture state below which subsurface flow is zero, mm. */
	readonly SL: number;
	/** v3: soil moisture capacity, mm. */
	readonly ST: number;
	/** v4: subsurface flow at full soil moisture capacity, mm/month. */
	readonly FT: number;
	/** v5: maximum groundwater flow, mm/month. */
	readonly GW: number;
	/** v6: minimum catchment absorption rate, mm/month. */
	readonly ZMIN: number;
	/** v7: maximum catchment absorption rate, mm/month. */
	readonly ZMAX: number;
	/** v8: interception storage, mm. */
	readonly PI: number;
	/** v9: lag of flow excluding groundwater, months. */
	readonly TL: number;
	/** v10: lag of groundwater flow, months. */
	readonly GL: number;
	/** v11: coefficient in the evaporation / soil moisture equation (dimensionless). */
	readonly R: number;
	/** v12: forest factor FF (dimensionless). */
	readonly FF: number;
}

/** RU L.006 v2 FORESTALG (TT 691 §12.1). */
export type AfforestationAlgorithm =
	| 0 // Van der Zel (always, for file version 0)
	| 1 // CSIR
	| 2 // Smoothed Gush/Pitman
	| 3 // LUT Gush
	| 4; // User-defined reduction

/** Area percentage and rotation of one plantation genus (RU L.009). */
export interface PlantationShare {
	/** Percentage of the afforested area, %. */
	readonly percent: number;
	/** Crop rotation period, years. */
	readonly rotationYears: number;
}

/** Afforestation, RU L.006–L.010. */
export interface Afforestation {
	/**
	 * L.006 v2: algorithm. Absent from version-0 files, where Van der Zel is
	 * implied; a reader sets 0 and `algorithmInFile` false.
	 */
	readonly algorithm: AfforestationAlgorithm;
	/** Whether L.006 v2 was present (false only for version 0). */
	readonly algorithmInFile: boolean;
	/** L.006 v1 (NYRF) + L.007 years + L.008 afforested area, km². */
	readonly areaKm2: YearTable;
	/** L.009 (NYRF > 0 and version > 0): pine, eucalyptus, wattle shares. */
	readonly species?: {
		readonly pine: PlantationShare;
		readonly eucalyptus: PlantationShare;
		readonly wattle: PlantationShare;
	};
	/** L.010 v1 (NYRF > 0 and version > 0): % of forest area considered optimal. */
	readonly optimalPercent?: number;
	/**
	 * L.010 v2–v3: only for an SFR child with algorithm 4 (user-defined):
	 * reductions for MAR and for low flows (UD_TPRM, UD_TPRL, TT 691 §7.4.2).
	 * Unit not stated; % assumed.
	 */
	readonly userDefinedReduction?: {
		readonly marPercent: number;
		readonly lowFlowPercent: number;
	};
}

/** RU L.011 v2 VEGETATIONALG (TT 691 §12.1). */
export type AlienVegetationAlgorithm =
	| 0 // None
	| 1 // CSIR
	| 2; // Riparian

/** Area percentage and age of one alien vegetation class (RU L.014). */
export interface AlienVegetationShare {
	/** Percentage of the alien vegetation area, %. */
	readonly percent: number;
	/** Age, years. */
	readonly ageYears: number;
}

/** Alien vegetation, RU L.011–L.015 (file version > 0). */
export interface AlienVegetation {
	/** L.011 v2: algorithm. */
	readonly algorithm: AlienVegetationAlgorithm;
	/**
	 * L.011 v3: "area of catchment covered by riparian vegetation" (F7.2):
	 * the **% of the alien vegetation area** in the riparian zone (TT 691
	 * §7.4.2 RipVegAreaPerc; U-21 resolved in Round 6, docs/theory/alien.md).
	 */
	readonly riparianArea: number;
	/** L.011 v1 (NYRA) + L.012 years + L.013 alien vegetation area, km² (unit inferred from the afforestation analogue). */
	readonly areaKm2: YearTable;
	/** L.014 (NYRA > 0): tall trees, medium trees, tall shrubs. */
	readonly composition?: {
		readonly tallTrees: AlienVegetationShare;
		readonly mediumTrees: AlienVegetationShare;
		readonly tallShrubs: AlienVegetationShare;
	};
	/** L.015 (NYRA > 0): % of alien vegetation area considered optimal. */
	readonly optimalPercent?: number;
}

/** Paved area, RU L.016–L.018. */
export interface PavedArea {
	/** L.016 (NYRP) + L.017 years + L.018 paved area as a proportion (0–1) of the catchment. */
	readonly fraction: YearTable;
}

/** One RU outflow route (L.020). */
export interface RunoffOutflow {
	/** L.020 v1: outflow route number. */
	readonly route: number;
	/** L.020 v2: percentage of the catchment's total outflow sent down this route, %. */
	readonly percent: number;
}

/** RU L.022 v1: groundwater model (TT 691 §12.1, GWMODEL in §7.4). */
export type GroundwaterModel =
	| 0 // Classic Pitman
	| 1 // Hughes
	| 2; // Sami

/** An annual groundwater abstraction with its monthly split (RU L.027–L.030). */
export interface HughesAbstraction {
	/** Annual abstraction (GWAbstr1/2: Ml/year per TT 691 §7.4). */
	readonly annual: number;
	/** 12 monthly demands as % of the annual total. */
	readonly monthlyPercent: Monthly12;
}

/**
 * Hughes groundwater parameters, RU L.022 v2–v5 and L.023–L.030 (file
 * version > 2; TT 690 ch.7). Kept whichever model is selected, so a file
 * round-trips and a user can switch models.
 */
export interface HughesParameters {
	/** L.022 v2: HGSL, storage below which there is no recharge, mm. */
	readonly HGSL: number;
	/** L.022 v3: GPOW, power of the storage/recharge curve. */
	readonly GPOW: number;
	/** L.022 v4: TLGMax, maximum channel loss over the channel length, mm. */
	readonly TLGMax: number;
	/** L.022 v5 (version ≥ 4): HGGW, maximum recharge rate, mm/month. */
	readonly HGGW?: number;
	/** L.023 (version > 3): Pitman parameters used with the Hughes model. */
	readonly pitman?: PitmanParameters;
	/** L.024 v1 (version > 3): derive drainage density from the number of reaches. */
	readonly useReachesForDrainageDensity?: boolean;
	/** L.024 v2 (version > 3): drainage density (unit not stated; km/km² assumed). */
	readonly drainageDensity?: number;
	/** L.025 v1: number of reaches in the catchment. */
	readonly reaches: number;
	/** L.025 v2: riparian width as % of the slope width, %. */
	readonly riparianWidthPercent: number;
	/** L.025 v3: riparian strip factor (fraction, typically 0.001–0.05, TT 691 §7.4). */
	readonly riparianStripFactor: number;
	/** L.025 v4: rest water level below the channel, m (stored positive, used negative, TT 691 §7.4). */
	readonly restWaterLevelM: number;
	/** L.025 v5: transmissivity, m²/day (TT 691 §7.4). */
	readonly transmissivityM2PerDay: number;
	/** L.025 v6: storativity (dimensionless). */
	readonly storativity: number;
	/** L.026: initial groundwater slope for the upper and riparian zones. */
	readonly initialGroundwaterSlope: number;
	/** L.027 + L.028: upper-zone abstraction. */
	readonly upperAbstraction: HughesAbstraction;
	/** L.029 + L.030: riparian-zone abstraction. */
	readonly riparianAbstraction: HughesAbstraction;
}

/**
 * RU L.034 v5, `AbstractionsOn`. Before October 2014 a logical (0/1); from
 * then 0 none, 1 annual year table (L.036/L.037), 2 a time-series file of
 * abstractions (TT 691 §11.21, p.145). Some WR2005 files have annual
 * abstractions with this flag 0: the reader must act on the L.036 count, as
 * the old program did (the p.145 quirk).
 */
export type SamiAbstractionMode = 0 | 1 | 2;

/**
 * Sami groundwater parameters, RU L.031–L.037 (file version > 3; TT 690
 * ch.8, TT 687). The bracketed names are the TT 691 §7.4 variables. Some
 * slots mean different things in Sami method 1 and method 2; the field is
 * named for method 2 (the method the reference network uses) and the
 * comment gives the method-1 meaning.
 */
export interface SamiParameters {
	/** L.031 v1: aquifer thickness (B8_AquiferThick), m. */
	readonly aquiferThicknessM: number;
	/** L.031 v2: storativity (B9_Storativity), dimensionless. */
	readonly storativity: number;
	/** L.031 v3: initial aquifer storage (B11_AquiferStor), unit not stated. */
	readonly initialAquiferStorage: number;
	/** L.031 v4: static water level (B13_StatWaterLevel), mm (TT 689 p.43: "a default of 60 mm"; renamed from `staticWaterLevelM` in Round 6). */
	readonly staticWaterLevelMm: number;
	/** L.031 v5: unsaturated storage (D7_Unsat, method 2) or decay (D7_Decay, method 1). */
	readonly unsaturatedStorage: number;
	/** L.032 v1: initial unsaturated-zone storage (D8_STinit, method 2) or growth % (D8_GrowthPerc, method 1). */
	readonly initialUnsaturatedStorage: number;
	/** L.032 v2: percolation power PPOW (D13_PPOW, method 2) or initial baseflow (D13_InitBaseFlow, method 1). */
	readonly PPOW: number;
	/** L.032 v3: GPOW (D16_GPOW). */
	readonly GPOW: number;
	/** L.032 v4: maximum discharge rate (B21_MaxDischRate). */
	readonly maxDischarge: number;
	/** L.032 v5: power of the groundwater/surface water interaction curve (B22_GWSW_ICP). */
	readonly gwSwPower: number;
	/** L.032 v6: HGSL, no recharge below this storage (B17_HGSL), mm. */
	readonly HGSL: number;
	/** L.032 v7: HGGW, maximum recharge rate (D15_HGGW), mm/month. */
	readonly HGGW: number;
	/** L.033 v1: maximum hydraulic gradient (B23_MaxHydGrad). */
	readonly maxHydraulicGradient: number;
	/** L.033 v2: transmissivity (D21_Transmissivity), m²/day assumed. */
	readonly transmissivity: number;
	/** L.033 v3: borehole distance to the river (D22_DistToRiver), m assumed. */
	readonly boreholeDistanceToRiver: number;
	/** L.033 v4: groundwater evaporation area (B28_GWEvapArea), km² assumed. */
	readonly gwEvaporationArea: number;
	/** L.034 v1: K2 (D24_K2). */
	readonly K2: number;
	/** L.034 v2: K3 (D25_K3). */
	readonly K3: number;
	/** L.034 v3: interflow lag (F28_Lag), months assumed. */
	readonly interflowLag: number;
	/** L.034 v4: number of months over which recharge is averaged (D9_MMA). */
	readonly rechargeAveragingMonths: number;
	/** L.034 v5: abstraction mode as saved (AbstractionsOn); see `SamiAbstractionMode`. */
	readonly abstractionMode: SamiAbstractionMode;
	/** L.035: Pitman parameters used with the Sami model. */
	readonly pitman: PitmanParameters;
	/** L.036 (NYGA) + L.037 year/abstraction pairs, million m³ (TGWAbst, TT 691 §7.4). */
	readonly abstractions: YearTable;
}

/** A parsed runoff module file, `<net>RU<n>.DAT` (TT 691 §12.1). */
export interface RunoffModule {
	readonly kind: 'RU';
	/** L.001 v1: module number (NRUEN). */
	readonly number: number;
	/** L.001 v2: module name, at most 20 characters (RUNAM). */
	readonly name: string;
	/** L.001 v3: file version; 0 when absent. */
	readonly fileVersion: RunoffFileVersion;
	/** Whether L.001 v3 was present (version-0 files may omit it). */
	readonly fileVersionInFile: boolean;
	/** L.002 v1: catchment area, km². */
	readonly areaKm2: number;
	/** L.002 v2: catchment MAP, mm (written as an integer, I4). */
	readonly mapMm: number;
	/** L.002 v3: rainfall (% MAP) file name, in the input directory. */
	readonly rainfallFile: string;
	/** L.003: classic Pitman parameters. */
	readonly pitman: PitmanParameters;
	/** L.004: monthly Symons-pan evaporation, mm. */
	readonly sPanMm: Monthly12;
	/** L.005: monthly pan factors (dimensionless). */
	readonly panFactors: Monthly12;
	/** L.006–L.010: afforestation. */
	readonly afforestation: Afforestation;
	/** L.011–L.015 (version > 0): alien vegetation. */
	readonly alienVegetation?: AlienVegetation;
	/**
	 * L.016–L.018: paved area. TT 691 does not say from which version these
	 * lines exist; the reader treats them like L.011 (version > 0).
	 */
	readonly paved?: PavedArea;
	/** L.019 count + L.020 list. Percentages sum to 100. */
	readonly outflows: readonly RunoffOutflow[];
	/** L.021 v1 (version > 2): inflow route from upstream, 0 = none (RTIN; only one allowed). */
	readonly inflowRoute?: number;
	/** L.021 v2 (version > 2): number of the runoff module whose groundwater feeds this one, 0 = none (UpStrRunoffModule). */
	readonly upstreamGroundwaterModule?: number;
	/** L.022 v1 (version > 2): groundwater model in use; classic when absent. */
	readonly groundwaterModel?: GroundwaterModel;
	/** L.022 v2–v5, L.023–L.030 (version > 2): Hughes parameters. */
	readonly hughes?: HughesParameters;
	/** L.031–L.037 (version > 3): Sami parameters. */
	readonly sami?: SamiParameters;
	/**
	 * L.038 v1: produce naturalised flows on the next run (last setting saved).
	 * Present in version-7 files; the version that introduced L.038–L.040 is
	 * not stated in TT 691.
	 */
	readonly naturalised?: boolean;
	/**
	 * L.038 v2 count + L.039: module numbers of this module's SFR children
	 * (TT 691 §7.4.2 MyChilds). Real files write one child per line. A
	 * child does not name its parent: parenthood is derived from this list.
	 */
	readonly sfrChildren?: readonly number[];
	/** L.040: monthly A-pan factors (12 × F4.2). */
	readonly aPanFactors?: Monthly12;
	/** Lines after the last line type the reader understood, kept for round-trip. */
	readonly trailingLines?: readonly RawLine[];
	/** Write-layout variants that carry no meaning; absent = WRSM2000's usual layout. */
	readonly layout?: RunoffLayout;
}

/**
 * Widths that differ between real runoff files without changing a value
 * (docs/formats.md §5.1), kept so a file read and written back is
 * byte-identical. Added in Round 2 (runoff files).
 */
export interface RunoffLayout {
	/** L.031 vars 3–5 written `3F7.2` instead of `3F8.2` (31 real files). */
	readonly samiStorageNarrow?: boolean;
}

// ---------------------------------------------------------------------------
// Reservoir module (RV .DAT), TT 691 §12.3 and §7.6
// ---------------------------------------------------------------------------

/** One year of reservoir capacity data (RV L.004–L.006 columns). */
export interface ReservoirCapacity {
	/** L.004: year. */
	readonly year: HydroYear;
	/** L.005: full supply volume, million m³. */
	readonly fullSupplyVolumeMm3: number;
	/** L.006: surface area at full supply volume, km². */
	readonly fullSupplyAreaKm2: number;
}

/** A route into or out of a module that may carry a defined-flow file. */
export interface RouteConnection {
	/** Route number. */
	readonly route: number;
	/**
	 * Defined-flow file for the route, in quotes. `null` when the file has a
	 * blank name (`' '`, or `'b'` in TT 691's notation): the model simulates
	 * the route. `'*'` on a reservoir outflow marks a monthly defined
	 * abstraction (see `ReservoirOutflow.monthlyAbstraction`).
	 */
	readonly definedFlowFile: string | null;
}

/** A reservoir outflow (L.013), optionally a monthly defined abstraction (L.014). */
export interface ReservoirOutflow extends RouteConnection {
	/**
	 * L.014, present when `definedFlowFile` is `'*'` (TT 691 §12.3 note):
	 * monthly volumes taken while storage is above a threshold, reduced by a
	 * factor below it. RVRES / RVRF in TT 691 §7.6.
	 */
	readonly monthlyAbstraction?: {
		/** L.014 v1–v12: abstraction per month, million m³. */
		readonly volumesMm3: Monthly12;
		/** L.014 v13: storage at the start of the month above which the full volume is taken, million m³. */
		readonly fullSupplyAboveMm3: number;
		/** L.014 v14: factor on the demand when storage is below that, 0–1. */
		readonly restrictionFactor: number;
	};
}

/** A parsed reservoir module file, `<net>RV<n>.DAT` (TT 691 §12.3). Has no file version. */
export interface ReservoirModule {
	readonly kind: 'RV';
	/** L.001 v1: module number (NRVEN). */
	readonly number: number;
	/** L.001 v2: name (RVNAM). */
	readonly name: string;
	/** L.002 v1: MAP, mm. */
	readonly mapMm: number;
	/** L.002 v2: rainfall (% MAP) file name. */
	readonly rainfallFile: string;
	/** L.002 v3: power p in surface area = k·volume^p (RVPOW). */
	readonly areaVolumePower: number;
	/** L.003 count + L.004–L.006 columns. */
	readonly capacity: readonly ReservoirCapacity[];
	/** L.007: monthly pan evaporation, mm (pan type left to the user). */
	readonly panMm: Monthly12;
	/** L.008: monthly pan factors, giving lake evaporation with `panMm`. */
	readonly panFactors: Monthly12;
	/** L.009: spillage route number. */
	readonly spillRoute: number;
	/** L.010 count + L.011 list. */
	readonly inflows: readonly RouteConnection[];
	/** L.012 count + L.013 (+ L.014) list. */
	readonly outflows: readonly ReservoirOutflow[];
	/**
	 * L.015 (optional): initial storage, million m³. Absent (or the sentinel
	 * the manual prints as "01.00", read as -1) means 50 % of full supply.
	 */
	readonly initialStorageMm3?: number;
	/**
	 * Layout only, no meaning: the file wrote its `L5` count and route lines
	 * (L.009, L.010, L.012) without WRSM2000's 5-column padding, as 7 real
	 * RV files do (docs/formats.md §6, U-10). The writer reproduces it so
	 * those files round-trip byte for byte. Absent = padded.
	 */
	readonly unpaddedRouteLines?: boolean;
}

// ---------------------------------------------------------------------------
// Channel reach module (CR .DAT), TT 691 §12.2
// ---------------------------------------------------------------------------

/** CR L.011 v2. */
export type WetlandType =
	| 0 // no wetland
	| 1 // basic wetland
	| 2 // comprehensive wetland
	| 3; // diversion channel

/** A parsed channel reach file, `<net>CR<n>.DAT` (TT 691 §12.2). */
export interface ChannelModule {
	readonly kind: 'CR';
	/** L.001 v1: module number. */
	readonly number: number;
	/** L.001 v2: name, at most 20 characters. */
	readonly name: string;
	/** L.001 v3: file version (2 for files written since January 2006). */
	readonly fileVersion: number;
	/** L.002 v1: MAP over the wetland, mm; 0 when there is no wetland. */
	readonly wetlandMapMm: number;
	/** L.002 v2: rainfall (% MAP) file for the wetland; `null` when blank. */
	readonly wetlandRainfallFile: string | null;
	/** L.003 v1: CHBL, monthly bed loss, million m³/month. */
	readonly bedLossMm3PerMonth: number;
	/** L.003 v2: CHC1, wetland/aquifer storage when full, million m³. */
	readonly wetlandStorageMm3: number;
	/** L.003 v3: CHC2, wetland/aquifer area when full, km². */
	readonly wetlandAreaKm2: number;
	/** L.003 v4: CHC3, recharge coefficient (1 except for transmissivity-limited aquifers, ~0.1). */
	readonly rechargeCoefficient: number;
	/** L.004: monthly pan evaporation, mm. Dummies when there is no wetland. */
	readonly panMm: Monthly12;
	/** L.005: monthly pan factors. Dummies when there is no wetland. */
	readonly panFactors: Monthly12;
	/** L.006: principal outflow route. */
	readonly principalOutflowRoute: number;
	/** L.007 count + L.008 list. */
	readonly inflows: readonly RouteConnection[];
	/** L.009 count + L.010 list. */
	readonly outflows: readonly RouteConnection[];
	/** L.011 v1: reserved, always 1. */
	readonly reserved: number;
	/** L.011 v2: wetland type. */
	readonly wetlandType: WetlandType;
	/**
	 * L.012: comprehensive-wetland geometry. TT 691 describes it for type 2,
	 * but version-2 files write L.012–L.017 for every type.
	 */
	readonly comprehensiveWetland?: {
		/** v1: wetland area at bankfull level, km². */
		readonly bankfullAreaKm2: number;
		/** v2: wetland volume at bankfull level, million m³. */
		readonly bankfullVolumeMm3: number;
		/** v3: power of the area–volume relationship. */
		readonly areaVolumePower: number;
		/** v4: bankfull capacity of the river channel, million m³/month assumed. */
		readonly channelBankfullCapacity: number;
		/** v5: proportion of flow above bankfull that enters the wetland, 0–1. */
		readonly excessToWetland: number;
		/** v6: proportion of wetland volume above bankfull returned to the channel, 0–1. */
		readonly wetlandToChannel: number;
	};
	/** L.013: QDIV, reserved, always 0.0. */
	readonly qdiv?: number;
	/** L.014: local wetland inflow route, 0 = none. */
	readonly localWetlandInflowRoute?: number;
	/** L.015: local wetland outflow/abstraction route, 0 = none. */
	readonly localWetlandOutflowRoute?: number;
	/** L.016: diversion outflow route, 0 = none. */
	readonly diversionRoute?: number;
	/** L.017: diversion channel settings. */
	readonly diversion?: {
		/** v1: bankfull capacity of the river channel, million m³/month assumed. */
		readonly bankfullCapacity: number;
		/** v2: diversion efficiency, 0–1. */
		readonly efficiency: number;
		/** v3: maximum monthly diversion, million m³/month (TT 691 §7.7 "mcm/month"). */
		readonly maxMonthlyMm3: number;
	};
	/**
	 * Layout only, no meaning: the file wrote its `L5` count and route lines
	 * (L.006, L.007, L.009) without the 5-column padding, as 38 real CR files
	 * do (docs/formats.md §7, U-10). The writer reproduces it. Absent = padded.
	 */
	readonly unpaddedRouteLines?: boolean;
	/** Lines after the last line type the reader understood. */
	readonly trailingLines?: readonly RawLine[];
}

// ---------------------------------------------------------------------------
// Irrigation module (RR .DAT), TT 691 §12.4 and §7.5
// ---------------------------------------------------------------------------

/**
 * RR L.002: the last model type used. 1 WRSM/Pitman, 2 WQT, 3 WQT-SAPWAT
 * (TT 691 §12.4), 4 WQT type 4 (the §12.4 "type 4" example).
 */
export type IrrigationModelType = 1 | 2 | 3 | 4;

/** A year table with its interpolation option (RR L.022/L.025/L.028/L.033). */
export interface InterpolatedYearTable {
	/**
	 * Interpolation option as stored in the file. The program stores
	 * `K + 1` (TT 691 §12.4 "KMA + 1"); the meaning of each code (linear,
	 * exponential, defined/none) is not tabulated in TT 691.
	 */
	readonly interpolation: number;
	readonly values: YearTable;
}

/** One crop's monthly factors (RR L.020). */
export interface IrrigationCrop {
	/** v1–v12: monthly crop factors. */
	readonly factors: Monthly12;
	/** v13: crop percentage of the irrigated area (CPF), %. */
	readonly percent: number;
	/** v14: crop description in quotes (CROP_TYPE). */
	readonly description: string;
}

/** RR L.001–L.012, common to every documented layout. */
export interface IrrigationCore {
	readonly kind: 'RR';
	/** L.001 v1: module number (NRREN). */
	readonly number: number;
	/** L.001 v2: name (RRNAM). */
	readonly name: string;
	/**
	 * L.001 v3: file version. Two digits: model family, then layout version
	 * (TT 691 §7.5 MODEL/VERSION, e.g. 32, 42). See `IrrigationModule.layout`.
	 */
	readonly fileVersion: number;
	/** L.002: last model type used. */
	readonly modelType: IrrigationModelType;
	/** L.003 v1: MAP over the irrigated area, mm. */
	readonly mapMm: number;
	/** L.003 v2: rainfall (% MAP) file name. */
	readonly rainfallFile: string;
	/** L.004 count + L.005 years + L.006 area under irrigation, km². */
	readonly areaKm2: YearTable;
	/** L.007: PINDEX, area irrigated in each month as a proportion of the total. */
	readonly pIndex: Monthly12;
	/** L.008: monthly pan evaporation, mm (usually A-pan). */
	readonly panMm: Monthly12;
	/** L.009: monthly pan/crop factors (APF; used by WQT type 4). */
	readonly panFactors: Monthly12;
	/** L.010 v1: maximum annual irrigation allocation, mm (Pitman method; 9999 = unlimited in practice). */
	readonly maxAnnualAllocationMm: number;
	/** L.010 v2–v13: monthly effective rainfall factors (EFFP). */
	readonly effectiveRainfallFactors: Monthly12;
	/** L.011: abstraction (inflow) route. */
	readonly abstractionRoute: number;
	/** L.012 v1: return flow route, 0 = none. */
	readonly returnFlowRoute: number;
	/** L.012 v2: return flow as % of the abstraction, %. */
	readonly returnFlowPercent: number;
}

/** The original Pitman irrigation layout: L.001–L.012 only. */
export interface IrrigationPitmanLayout extends IrrigationCore {
	readonly layout: 'pitman';
	readonly trailingLines?: readonly RawLine[];
}

/** The WQT / WQT-SAPWAT layout, L.001–L.030 (e.g. file version 32). */
export interface IrrigationWqtLayout extends IrrigationCore {
	readonly layout: 'wqt';
	/** L.003 v3: apply the drought reduction factor (DROUGHT_APPLICABLE). */
	readonly droughtReduction: boolean;
	/**
	 * L.003 v4: curtail by clipping high months (1) rather than reducing all
	 * months proportionally (0). Optional because 16 real v32 files leave it
	 * out (docs/formats.md D-10); absent behaves as 0 and is written absent,
	 * so those files round-trip byte for byte.
	 */
	readonly curtailByClipping?: boolean;
	/** L.013 v1: area interpolation option (KA + 1). */
	readonly areaInterpolation: number;
	/** L.013 v2: maximum water allocation, million m³/year (RRMA, WQT method). */
	readonly maxAllocationMm3PerYear: number;
	/** L.013 v3: number of water-allocation points (NPMA). */
	readonly allocationPoints: number;
	/** L.013 v4: water-allocation interpolation option (KMA + 1). */
	readonly allocationInterpolation: number;
	/** L.013 v5: runoff module the block lies in (IRRSW; TT 691 §7.5 calls it the related salt-washoff submodel). */
	readonly runoffModule: number;
	/** L.014 v1: proportion of transfer-canal seepage that returns to the return flow (TLSQRF). */
	readonly canalSeepageToReturn: number;
	/** L.014 v2: produce net (1) rather than total (0) return flows. */
	readonly netReturnFlows: boolean;
	/** L.015 v1: transfer canal, proportion of flow lost (RRTLPQ). */
	readonly canalFlowLoss: number;
	/** L.015 v2: transfer canal, proportion of salt lost (RRTLPS; salinity unused). */
	readonly canalSaltLoss: number;
	/** L.015 v3: irrigation efficiency factor (RRIE). */
	readonly efficiencyFactor: number;
	/** L.015 v4: return flow factor (RRLF). */
	readonly returnFlowFactor: number;
	/** L.015 v5: proportion of return flow from the upper zone (RRPRFU). */
	readonly returnFlowUpperZone: number;
	/** L.015 v6: proportion of return flow from the lower zone (RRPRFL). */
	readonly returnFlowLowerZone: number;
	/** L.015 v7–v10: salt parameters RRSCF, RRPSL, RRSLD(1), RRSLD(2) (salinity out of scope, kept for round-trip). */
	readonly saltParameters: readonly [number, number, number, number];
	/** L.016 v1–v2: initial salt load, upper and lower zone (RRSSUI, RRSSLI; unused). */
	readonly initialSaltLoad: readonly [number, number];
	/** L.016 v3: soil moisture capacity, upper zone, mm (RRHSU). */
	readonly soilMoistureCapacityUpperMm: number;
	/** L.016 v4: soil moisture capacity, lower zone, mm (RRHSL). */
	readonly soilMoistureCapacityLowerMm: number;
	/** L.016 v5: soil moisture target, mm (RRHT). */
	readonly soilMoistureTargetMm: number;
	/** L.016 v6: initial soil moisture, mm (RRHI). */
	readonly soilMoistureInitialMm: number;
	/** L.017: monthly (effective) rainfall factors (RRERF). */
	readonly rainfallFactors: Monthly12;
	/** L.018: A-pan factors used by WQT type 2 (APFWQ). */
	readonly aPanFactors: Monthly12;
	/** L.019 count + L.020 list. */
	readonly crops: readonly IrrigationCrop[];
	/** L.021 v1–v2: effective rainfall limits (RRERL1, RRERL2). */
	readonly effectiveRainfallLimits: readonly [number, number];
	/** L.022–L.024: water allocation by year (WAG; values are allocations, not growth). L.023/L.024 absent when the count is 0. */
	readonly allocation: InterpolatedYearTable;
	/** L.025–L.027: return-flow growth factors by year (RFG). */
	readonly returnFlowGrowth: InterpolatedYearTable;
	/** L.028–L.030: irrigation efficiency by year (IEG). */
	readonly efficiency: InterpolatedYearTable;
	readonly trailingLines?: readonly RawLine[];
}

/** WQT type 4, L.001–L.040 (e.g. file version 42). */
export interface IrrigationWqt4Layout extends Omit<IrrigationWqtLayout, 'layout'> {
	readonly layout: 'wqt4';
	/** L.031: minimum rainfall factors (RRERFT4; not used by the program). */
	readonly minRainfallFactors: Monthly12;
	/** L.032: maximum rainfall factors (RRERFMT4). */
	readonly maxRainfallFactors: Monthly12;
	/** L.033–L.035: capacity values by year (RRCAPT4; values, not growth). */
	readonly capacity: InterpolatedYearTable;
	/** L.036: canal transmission loss (RRTLPET4). */
	readonly canalTransmissionLoss: number;
	/** L.037: deep-seated groundwater (RRPDLT4). */
	readonly deepSeatedGroundwater: number;
	/** L.038: maximum allowed upper-zone storage, mm (RRHMAXT4). */
	readonly maxUpperZoneStorageMm: number;
	/** L.039: minimum allowed upper-zone storage, mm (RRHMINT4). */
	readonly minUpperZoneStorageMm: number;
	/** L.040: irrigation supply spilled from canal ends (RRPENDT4). */
	readonly canalEndSpill: number;
}

/**
 * A parsed irrigation file, `<net>RR<n>.DAT`. Which layout a file has is
 * decided by the reader from L.001 v3 and L.002 (docs/formats.md). A file
 * in no documented layout is an `UnparsedModule`.
 */
export type IrrigationModule = IrrigationPitmanLayout | IrrigationWqtLayout | IrrigationWqt4Layout;

// ---------------------------------------------------------------------------
// Modules the engine does not model (yet)
// ---------------------------------------------------------------------------

/**
 * A module file kept verbatim: a mine module (MM, TT 691 §12.5), or any
 * module whose file version or layout the readers don't know. A writer
 * writes `lines` back unchanged.
 */
export interface UnparsedModule {
	readonly kind: 'unparsed';
	readonly moduleType: ModuleTypeCode;
	/** L.001 v1, when it could be read. */
	readonly number: number;
	/** L.001 v2, when it could be read; `''` otherwise. */
	readonly name: string;
	/** L.001 v3, when present. */
	readonly fileVersion?: number;
	/** Why the reader didn't parse it, for the validation screen. */
	readonly reason: string;
	readonly lines: readonly RawLine[];
}

/** Any module of a network. Discriminate on `kind`. */
export type Module = RunoffModule | ReservoirModule | ChannelModule | IrrigationModule | UnparsedModule;

// ---------------------------------------------------------------------------
// Time series files
// ---------------------------------------------------------------------------

/**
 * A contiguous monthly series as the engine uses it: `values[12 * i + m]`
 * is month m (0 = October) of hydrological year `startYear + i`.
 */
export interface MonthlySeries {
	readonly startYear: HydroYear;
	/** 12 values per year, length a multiple of 12. */
	readonly values: readonly number[];
	/** Unit of every value. */
	readonly unit: SeriesUnit;
}

/** Units used by series in this contract. */
export type SeriesUnit =
	| 'percentMap' // % of MAP
	| 'mm'
	| 'Mm3' // million m³ (per month for flows)
	| 'Mm3PerMonth';

/**
 * Round 2 addition: the text a time-series file was read from. Hand-made
 * .RAN, .obs and defined-flow files use widths, decimals, flags and trailing
 * lines that no single layout reproduces (docs/formats.md §11.3–11.4), so a
 * reader keeps the source and a writer copies every row the caller has not
 * changed byte for byte; changed or new rows are written in the canonical
 * layout. Absent on series built in memory.
 */
export interface SeriesSource {
	/** Every physical line, without its line ending. */
	readonly lines: readonly string[];
	/** The file ended with a line ending. */
	readonly finalNewline: boolean;
}

/** One row of a year-by-month text file (.RAN, .obs, .ANS, defined-flow files). */
export interface MonthlyRow {
	readonly year: HydroYear;
	readonly months: Monthly12;
}

/**
 * A catchment rainfall file (.RAN): monthly rainfall as **% of MAP**,
 * hydrological years (TT 691 §12.7.2; TT 690 §1.3). Rainfall in mm is
 * `percentMap / 100 × MAP` of the module that uses it.
 */
export interface RainfallSeries {
	/** Column 1: rainfall zone / gauge code (e.g. a quaternary-group code), same on every row. */
	readonly code: string;
	/** Columns 2–14: year and 12 monthly % MAP values. Years ascend without gaps. */
	readonly rows: readonly MonthlyRow[];
	/** The file as read, for a byte-identical rewrite (Round 2 addition). */
	readonly source?: SeriesSource;
}

/** One row of an observed-flow file. */
export interface ObservedRow extends MonthlyRow {
	/** Per month: the value carried a trailing `+` (an incomplete month). */
	readonly incomplete: Twelve<boolean>;
	/** Column 14: annual total as written, million m³; `null` when absent. */
	readonly annualTotal: number | null;
	/** Column 14 carried a `+`. */
	readonly annualIncomplete: boolean;
}

/**
 * An observed-flow file (.obs, named in .NET L.011): monthly flow at a
 * gauge, million m³, with `+` marking an incomplete month. Years may have
 * gaps.
 */
export interface ObservedFlow {
	readonly rows: readonly ObservedRow[];
	/** The file as read, for a byte-identical rewrite (Round 2 addition). */
	readonly source?: SeriesSource;
}

/** One row of an answer file. */
export interface AnswerRow extends MonthlyRow {
	/** Column 14: annual total, million m³ (or the annual figure for the series' unit). */
	readonly annualTotal: number;
	/** Column 15: mean monthly value (annual total / 12). */
	readonly monthlyMean: number;
}

/**
 * An answer file (TT 689 §4.5): `<net>RQ<route>.ANS` for route flows or
 * `<net>RV<n>.ANS` for reservoir volumes, million m³. A trailer row
 * labelled AVERAGE holds the column means. The layout must be reproduced
 * byte for byte (Round 2).
 */
export interface AnswerFile {
	/** RQ = route flows, RV = reservoir storage. */
	readonly kind: 'RQ' | 'RV';
	/** Route or reservoir number (from the file name). */
	readonly number: number;
	readonly rows: readonly AnswerRow[];
	/** The AVERAGE trailer row, as written. */
	readonly average: {
		readonly months: Monthly12;
		readonly annualTotal: number;
		readonly monthlyMean: number;
	};
}

/**
 * How a demand series was authored in Pitman's demand editor (Round 7).
 * WRSM2000 only sees the generated file; this lives in the sidecar.
 */
export interface DemandSpec {
	/** Annual volume in the base year, million m³/year. */
	readonly annualVolumeMm3: number;
	/** Share of the annual volume in each month, % (sums to 100). */
	readonly monthlyDistributionPercent: Monthly12;
	/** Annual volume by year, million m³/year, interpolated linearly between years and held flat beyond them. */
	readonly growth: YearTable;
}

/**
 * A demand or defined-flow file: monthly volumes on a route, million m³.
 * Demand files have the .ANS layout (TT 689 §4.6, `<net>RQ<route>DEM`);
 * defined-flow files named on RV/CR route lines may have only year + 12
 * months.
 */
export interface DemandSeries {
	/** File name as referenced from the module or network. */
	readonly fileName: string;
	readonly rows: readonly MonthlyRow[];
	/** Whether rows carry the annual total and mean columns (.ANS layout). */
	readonly hasTotals: boolean;
	/** Whether the file ends with an AVERAGE trailer row. */
	readonly hasAverage: boolean;
	/** The file as read, for a byte-identical rewrite (Round 2 addition). */
	readonly source?: SeriesSource;
}

// ---------------------------------------------------------------------------
// A whole loaded network
// ---------------------------------------------------------------------------

/**
 * Everything read from a network folder. File-keyed records use the name
 * **upper-cased**: names are case-insensitive on Windows and real networks
 * reference `zero.RAN` for a file stored as `ZERO.RAN`.
 */
export interface NetworkBundle {
	readonly network: Network;
	/** One per .NET L.008 entry that has a file. */
	readonly modules: readonly Module[];
	/** .RAN files by upper-cased name. */
	readonly rainfall: Readonly<Record<string, RainfallSeries>>;
	/** .obs files by upper-cased name. */
	readonly observed: Readonly<Record<string, ObservedFlow>>;
	/** Demand and defined-flow files by upper-cased name. */
	readonly flowFiles: Readonly<Record<string, DemandSeries>>;
	/** `pitman.json`, when present. */
	readonly sidecar?: Sidecar;
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

/**
 * How development is treated over the record (decision D1, issue #3).
 * - presentDay: every year table and demand held at `year` for every year.
 * - natural: irrigation, dams, abstractions, SFR and paved areas removed.
 * - historical: development varies year by year, as the files say.
 */
export type RunMode =
	| { readonly kind: 'presentDay'; readonly year: HydroYear }
	| { readonly kind: 'natural' }
	| { readonly kind: 'historical' };

/** Diagnostic series a runoff module can report (TT 689 §4.5 list). */
export interface RunoffDiagnostics {
	/** Net catchment runoff, million m³/month. */
	readonly netRunoff?: MonthlySeries;
	/** Total surface runoff, million m³/month. */
	readonly surfaceRunoff?: MonthlySeries;
	/** Groundwater outflow (baseflow; plus interflow for Sami), million m³/month. */
	readonly groundwaterOutflow?: MonthlySeries;
	/** Paved-area flows, million m³/month. */
	readonly pavedFlow?: MonthlySeries;
	/** Pitman S, soil moisture storage, mm. */
	readonly soilMoistureMm?: MonthlySeries;
	/** Actual evaporation (interception + soil evaporation), mm/month: the riparian deduction needs it (TT 690 eqs. 12.10–12.12, R6-V10). */
	readonly actualEvaporationMm?: MonthlySeries;
	/** Potential evaporation (PE = FF·S-pan·pan factor), mm/month. */
	readonly potentialEvaporationMm?: MonthlySeries;
	/** Sami aquifer storage, mm. */
	readonly aquiferStorageMm?: MonthlySeries;
	/** Aquifer recharge, mm. */
	readonly rechargeMm?: MonthlySeries;
	/** Sami interflow, million m³/month. */
	readonly interflow?: MonthlySeries;
}

/** A message from a run, the counterpart of WRSM2000.ERR lines. */
export interface RunMessage {
	readonly level: 'info' | 'warning' | 'error';
	readonly module?: ModuleRef;
	readonly route?: number;
	/** Hydrological year and month (0 = October) the message refers to, if any. */
	readonly at?: { readonly year: HydroYear; readonly month: number };
	readonly text: string;
}

/** The result of one run of a network. */
export interface RunResult {
	readonly mode: RunMode;
	readonly startYear: HydroYear;
	readonly endYear: HydroYear;
	/** Simulated flow in every route, million m³/month, keyed by route number. */
	readonly routeFlows: Readonly<Record<number, MonthlySeries>>;
	/** End-of-month storage of every reservoir, million m³, keyed by module number. */
	readonly reservoirStorage: Readonly<Record<number, MonthlySeries>>;
	/** Optional per-runoff-module diagnostics, keyed by module number. */
	readonly runoff?: Readonly<Record<number, RunoffDiagnostics>>;
	/** "Virgin MAR" of each SFR child, million m³/year (as WRSM2000.ERR reports), keyed by module number. */
	readonly virginMarMm3?: Readonly<Record<number, number>>;
	readonly messages: readonly RunMessage[];
}

// ---------------------------------------------------------------------------
// Sidecar (pitman.json): provenance for every user-overridable value
// ---------------------------------------------------------------------------

/** ISO 8601 date (`2025-10-28`) or date-time. */
export type IsoDate = string;

/** Where a value came from (issue #3 rule 8). */
export type ValueSourceKind =
	| 'networkFile' // as read from the WRSM2000 files
	| 'chirps' // CHIRPS rainfall (method A)
	| 'mapGrid' // gridded MAP over a boundary (method B)
	| 'mapCalibration' // gridded MAP scaled by the D2 factor
	| 'capeFarmMapper' // WCDoA Cape Farm Mapper (D3)
	| 'damRegister' // DWS register of dams (D4)
	| 'surfaceWater' // satellite surface water area × 3 m (D4)
	| 'manual'; // typed in by the user

/** A provenance note for one value. */
export interface ValueSource {
	readonly kind: ValueSourceKind;
	/** Free text: dataset version, reference, reason for a manual value. */
	readonly note?: string;
	/** When the data was fetched or the value entered. */
	readonly date?: IsoDate;
	/** Who entered it, for manual values (free text). */
	readonly by?: string;
}

/**
 * The value a provenance note belongs to: a module field, optionally one
 * year of a year table, optionally one month. `field` is the property path
 * in this contract, e.g. `afforestation.areaKm2` or `pitman.ST`.
 */
export interface ValueTarget {
	readonly module?: ModuleRef;
	readonly file?: string;
	readonly field: string;
	readonly year?: HydroYear;
	readonly month?: number;
}

/** A gridded-MAP lookup over a boundary (method B, decision D6). */
export interface MapGridSample {
	/** Grid name, e.g. the national or provincial MAP surface. */
	readonly grid: string;
	/** Grid cell size, m. */
	readonly cellSizeM: number;
	/** Number of cells (or cell fractions summed) inside the boundary. */
	readonly cellCount: number;
	/** Area-weighted mean MAP over the boundary, mm. */
	readonly meanMapMm: number;
	readonly fetchedOn: IsoDate;
}

/** One calendar month's bias factor as recorded in the sidecar (extend.md § Step 8). */
export interface RainfallExtensionFactor {
	/** Calendar month, `'Oct'` … `'Sep'` (entries are October first). */
	readonly month: string;
	/** The factor as computed from the overlap (1 when it couldn't be estimated). */
	readonly computed: number;
	/** The factor applied. Differs from `computed` only when the user edited it. */
	readonly used: number;
	/** Why the factor is what it is, or the user's edit note ('' when nothing to say). */
	readonly note: string;
	/** Present and true when the user edited the factor. */
	readonly edited?: true;
}

/**
 * CHIRPS extension of one rainfall file (method A, decision D5), the
 * `pitman.json` entry of docs/theory/extend.md § Step 8. Round 4 replaced the
 * Round 1 placeholder (one quaternary, two factor arrays) with the spec's shape.
 */
export interface RainfallExtension {
	/** Method version: the algorithm of extend.md as of Round 4. */
	readonly method: 'extend-1';
	/** The .RAN file extended (upper-cased name, as the `Sidecar` key). */
	readonly file: string;
	/** The area CHIRPS was averaged over. */
	readonly area: {
		/** Quaternary codes the area was built from (empty for an uploaded or drawn area). */
		readonly quaternaries: readonly string[];
		readonly areaKm2: number;
		/** CHIRPS cells used, after removing sea / no-data cells. */
		readonly cells: number;
		/** Share of the area's weight removed as sea / no-data cells, %. */
		readonly weightRemovedPct: number;
	};
	readonly chirps: {
		/** Product as the copy names it, e.g. "CHIRPS v3 rnl (final)". */
		readonly product: string;
		/** Which copy answered, e.g. "IC-WBT rain data copy". */
		readonly copy: string;
		/** The copy's manifest revision when fetched (a later revision means values changed). */
		readonly manifestRevision: number;
		/** The copy's last final day, `YYYY-MM-DD`. */
		readonly finalThrough: string;
		/** CHIRPS3 data DOI, for the attribution the licence asks for. */
		readonly doi: string;
		/** When the CHIRPS series was fetched. */
		readonly accessed: IsoDate;
	};
	/** `MAP_c`: mean annual CHIRPS total over its complete hydrological years. Re-applying saved factors uses this value. */
	readonly chirpsMap: { readonly mm: number; readonly years: readonly [HydroYear, HydroYear] };
	/** Overlap the factors were fitted on (D5): `window` says whether the user narrowed it. */
	readonly overlap: { readonly from: HydroYear; readonly to: HydroYear; readonly window: 'default' | 'user' };
	/** The 12 factors, October first. */
	readonly factors: Twelve<RainfallExtensionFactor>;
	/** Hydrological years appended to the file (all CHIRPS-derived). */
	readonly appended: { readonly from: HydroYear; readonly to: HydroYear; readonly rows: number };
	/** Last year of the original record, before extension (WR2012's period ends here). */
	readonly originalEndYear: HydroYear;
	/** The first missing CHIRPS month (0 = October) that stopped the extension, or `null`. */
	readonly stoppedAt: { readonly year: HydroYear; readonly month: number } | null;
	/** When the extension was applied; stamped by the app (the engine doesn't read the clock). */
	readonly createdAt?: IsoDate;
}

/** One iteration of the MAP calibration loop (decision D2). */
export interface MapCalibrationStep {
	readonly iteration: number;
	/** Common factor applied to every piece's gridded MAP. */
	readonly factor: number;
	/** Natural MAR at the quaternary outlet with that factor, million m³/year. */
	readonly naturalMarMm3: number;
	/** (simulated − target) / target × 100, %. */
	readonly errorPercent: number;
}

/** A quaternary sub-division (method B) and its MAP calibration. */
export interface Subdivision {
	readonly quaternary: string;
	readonly method: 'hydrological' | 'mapZone';
	/** The runoff module that was split, before the split. */
	readonly original: ModuleRef;
	readonly pieces: readonly {
		readonly module: ModuleRef;
		readonly areaKm2: number;
		readonly gridMap: MapGridSample;
		/** Final MAP after calibration, mm. */
		readonly mapMm: number;
	}[];
	readonly calibration?: {
		/** WR2012 naturalised MAR for the quaternary, million m³/year (D2a). */
		readonly targetNaturalMarMm3: number;
		readonly targetSource: string;
		/** Years compared: the .RAN period before CHIRPS extension. */
		readonly period: { readonly startYear: HydroYear; readonly endYear: HydroYear };
		readonly tolerancePercent: number;
		readonly iterations: readonly MapCalibrationStep[];
		readonly finalFactor: number;
		readonly converged: boolean;
	};
}

/** One farm dam's 2025 capacity, as gathered for decision D4. */
export interface DamRecord {
	readonly id: string;
	readonly lon: number;
	readonly lat: number;
	/** The runoff module (sub-catchment) the dam lies in. */
	readonly module?: ModuleRef;
	/** Capacity used, million m³. */
	readonly capacityMm3: number;
	/** Surface area at full supply, km², when known. */
	readonly areaKm2?: number;
	/** Where the used capacity came from (precedence register > CFM > area × 3 m unless overridden). */
	readonly source: ValueSource;
	/** The other sources' values for the same dam, kept to show disagreements. */
	readonly alternatives?: readonly { readonly capacityMm3: number; readonly source: ValueSource }[];
}

/**
 * `pitman.json`, saved beside the network files. WRSM2000 ignores it.
 * Holds provenance for every value a user can override (issue #3 rule 8).
 */
export interface Sidecar {
	readonly schema: 'pitman-sidecar';
	readonly schemaVersion: 1;
	/** Pitman version that last wrote the file. */
	readonly writtenBy?: string;
	readonly savedAt?: IsoDate;
	/** CHIRPS extensions, by upper-cased .RAN name. */
	readonly rainfallExtensions?: Readonly<Record<string, RainfallExtension>>;
	readonly subdivisions?: readonly Subdivision[];
	/** Cape Farm Mapper fetch used for irrigation areas and dams (D3). */
	readonly capeFarmMapper?: {
		readonly fetchedOn: IsoDate;
		/** Crop census layer / dataset identifier. */
		readonly dataset?: string;
		/** User-confirmed mapping from CFM crop to irrigation crop description. */
		readonly cropMapping?: Readonly<Record<string, string>>;
	};
	readonly dams?: readonly DamRecord[];
	/** Demand-editor specs, by upper-cased demand file name. */
	readonly demands?: Readonly<Record<string, DemandSpec>>;
	/** Per-value source notes. */
	readonly values?: readonly { readonly target: ValueTarget; readonly source: ValueSource }[];
}
