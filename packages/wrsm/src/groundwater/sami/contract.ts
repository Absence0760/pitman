/**
 * Round 6 contract between the Sami soil side (`soil.ts`, agent 6.1), the
 * aquifer side (`aquifer.ts`, agent 6.2) and the composition in the runoff
 * module runner (`index.ts`, agent 6.5). Transcribed from
 * docs/theory/sami.md § 6, which is authoritative for meanings and
 * equations; written by the orchestrator before the round, and changed here
 * first, by the orchestrator.
 *
 * Depths are mm over the RU's catchment area (the child area for an SFR
 * child); months are indices into the run (0 = October of the first year).
 */

/** Depth over the RU catchment area, mm. */
export type Mm = number;

// ---- soil.ts (agent 6.1) ---------------------------------------------------

export interface SamiSoilParams {
	// L.035 (the Sami calibration set)
	readonly POW: number;
	readonly SL: Mm;
	readonly ST: Mm;
	readonly FT: Mm;
	// L.032
	readonly HGSL: Mm;
	readonly HGGW: Mm;
	readonly GPOW: number;
	readonly PPOW: number;
	readonly P0: Mm;
	// L.031 v5, L.034 v3–v4
	readonly PMAX: Mm;
	/** Moving-average window, months (integer ≥ 1). */
	readonly MMA: number;
	/** F28_Lag, months. */
	readonly lag: number;
}

export interface SamiSoilPass {
	/** Potential recharge RE_i (§3.2). */
	readonly re: readonly Mm[];
	/** Interflow from the soil SIF_i (§3.1). */
	readonly soilInterflow: readonly Mm[];
	/** Moving average REx_i (§3.4). */
	readonly reX: readonly Mm[];
	/** EXRECH_i (§3.5). */
	readonly exrech: readonly Mm[];
	/** PERC_i (§3.5). */
	readonly perc: readonly Mm[];
	/** Percolating storage at month end. */
	readonly p: readonly Mm[];
	/** Pass-1 mean RE (§3.3). */
	readonly reBar: Mm;
	/** Pass-2 mean PERC, for the abstraction ratio (§3.11). */
	readonly percBar: Mm;
}

/** Passes 1–2. Input: Pitman S per month (mm, OQ-S4). */
export type SamiSoilPassFn = (S: readonly Mm[], p: SamiSoilParams) => SamiSoilPass;

/** Interflow assembly and lag: raw_i = soilInterflow_i + excessToInterflow_i; returns QLAG_i (§3.7). */
export type SamiInterflowFn = (soilInterflow: readonly Mm[], excessToInterflow: readonly Mm[], lag: number) => Mm[];

// ---- aquifer.ts (agent 6.2) ------------------------------------------------

export interface SamiAquiferParams {
	/** RU catchment area (L.002 v1; the child area for an SFR child), km²: ET (EVAREA/AREA) and the outflow need it. */
	readonly areaKm2: number;
	/** CAP = thicknessM × storativity × 1000 (mm). */
	readonly thicknessM: number;
	readonly storativity: number;
	readonly store0: Mm;
	readonly SWL: Mm;
	readonly BFMAX: Mm;
	readonly BPOW: number;
	readonly HGRAD: number;
	readonly T_m2d: number;
	readonly evapAreaKm2: number;
	// abstraction
	readonly k2: number;
	readonly k3: number;
	readonly distM: number;
	/** = 100. */
	readonly GWMAX: number;
	// reconstruction constants (OQ-S11), exposed for the comparison harness
	/** 4. */
	readonly outflowWidthFactor: number;
	/** 30. */
	readonly daysPerMonth: number;
}

export interface SamiAquiferState {
	readonly store: Mm;
	readonly tDays: number;
	readonly pumping: boolean;
}

export interface SamiAquiferInput {
	/** PERC_i + EXRECH_i (from soil.ts). */
	readonly aquiferInflow: Mm;
	/** PERC_i (from soil.ts, abstraction ratio). */
	readonly perc: Mm;
	/** From soil.ts. */
	readonly percBar: Mm;
	/** Q_i (Pitman core, OQ-S3). */
	readonly runoffForHead: Mm;
	/**
	 * R6-A10: the runoff TL is taken out of, given the AQX this month's step
	 * spilled (QLAG_i depends on it). TL ≤ max(0, this), so Qfinal ≥ 0: "a
	 * check that transmission losses cannot exceed runoff" (TT 687 p.12–13).
	 * The composition passes Qfinal's pre-loss sum (surface + QLAG in OQ-S3
	 * (a), Q in (b)). Absent = the `runoffForHead` cap only.
	 */
	readonly runoffForLoss?: (excessToInterflow: Mm) => Mm;
	/** RAIN_i. */
	readonly rain: Mm;
	/** E_m × APF_m (OQ-S7). */
	readonly petGw: Mm;
	/** ABS_i, already 0 in natural mode. */
	readonly abstraction: Mm;
}

export interface SamiAquiferOutput {
	/** AQX_i → soil.ts. */
	readonly excessToInterflow: Mm;
	/** AQRECH_i. */
	readonly aquiferRecharge: Mm;
	/** ET_i. */
	readonly et: Mm;
	/** OUT_i (may be < 0). */
	readonly outflow: Mm;
	/** GWBF_net_i (after depletion). */
	readonly baseflow: Mm;
	/** TL_i (≤ runoffForHead, and ≤ runoffForLoss when given, R6-A10). */
	readonly transmissionLoss: Mm;
	readonly depletion: Mm;
	readonly fromStorage: Mm;
	readonly pctFromGw: number;
	/** STORE at month end. */
	readonly store: Mm;
}

export type SamiAquiferInitFn = (p: SamiAquiferParams) => SamiAquiferState;

export type SamiAquiferStepFn = (
	s: SamiAquiferState,
	i: SamiAquiferInput,
	p: SamiAquiferParams
) => { readonly state: SamiAquiferState; readonly out: SamiAquiferOutput };

/** The four functions the composition (`index.ts`, 6.5) calls; injected so 6.5 can test with fakes. */
export interface SamiParts {
	readonly soilPass: SamiSoilPassFn;
	readonly interflow: SamiInterflowFn;
	readonly aquiferInit: SamiAquiferInitFn;
	readonly aquiferStep: SamiAquiferStepFn;
}
